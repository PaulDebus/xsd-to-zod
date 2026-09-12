import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Xsd2ZodError } from "./errors.js";

export const REMOTE_SCHEMA_LOCKFILE = "xsd-to-zod.lock.json";

export type RemoteSchemaLockEntry = {
  sha256: string;
  finalUrl: string;
  fetchedAt: string;
  etag?: string;
};

type RemoteSchemaLockfile = {
  version: 1;
  schemas: Record<string, RemoteSchemaLockEntry>;
};

export type FetchedRemoteSchema = {
  requestedUrl: string;
  finalUrl: string;
  content: Buffer;
  etag?: string;
};

export type CachedRemoteSchema = {
  content: Buffer;
  url: string;
};

export type RemoteSchemaStoreOptions = {
  cwd: string;
  cacheDir?: string;
  frozen?: boolean;
  offline?: boolean;
};

const sha256 = (content: string | Buffer): string =>
  createHash("sha256").update(content).digest("hex");

const defaultCacheDir = (): string => {
  if (process.platform === "win32") {
    return path.join(
      process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local"),
      "xsd-to-zod",
      "schemas",
    );
  }
  return path.join(
    process.env["XDG_CACHE_HOME"] ?? path.join(os.homedir(), ".cache"),
    "xsd-to-zod",
    "schemas",
  );
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const SHA256_RE = /^[a-f0-9]{64}$/;

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
};

const parseLockfile = (text: string, file: string): RemoteSchemaLockfile => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Xsd2ZodError("remote-lockfile-invalid", `Invalid JSON in ${file}`, { file });
  }
  const root = asRecord(parsed);
  const schemas = asRecord(root?.["schemas"]);
  if (root?.["version"] !== 1 || schemas === undefined) {
    throw new Xsd2ZodError(
      "remote-lockfile-invalid",
      `Unsupported remote schema lockfile in ${file}; expected version 1`,
      { file },
    );
  }
  const entries: Record<string, RemoteSchemaLockEntry> = {};
  for (const [url, value] of Object.entries(schemas)) {
    const entry = asRecord(value);
    if (
      !isHttpUrl(url) ||
      typeof entry?.["sha256"] !== "string" ||
      typeof entry["finalUrl"] !== "string" ||
      typeof entry["fetchedAt"] !== "string" ||
      (entry["etag"] !== undefined && typeof entry["etag"] !== "string") ||
      !SHA256_RE.test(entry["sha256"] as string) ||
      !isHttpUrl(entry["finalUrl"] as string) ||
      Number.isNaN(Date.parse(entry["fetchedAt"] as string))
    ) {
      throw new Xsd2ZodError(
        "remote-lockfile-invalid",
        `Invalid remote schema lockfile entry for "${url}"`,
        { file },
      );
    }
    entries[url] = {
      sha256: entry["sha256"],
      finalUrl: entry["finalUrl"],
      fetchedAt: entry["fetchedAt"],
      ...(typeof entry["etag"] === "string" && { etag: entry["etag"] }),
    };
  }
  return { version: 1, schemas: entries };
};

const renameReplacing = async (temp: string, target: string): Promise<void> => {
  try {
    await rename(temp, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") {
      throw error;
    }
    await rm(target, { force: true });
    await rename(temp, target);
  }
};

export class RemoteSchemaStore {
  readonly lockfilePath: string;
  readonly #cacheDir: string;
  readonly #frozen: boolean;
  readonly #offline: boolean;
  readonly #staged = new Map<string, FetchedRemoteSchema>();
  #lockfile: RemoteSchemaLockfile;

  private constructor(
    lockfile: RemoteSchemaLockfile,
    {
      cwd,
      cacheDir = defaultCacheDir(),
      frozen = false,
      offline = false,
    }: RemoteSchemaStoreOptions,
  ) {
    this.#lockfile = lockfile;
    this.lockfilePath = path.join(cwd, REMOTE_SCHEMA_LOCKFILE);
    this.#cacheDir = cacheDir;
    this.#frozen = frozen;
    this.#offline = offline;
  }

  static async open(options: RemoteSchemaStoreOptions): Promise<RemoteSchemaStore> {
    const lockfilePath = path.join(options.cwd, REMOTE_SCHEMA_LOCKFILE);
    let text: string;
    try {
      text = await readFile(lockfilePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      if (options.frozen === true || options.offline === true) {
        const mode = options.frozen === true ? "--frozen" : "--offline";
        throw new Xsd2ZodError(
          "remote-lockfile-missing",
          `${mode} requires ${REMOTE_SCHEMA_LOCKFILE} in ${options.cwd}`,
          { file: lockfilePath },
        );
      }
      return new RemoteSchemaStore({ version: 1, schemas: {} }, options);
    }
    return new RemoteSchemaStore(parseLockfile(text, lockfilePath), options);
  }

  #findEntry(url: string): RemoteSchemaLockEntry | undefined {
    return this.#lockfile.schemas[url];
  }

