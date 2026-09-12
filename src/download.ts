import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Xsd2ZodError } from "./errors.js";
import { createFetchSchemaResolver } from "./fetchSchema.js";
import type { ResolvedSchema, SchemaResolutionBase } from "./parseXsd.js";
import { parseXsd } from "./parseXsd.js";
import { readXmlFile } from "./readXmlFile.js";
import type { RemoteSchemaStore } from "./remoteSchemaStore.js";
import type { Diagnostic } from "./types.js";

export type DownloadSchemaOptions = {
  /** Directory the schema closure is vendored into. */
  outDir: string;
  /** Permit plain http:// URLs. */
  allowHttp?: boolean;
  /** Exact host or host:port allowlist. */
  allowedHosts?: string[];
  /** Resolve remote schemas from the local cache without network access. */
  offline?: boolean;
  /** Lockfile/cache store used for persisted resolution and integrity checks. */
  store?: RemoteSchemaStore;
  onFetch?: (url: string, base: SchemaResolutionBase) => void;
  onRedirect?: (fromUrl: string, toUrl: string) => void;
};

export type DownloadedSchemaClosure = {
  /** Entry schema path relative to outDir (posix separators). */
  entry: string;
  /** All vendored schema paths relative to outDir (posix separators), entry first. */
  files: string[];
  /** Diagnostics collected while walking the closure. */
  diagnostics: Diagnostic[];
  /**
   * Raw schemaLocations that could not be resolved and were left as-is in the
   * vendored files, so callers can tell a partial closure from a complete one.
   */
  unresolved: string[];
  /** Number of remote schemas recorded in the lockfile by the store commit. */
  recorded: number;
};

const REMOTE_ENTRY_RE = /^https?:\/\//i;
const REMOTE_LOCATION_RE = /^https?:/i;

const hash8 = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 8);

// Device names Windows refuses as file or directory names.
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const sanitizeSegment = (segment: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  let cleaned = decoded.replace(/[^\p{L}\p{N}._~-]/gu, "_");
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    cleaned = "_";
  }
  if (WINDOWS_DEVICE_RE.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }
  return cleaned;
};

