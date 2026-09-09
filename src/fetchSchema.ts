import { Buffer } from "node:buffer";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { Xsd2ZodError } from "./errors.js";
import type { ResolvedSchema, SchemaResolutionBase } from "./parseXsd.js";
import { decodeXmlContent } from "./readXmlFile.js";

const MAX_FILES = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;

export type FetchSchemaResolverOptions = {
  /** Permit plain http:// URLs. */
  allowHttp?: boolean;
  /** Exact host or host:port allowlist. */
  allowedHosts?: string[];
  /** Remote entry-point URLs. With fetchTransitive=false, only these are fetched. */
  entryUrls?: string[];
  /** Resolve imports/includes reachable from remote schemas. */
  fetchTransitive?: boolean;
  onFetch?: (url: string, base: SchemaResolutionBase) => void;
  onRedirect?: (fromUrl: string, toUrl: string) => void;
  /** Test hook for exercising transport failures without external network access. */
  fetchImplementation?: FetchImplementation;
};

type FetchResponse = Awaited<ReturnType<typeof undiciFetch>>;
type FetchImplementation = (
  input: URL,
  init: {
    dispatcher: EnvHttpProxyAgent;
    redirect: "manual";
    credentials: "omit";
    signal: AbortSignal;
  },
) => Promise<FetchResponse>;

const errorCode = (error: unknown): string | undefined => {
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (current && typeof current === "object" && "code" in current) {
      return String(current.code);
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
};

const errorName = (error: unknown): string | undefined => {
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (current instanceof Error) {
      if (current.name === "TimeoutError" || current.name === "AbortError") {
        return current.name;
      }
      current = current.cause;
    } else {
      return undefined;
    }
  }
  return undefined;
};

const fetchError = (url: string, error: unknown): Xsd2ZodError => {
  const code = errorCode(error);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new Xsd2ZodError("remote-dns", `DNS lookup failed for remote schema "${url}": ${code}`);
  }
  if (errorName(error) !== undefined) {
    return new Xsd2ZodError(
      "remote-timeout",
      `Timed out fetching remote schema "${url}" after ${FETCH_TIMEOUT_MS}ms`,
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new Xsd2ZodError("remote-fetch", `Failed to fetch remote schema "${url}": ${detail}`);
};

const assertFetchable = (url: URL, allowHttp: boolean, allowedHosts: ReadonlySet<string>): void => {
  if (url.username || url.password) {
    throw new Xsd2ZodError(
      "remote-credentials-not-allowed",
      `Remote schema URL "${url.origin}${url.pathname}" must not contain credentials`,
    );
  }
  if (url.protocol === "http:" && !allowHttp) {
    throw new Xsd2ZodError(
      "remote-http-not-allowed",
      `Refusing insecure http schema "${url.href}"; pass --allow-http to permit it`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Xsd2ZodError(
      "remote-scheme-not-allowed",
      `Remote schema URL "${url.href}" uses unsupported scheme "${url.protocol}"`,
    );
  }
  if (allowedHosts.size > 0) {
    const host = url.hostname.toLowerCase();
    const hostWithPort = url.host.toLowerCase();
    if (!allowedHosts.has(host) && !allowedHosts.has(hostWithPort)) {
      throw new Xsd2ZodError(
        "remote-host-not-allowed",
        `Remote schema host "${url.host}" is not allowed by --allow-host`,
      );
    }
  }
};

const readResponseBody = async (response: FetchResponse, url: URL): Promise<Buffer> => {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_FILE_BYTES) {
    throw new Xsd2ZodError(
      "remote-file-too-large",
      `Remote schema "${url.href}" exceeds the ${MAX_FILE_BYTES}-byte file limit`,
    );
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > MAX_FILE_BYTES) {
        throw new Xsd2ZodError(
          "remote-file-too-large",
          `Remote schema "${url.href}" exceeds the ${MAX_FILE_BYTES}-byte file limit`,
        );
      }
      chunks.push(chunk);
    }
    reader.releaseLock();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks, size);
};