  #cachePath(hash: string): string {
    return path.join(this.#cacheDir, `${hash}.xsd`);
  }

  async read(url: string): Promise<CachedRemoteSchema | undefined> {
    const entry = this.#findEntry(url);
    if (entry === undefined) {
      if (this.#frozen) {
        throw new Xsd2ZodError(
          "remote-lock-missing",
          `No remote schema lockfile entry for "${url}"`,
          { file: this.lockfilePath },
        );
      }
      if (this.#offline) {
        throw new Xsd2ZodError(
          "remote-cache-miss",
          `Remote schema "${url}" is not present in the local cache`,
        );
      }
      return undefined;
    }

    let content: Buffer;
    try {
      content = await readFile(this.#cachePath(entry.sha256));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (this.#offline) {
          throw new Xsd2ZodError(
            "remote-cache-miss",
            `Remote schema "${url}" is not present in the local cache`,
          );
        }
        return undefined;
      }
      throw error;
    }
    if (sha256(content) !== entry.sha256) {
      throw new Xsd2ZodError(
        "remote-integrity",
        `Cached remote schema "${entry.finalUrl}" does not match ${REMOTE_SCHEMA_LOCKFILE}`,
        { file: this.lockfilePath },
      );
    }
    return { content, url: entry.finalUrl };
  }

  stage(fetched: FetchedRemoteSchema): void {
    const digest = sha256(fetched.content);
    if (this.#frozen) {
      const entry = this.#findEntry(fetched.requestedUrl);
      if (entry === undefined) {
        throw new Xsd2ZodError(
          "remote-lock-missing",
          `No remote schema lockfile entry for "${fetched.requestedUrl}"`,
          { file: this.lockfilePath },
        );
      }
      if (entry.finalUrl !== fetched.finalUrl) {
        throw new Xsd2ZodError(
          "remote-final-url-mismatch",
          `Remote schema "${fetched.requestedUrl}" redirected to "${fetched.finalUrl}", but the lockfile pins "${entry.finalUrl}"`,
          { file: this.lockfilePath },
        );
      }
      if (entry.sha256 !== digest) {
        throw new Xsd2ZodError(
          "remote-integrity",
          `Fetched remote schema "${fetched.finalUrl}" does not match ${REMOTE_SCHEMA_LOCKFILE}`,
          { file: this.lockfilePath },
        );
      }
      return;
    }
    this.#staged.set(fetched.requestedUrl, fetched);
  }

  async commit(): Promise<number> {
    if (this.#frozen || this.#staged.size === 0) {
      return 0;
    }
    const staged = [...this.#staged.values()];
    const fetchedAt = new Date().toISOString();
    const uniqueContent = new Map<string, Buffer>();
    for (const item of staged) {
      uniqueContent.set(sha256(item.content), item.content);
    }

    await mkdir(this.#cacheDir, { recursive: true });
    const pending: { temp: string; target: string }[] = [];
    try {
      for (const [digest, content] of uniqueContent) {
        const target = this.#cachePath(digest);
        const temp = `${target}.${randomUUID()}.tmp`;
        await writeFile(temp, content);
        pending.push({ temp, target });
      }
      for (const { temp, target } of pending) {
        await renameReplacing(temp, target);
      }
    } catch (error) {
      await Promise.all(pending.map(({ temp }) => rm(temp, { force: true })));
      throw error;
    }

    const schemas: Record<string, RemoteSchemaLockEntry> = { ...this.#lockfile.schemas };
    for (const item of staged) {
      schemas[item.requestedUrl] = {
        sha256: sha256(item.content),
        finalUrl: item.finalUrl,
        fetchedAt,
        ...(item.etag !== undefined && { etag: item.etag }),
      };
    }
    const sorted = Object.fromEntries(
      Object.entries(schemas).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
    const next: RemoteSchemaLockfile = { version: 1, schemas: sorted };
    const tempLockfile = `${this.lockfilePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempLockfile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await renameReplacing(tempLockfile, this.lockfilePath);
    } catch (error) {
      await rm(tempLockfile, { force: true });
      throw error;
    }
    this.#lockfile = next;
    this.#staged.clear();
    return staged.length;
  }
}