const suffixFileName = (rel: string, salt: string): string => {
  const slash = rel.lastIndexOf("/");
  const dir = slash >= 0 ? rel.slice(0, slash + 1) : "";
  const name = slash >= 0 ? rel.slice(slash + 1) : rel;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${dir}${stem}-${hash8(salt)}${ext}`;
};

// Remote schemas are laid out by host and URL path so same-named schemas from
// different hosts or directories cannot collide.
const remoteRelPath = (url: URL): string => {
  const segments = url.pathname.split("/").filter(Boolean).map(sanitizeSegment);
  let fileName = segments.pop() ?? "schema.xsd";
  if (url.search) {
    fileName = suffixFileName(fileName, url.search);
  }
  return [sanitizeSegment(url.host.toLowerCase()), ...segments, fileName].join("/");
};

// Matches an xs:import/include/redefine tag with any namespace prefix,
// tolerating quoted attribute values that contain ">".
const IMPORT_TAG_RE =
  /<(?:[A-Za-z_][\w.-]*:)?(?:import|include|redefine)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const LOCATION_ATTR_RE = /(\bschemaLocation\s*=\s*)("([^"]*)"|'([^']*)')/;

const xmlUnescape = (value: string): string =>
  value.replace(/&(#x?[0-9a-fA-F]+|lt|gt|quot|apos|amp);/g, (entity, body: string) => {
    switch (body) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      case "amp":
        return "&";
      default:
        break;
    }
    const codePoint = body.startsWith("#x")
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    return Number.isNaN(codePoint) ? entity : String.fromCodePoint(codePoint);
  });

const xmlEscapeAttr = (value: string, quote: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(quote === '"' ? /"/g : /'/g, quote === '"' ? "&quot;" : "&apos;");

export const downloadSchemaClosure = async (
  entry: string,
  {
    outDir,
    allowHttp = false,
    allowedHosts = [],
    offline = false,
    store,
    onFetch,
    onRedirect,
  }: DownloadSchemaOptions,
): Promise<DownloadedSchemaClosure> => {
  const remoteEntry = REMOTE_ENTRY_RE.test(entry);
  if (remoteEntry) {
    try {
      new URL(entry);
    } catch {
      throw new Xsd2ZodError("remote-url-invalid", `Invalid remote schema URL "${entry}"`);
    }
  }
  const entryLocation = remoteEntry ? entry : path.resolve(entry);
  const entryDir = remoteEntry ? undefined : path.dirname(entryLocation);

  // The closure walk is driven by parseXsd so local and remote traversal share
  // exactly one implementation. The resolver below only records the documents
  // and edges it is asked about; fetching stays behind the same policy-checked
  // resolver the generate command uses.
  const docs = new Map<string, string>();
  const edges = new Map<string, Map<string, string>>();
  let entryDocKey: string | undefined;

  const trackResolvedDocument = (
    base: SchemaResolutionBase,
    location: string,
    resolved: ResolvedSchema,
  ): void => {
    docs.set(resolved.url, resolved.content);
    const container = base.kind === "url" ? base.url : base.path;
    let edgeMap = edges.get(container);
    if (edgeMap === undefined) {
      edgeMap = new Map();
      edges.set(container, edgeMap);
    }
    edgeMap.set(location, resolved.url);
    if (location === entryLocation && entryDocKey === undefined) {
      entryDocKey = resolved.url;
    }
  };

  const fetchResolver = createFetchSchemaResolver({
    allowHttp,
    allowedHosts,
    entryUrls: remoteEntry ? [entry] : [],
    fetchTransitive: true,
    fetchRemoteFromLocal: true,
    offline,
    refresh: true,
    ...(store !== undefined && { store }),
    ...(onFetch !== undefined && { onFetch }),
    ...(onRedirect !== undefined && { onRedirect }),
  });

  const resolve = async (
    location: string,
    base: SchemaResolutionBase,
  ): Promise<ResolvedSchema | undefined> => {
    if (base.kind === "file" && !REMOTE_LOCATION_RE.test(location)) {
      const filePath = path.resolve(path.dirname(base.path), location);
      try {
        const resolved = { content: readXmlFile(filePath), url: filePath };
        trackResolvedDocument(base, location, resolved);
        return resolved;
      } catch {
        return undefined;
      }
    }
    const resolved = await fetchResolver.resolve(location, base);
    if (resolved !== undefined) {
      trackResolvedDocument(base, location, resolved);
    }
    return resolved;
  };

  const ir = await parseXsd([entry], { resolveSchema: resolve });
  if (entryDocKey === undefined) {
    throw new Xsd2ZodError("unresolved-entry", `Unable to resolve schema "${entry}"`, {
      file: entry,
    });
  }

  // Local documents keep their layout relative to the entry file so unchanged
  // relative schemaLocations keep working; anything outside the entry tree is
  // flattened under _external/.
  const localRelPath = (absPath: string): string => {
    if (entryDir !== undefined) {
      const rel = path.relative(entryDir, absPath);
      if (rel === "") {
        return sanitizeSegment(path.basename(absPath));
      }
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
        return rel.split(path.sep).map(sanitizeSegment).join("/");
      }
    }
    return `_external/${hash8(absPath)}-${sanitizeSegment(path.basename(absPath))}`;
  };

  const relPathFor = (key: string): string =>
    REMOTE_LOCATION_RE.test(key) ? remoteRelPath(new URL(key)) : localRelPath(key);

  const orderedKeys = [
    entryDocKey,
    ...[...docs.keys()].filter((key) => key !== entryDocKey).sort(),
  ];
  const relByKey = new Map<string, string>();
  const taken = new Map<string, string>();
  for (const key of orderedKeys) {
    let rel = relPathFor(key);
    const owner = taken.get(rel);
    if (owner !== undefined && owner !== key) {
      rel = suffixFileName(rel, key);
      const saltedOwner = taken.get(rel);
      if (saltedOwner !== undefined && saltedOwner !== key) {
        throw new Xsd2ZodError(
          "download-path-collision",
          `Cannot vendor "${key}": derived path "${rel}" is already taken`,
        );
      }
    }
    taken.set(rel, key);
    relByKey.set(key, rel);
  }

  const outRoot = path.resolve(outDir);
  const rewriteContent = (content: string, docKey: string, docRel: string): string => {
    const edgeMap = edges.get(docKey);
    if (edgeMap === undefined) {
      return content;
    }
    return content.replace(IMPORT_TAG_RE, (tag) =>
      tag.replace(
        LOCATION_ATTR_RE,
        (
          attr: string,
          prefix: string,
          _quoted: string,
          doubleVal: string | undefined,
          singleVal: string | undefined,
        ): string => {
          const raw = xmlUnescape(doubleVal ?? singleVal ?? "");
          const targetKey = edgeMap.get(raw);
          const targetRel = targetKey === undefined ? undefined : relByKey.get(targetKey);
          if (targetRel === undefined) {
            return attr;
          }
          const next = path.posix.relative(path.posix.dirname(docRel), targetRel);
          if (next === raw) {
            return attr;
          }
          const quote = doubleVal === undefined ? "'" : '"';
          return `${prefix}${quote}${xmlEscapeAttr(next, quote)}${quote}`;
        },
      ),
    );
  };

  const files: string[] = [];
  for (const [key, rel] of relByKey) {
    const target = path.resolve(outRoot, ...rel.split("/"));
    if (target !== outRoot && !target.startsWith(outRoot + path.sep)) {
      throw new Xsd2ZodError(
        "download-path-unsafe",
        `Refusing to write outside the output directory: "${rel}"`,
      );
    }
    const content = docs.get(key);
    if (content === undefined) {
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, rewriteContent(content, key, rel), "utf8");
    files.push(rel);
  }

  const recorded = (await store?.commit()) ?? 0;
  const unresolved = [
    ...new Set(
      ir.diagnostics
        .filter(
          (diagnostic) =>
            diagnostic.kind === "remote-schema-location" || diagnostic.kind === "unresolved-import",
        )
        .map((diagnostic) => diagnostic.ref ?? diagnostic.message),
    ),
  ].sort();
  return {
    entry: relByKey.get(entryDocKey) ?? entryLocation,
    files,
    diagnostics: ir.diagnostics,
    unresolved,
    recorded,
  };
};