export const createFetchSchemaResolver = ({
  allowHttp = false,
  allowedHosts = [],
  entryUrls = [],
  fetchTransitive = true,
  onFetch,
  onRedirect,
  fetchImplementation = undiciFetch,
}: FetchSchemaResolverOptions) => {
  const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
  const entries = new Set(entryUrls.map((url) => new URL(url).href));
  const dispatcher = new EnvHttpProxyAgent();
  const cache = new Map<string, Promise<ResolvedSchema>>();
  const depthByUrl = new Map([...entries].map((url) => [url, 0]));
  let fileCount = 0;
  let totalBytes = 0;

  const fetchSchema = async (
    url: URL,
    depth: number,
    base: SchemaResolutionBase,
  ): Promise<ResolvedSchema> => {
    fileCount++;
    if (fileCount > MAX_FILES) {
      throw new Xsd2ZodError(
        "remote-file-limit",
        `Remote schema graph exceeds the ${MAX_FILES}-file limit`,
      );
    }

    let currentUrl = url;
    for (let redirects = 0; ; redirects++) {
      onFetch?.(currentUrl.href, base);
      const response = await fetchImplementation(currentUrl, {
        dispatcher,
        redirect: "manual",
        credentials: "omit",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects >= MAX_REDIRECTS) {
          throw new Xsd2ZodError(
            "remote-redirect-limit",
            `Remote schema "${url.href}" exceeds the ${MAX_REDIRECTS}-redirect limit`,
          );
        }
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) {
          throw new Xsd2ZodError(
            "remote-redirect-invalid",
            `Remote schema "${currentUrl.href}" redirected without a Location header`,
          );
        }
        let redirectUrl: URL;
        try {
          redirectUrl = new URL(location, currentUrl);
        } catch {
          throw new Xsd2ZodError(
            "remote-redirect-invalid",
            `Remote schema "${currentUrl.href}" returned invalid redirect location "${location}"`,
          );
        }
        assertFetchable(redirectUrl, allowHttp, allowed);
        if (redirectUrl.origin !== currentUrl.origin) {
          onRedirect?.(currentUrl.href, redirectUrl.href);
        }
        currentUrl = redirectUrl;
        continue;
      }

      if (response.status === 404) {
        throw new Xsd2ZodError(
          "remote-not-found",
          `Remote schema not found (404): "${currentUrl.href}"`,
        );
      }
      if (!response.ok) {
        throw new Xsd2ZodError(
          "remote-http-status",
          `Remote schema request failed with HTTP ${response.status}: "${currentUrl.href}"`,
        );
      }
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType === "text/html") {
        throw new Xsd2ZodError(
          "remote-content-type",
          `Expected XSD from "${currentUrl.href}", got ${contentType}`,
        );
      }
      const body = await readResponseBody(response, currentUrl);
      totalBytes += body.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Xsd2ZodError(
          "remote-total-too-large",
          `Remote schema graph exceeds the ${MAX_TOTAL_BYTES}-byte total limit`,
        );
      }
      depthByUrl.set(currentUrl.href, depth);
      return { content: decodeXmlContent(body), url: currentUrl.href };
    }
  };

  return async (
    location: string,
    base: SchemaResolutionBase,
  ): Promise<ResolvedSchema | undefined> => {
    if (base.kind === "file" && !/^https?:/i.test(location)) {
      return undefined;
    }

    let url: URL;
    try {
      url = base.kind === "url" ? new URL(location, base.url) : new URL(location);
    } catch {
      throw new Xsd2ZodError("remote-url-invalid", `Invalid remote schema location "${location}"`);
    }
    assertFetchable(url, allowHttp, allowed);

    const isEntry = entries.has(url.href);
    if (!fetchTransitive && !isEntry) {
      return undefined;
    }
    const depth = isEntry ? 0 : (depthByUrl.get(base.kind === "url" ? base.url : "") ?? 0) + 1;
    if (depth > MAX_DEPTH) {
      throw new Xsd2ZodError(
        "remote-depth-limit",
        `Remote schema graph exceeds the ${MAX_DEPTH}-level import depth limit`,
      );
    }

    const cached = cache.get(url.href);
    if (cached) {
      return cached;
    }
    const fetched = fetchSchema(url, depth, base).catch((error: unknown) => {
      throw error instanceof Xsd2ZodError ? error : fetchError(url.href, error);
    });
    cache.set(url.href, fetched);
    fetched.then(
      (resolved) => {
        cache.set(resolved.url, Promise.resolve(resolved));
      },
      () => undefined,
    );
    return fetched;
  };
};
