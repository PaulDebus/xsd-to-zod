#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { z } from "zod";
import { downloadSchemaClosure } from "./download.js";
import { Xsd2ZodError } from "./errors.js";
import { createFetchSchemaResolver, describeSchemaBase } from "./fetchSchema.js";
import { irToZod, unenforcedConstructsMessages } from "./irToZod.js";
import { parseXsd } from "./parseXsd.js";
import { RemoteSchemaStore } from "./remoteSchemaStore.js";
import type { XsdIr } from "./types.js";

const errorMessage = (e: unknown): string => {
  if (e instanceof Xsd2ZodError) {
    const location = e.file ? `${e.file}: ` : "";
    return `${location}${e.message} [${e.code}]`;
  }
  return e instanceof Error ? e.message : String(e);
};

import { runPostGenerationFormatting } from "./postProcess.js";
import { readXmlFile } from "./readXmlFile.js";
import { decodeXmlEntities, safeParseXml } from "./runtime.js";
import { PACKAGE_VERSION } from "./version.js";
import { xmlRegistry } from "./xmlMeta.js";

const reportWarnings = (warnings: string[]): void => {
  for (const warning of warnings) {
    console.error(`warning: ${warning}`);
  }
};

// Constructs the schema uses that the zod tier drops (identity constraints)
// or only partially preserves (mixed-content interleaving): name them when
// the user can still act — the libxml2 tier enforces them. Correctness-relevant,
// so shown even with --silent like the other warnings.
const warnUnenforcedConstructs = (ir: XsdIr): void => {
  for (const message of unenforcedConstructsMessages(ir).cli) {
    console.error(`warning: ${message}`);
  }
};

const warnDiagnostics = (ir: XsdIr, suggestFetch = false): void => {
  for (const diagnostic of ir.diagnostics) {
    const hint =
      suggestFetch && diagnostic.kind === "remote-schema-location"
        ? "; re-run with --fetch to resolve it"
        : "";
    console.error(`warning: [${diagnostic.kind}] ${diagnostic.message}${hint}`);
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isZodSchema = (value: unknown): value is z.ZodType =>
  value !== null && typeof value === "object" && "_zod" in value;

const importGeneratedModule = async (schemasCode: string): Promise<Record<string, unknown>> => {
  const dir = mkdtempSync(join(tmpdir(), "xsd-to-zod-cli-"));
  try {
    const file = join(dir, "generated.mjs");
    // Resolve generated imports from the installed CLI, not from the OS temp
    // directory, so validation also works with isolated and read-only installs.
    const resolved = schemasCode.replace(
      /^(import\s+[^\n]+?\s+from\s+)(["'])(zod|xsd-to-zod)\2/gm,
      (_line, start: string, _quote: string, source: string) =>
        `${start}${JSON.stringify(import.meta.resolve(source))}`,
    );
    writeFileSync(file, resolved, "utf8");
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const asHttpUrl = (input: string): URL | undefined => {
  if (!/^https?:\/\//i.test(input)) {
    return undefined;
  }
  try {
    return new URL(input);
  } catch {
    throw new Xsd2ZodError("remote-url-invalid", `Invalid remote schema URL "${input}"`);
  }
};

const decodeUrlPathSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const inputStem = (input: string | undefined): string | undefined => {
  if (input === undefined) {
    return undefined;
  }
  const url = asHttpUrl(input);
  const rawName = url
    ? url.pathname.split("/").filter(Boolean).pop()
    : input
        .replace(/\.xsd$/i, "")
        .split(/[\\/]/)
        .filter(Boolean)
        .pop();
  if (rawName === undefined) {
    return undefined;
  }
  const decodedName = url ? decodeUrlPathSegment(rawName) : rawName;
  return decodedName.replace(/\.xsd$/i, "");
};

export const expandDirectories = (files: string[], visitedDirs = new Set<string>()): string[] => {
  const expanded: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) {
      expanded.push(file);
      continue;
    }
    if (statSync(file).isDirectory()) {
      const real = realpathSync(file);
      if (!visitedDirs.has(real)) {
        visitedDirs.add(real);
        for (const entry of readdirSync(file)) {
          expanded.push(...expandDirectories([join(file, entry)], visitedDirs));
        }
      }
    } else if (extname(file) === ".xsd") {
      expanded.push(file);
    }
  }
  return expanded.sort();
};

const XML_NON_MARKUP_SOURCE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g;

const maskXmlNonMarkup = (content: string): string =>
  content.replace(XML_NON_MARKUP_SOURCE, (part) => " ".repeat(part.length));

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const XML_ATTRIBUTE_RE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const parseAttributes = (source: string): Map<string, string> => {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(XML_ATTRIBUTE_RE)) {
    const name = match[1];
    if (name !== undefined) {
      attributes.set(name, decodeXmlEntities(match[2] ?? match[3] ?? ""));
    }
  }
  return attributes;
};

const SCHEMA_ROOT_RE = /<([A-Za-z_][\w.-]*:)?schema\b((?:[^>"']|"[^"]*"|'[^']*')*)>/;

const DEPENDENCY_RE =
  /<([A-Za-z_][\w.-]*:)?(import|include|redefine)\b((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g;

type SchemaReferenceKind = "import" | "include" | "redefine";

type SchemaReference = {
  kind: SchemaReferenceKind;
  namespace: string | undefined;
  schemaLocation: string | undefined;
  tagName: string;
};

const schemaReferences = (content: string): SchemaReference[] => {
  const references: SchemaReference[] = [];
  for (const match of maskXmlNonMarkup(content).matchAll(DEPENDENCY_RE)) {
    const kind = match[2];
    if (kind !== "import" && kind !== "include" && kind !== "redefine") {
      continue;
    }
    const attributes = parseAttributes(match[3] ?? "");
    references.push({
      kind,
      namespace: attributes.get("namespace"),
      schemaLocation: attributes.get("schemaLocation"),
      tagName: `${match[1] ?? ""}${kind}`,
    });
  }
  return references;
};

type SchemaDocument = {
  file: string;
  content: string;
  prefix: string;
  rootName: string;
  rootTag: string;
  selfClosing: boolean;
  body: string;
  targetNamespace: string;
  elementFormDefault: string;
  attributeFormDefault: string;
  blockDefault: string;
  finalDefault: string;
  xmlns: Map<string, string>;
};

const parseSchemaDocument = (file: string, content: string): SchemaDocument => {
  const masked = maskXmlNonMarkup(content);
  const root = SCHEMA_ROOT_RE.exec(masked);
  if (!root || root.index === undefined) {
    throw new Error(`not an XSD schema: ${file}`);
  }
  const prefix = root[1] ?? "";
  const rootName = `${prefix}schema`;
  const rootTag = content.slice(root.index, root.index + root[0].length);
  const selfClosing = /\/\s*>$/.test(rootTag);
  const bodyStart = root.index + root[0].length;
  let body = "";
  if (!selfClosing) {
    const close = new RegExp(`</${escapeRegExp(rootName)}\\s*>`);
    const closeIndex = masked.slice(bodyStart).search(close);
    if (closeIndex === -1) {
      throw new Error(`missing closing </${rootName}> in ${file}`);
    }
    body = content.slice(bodyStart, bodyStart + closeIndex);
  }
  const attributes = parseAttributes(root[2] ?? "");
  const xmlns = new Map<string, string>();
  for (const [name, value] of attributes) {
    if (name === "xmlns") {
      xmlns.set("", value);
    } else if (name.startsWith("xmlns:")) {
      xmlns.set(name.slice("xmlns:".length), value);
    }
  }
  return {
    file,
    content,
    prefix,
    rootName,
    rootTag,
    selfClosing,
    body,
    targetNamespace: attributes.get("targetNamespace") ?? "",
    elementFormDefault: attributes.get("elementFormDefault") ?? "unqualified",
    attributeFormDefault: attributes.get("attributeFormDefault") ?? "unqualified",
    blockDefault: attributes.get("blockDefault") ?? "",
    finalDefault: attributes.get("finalDefault") ?? "",
    xmlns,
  };
};

export const discoverDependencies = (entryFile: string, visited = new Set<string>()): string[] => {
  const resolved = resolve(entryFile);
  if (visited.has(resolved)) {
    return [];
  }
  visited.add(resolved);

  const content = readXmlFile(resolved);
  const files: string[] = [resolved];

  for (const reference of schemaReferences(content)) {
    const location = reference.schemaLocation;
    if (location === undefined || location === "") {
      continue;
    }
    const depPath = resolve(dirname(resolved), location);
    if (existsSync(depPath)) {
      files.push(...discoverDependencies(depPath, visited));
    }
  }

  return files;
};

export const stripImports = (xsd: string): string => {
  const masked = maskXmlNonMarkup(xsd);
  const paired =
    /<([A-Za-z_][\w.-]*:)?(import|include|redefine)\b(?:[^>"']|"[^"]*"|'[^']*')*(?<!\/)>[\s\S]*?<\/\1\2\s*>/g;
  const ranges = [...masked.matchAll(paired), ...masked.matchAll(DEPENDENCY_RE)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const parts: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) {
      continue;
    }
    parts.push(xsd.slice(cursor, range.start));
    cursor = range.end;
  }
  parts.push(xsd.slice(cursor));
  return parts.join("");
};

// Per-file library detection: returns true for type-definition-only schemas
// (those without root elements).  Uses a raw text heuristic instead of a full
// parseXsd per file to avoid O(n) full parses.  False positives (e.g. an
// <xs:element> nested inside a complexType that starts at depth 1) are
// harmless — the batch parse will produce the real IR.  On any read error or
// ambiguous parse the file is kept (return false) so the batch parse surfaces
// the real error instead of silently dropping it.
export const isLibrary = (filePath: string): boolean => {
  try {
    const content = readFileSync(filePath, "utf8");
    const schemaMatch = content.match(/<((?:\w+:)?schema)\b/);
    if (!schemaMatch) {
      return false;
    }
    const fullTag = schemaMatch[1];
    if (!fullTag) {
      return false;
    }
    const prefix = fullTag.replace(/schema$/, "");
    if (!content.includes(`</${prefix}schema>`)) {
      return false;
    }
    const start = (schemaMatch.index ?? 0) + schemaMatch[0].length;
    let depth = 1;
    for (const m of content.slice(start).matchAll(/<\/?(?:\w+:)?(\w+)[^>]*\/?>/g)) {
      const tag = m[0];
      if (tag.startsWith("</")) {
        if (--depth === 0) {
          break;
        }
      } else {
        if (depth === 1 && m[1] === "element") {
          return false;
        }
        if (!tag.endsWith("/>")) {
          depth++;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Bundle planning
// ---------------------------------------------------------------------------

const BUNDLE_DOWNLOAD_HINT =
  'a single bundled XSD cannot express this; use "xsd-to-zod download" to vendor the schema closure instead';

function failBundle(message: string): never {
  throw new Error(`${message}; ${BUNDLE_DOWNLOAD_HINT}`);
}

const escapeXmlAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const normalizeSchemaRootTag = (rootTag: string, additions: string[]): string => {
  const selfClosing = /\/\s*>$/.test(rootTag);
  const end = selfClosing ? rootTag.lastIndexOf("/>") : rootTag.lastIndexOf(">");
  const head = rootTag.slice(0, end).trimEnd();
  const attributes = additions.length > 0 ? ` ${additions.join(" ")}` : "";
  return `${head}${attributes}>`;
};

type BundlePlan = {
  schemas: SchemaDocument[];
  entry: SchemaDocument;
  schemaTag: string;
};

const planBundle = (entryFile: string): BundlePlan => {
  const files = discoverDependencies(entryFile);
  const schemas = files.map((file) => parseSchemaDocument(file, readXmlFile(file)));
  const entry = schemas[0];
  if (entry === undefined) {
    throw new Error(`entry file not found: ${entryFile}`);
  }
  const additions = new Map<string, string>();

  for (const schema of schemas) {
    for (const reference of schemaReferences(schema.content)) {
      if (reference.kind === "redefine") {
        failBundle(`cannot bundle <${reference.tagName}> in ${schema.file}`);
      }
      const location = reference.schemaLocation;
      if (location === undefined || location === "") {
        failBundle(
          `cannot bundle <${reference.tagName}> without a schemaLocation in ${schema.file}`,
        );
      }
      const depPath = resolve(dirname(schema.file), location);
      const dependency = schemas.find((candidate) => resolve(candidate.file) === depPath);
      if (dependency === undefined) {
        failBundle(`cannot bundle unresolved schemaLocation "${location}" in ${schema.file}`);
      }

      if (reference.kind === "include") {
        if (dependency.targetNamespace !== entry.targetNamespace) {
          failBundle(
            `cannot bundle include "${location}" with target namespace "${dependency.targetNamespace}" into entry target namespace "${entry.targetNamespace}"`,
          );
        }
      } else {
        const importNamespace = reference.namespace;
        if (importNamespace === undefined) {
          if (entry.targetNamespace !== "" || dependency.targetNamespace !== "") {
            failBundle(
              `cannot bundle no-namespace import "${location}" into entry target namespace "${entry.targetNamespace}"`,
            );
          }
        } else if (
          importNamespace !== entry.targetNamespace ||
          dependency.targetNamespace !== entry.targetNamespace
        ) {
          failBundle(
            `cannot bundle foreign-namespace import "${importNamespace}" from ${dependency.file} into entry target namespace "${entry.targetNamespace}"`,
          );
        }
      }

      if (
        dependency.elementFormDefault !== entry.elementFormDefault ||
        dependency.attributeFormDefault !== entry.attributeFormDefault ||
        dependency.blockDefault !== entry.blockDefault ||
        dependency.finalDefault !== entry.finalDefault
      ) {
        failBundle(
          `cannot bundle ${dependency.file} with elementFormDefault="${dependency.elementFormDefault}" and attributeFormDefault="${dependency.attributeFormDefault}" into entry defaults "${entry.elementFormDefault}"/"${entry.attributeFormDefault}"`,
        );
      }

      if ((dependency.xmlns.get("") ?? "") !== (entry.xmlns.get("") ?? "")) {
        failBundle(`cannot bundle differing default namespace contexts in ${dependency.file}`);
      }

      for (const [prefix, uri] of dependency.xmlns) {
        const existing = entry.xmlns.get(prefix);
        if (existing !== undefined) {
          if (existing !== uri) {
            failBundle(
              `cannot bundle conflicting xmlns${prefix === "" ? "" : `:${prefix}`} binding "${existing}" in the entry with "${uri}" in ${dependency.file}`,
            );
          }
          continue;
        }
        additions.set(prefix, uri);
        entry.xmlns.set(prefix, uri);
      }
    }
  }

  const declarations = [...additions].map(([prefix, uri]) =>
    prefix === ""
      ? `xmlns="${escapeXmlAttribute(uri)}"`
      : `xmlns:${prefix}="${escapeXmlAttribute(uri)}"`,
  );
  return { schemas, entry, schemaTag: normalizeSchemaRootTag(entry.rootTag, declarations) };
};

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

type GenerateOptions = {
  out: string;
  name?: string;
  format?: boolean;
  includeLibraries?: boolean;
  allowMissingImports?: boolean;
  silent?: boolean;
  datatypes?: string;
  integers?: string;
  decimal?: string;
  ergonomic?: boolean;
  fetch?: boolean;
  frozen?: boolean;
  offline?: boolean;
  revalidate?: boolean;
  allowHttp?: boolean;
  allowHost?: string[];
};

type ValidateOptions = {
  xsd: string;
  root?: string;
  engine: string;
};

type BundleOptions = {
  out?: string;
  format?: boolean;
};

type DownloadOptions = {
  out: string;
  offline?: boolean;
  revalidate?: boolean;
  allowHttp?: boolean;
  allowHost?: string[];
  silent?: boolean;
};

const collectOption = (value: string, previous: string[]): string[] => [...previous, value];

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

const download = async (entry: string, opts: DownloadOptions): Promise<void> => {
  if (opts.revalidate === true && opts.offline === true) {
    throw new Error("--revalidate and --offline cannot be used together");
  }
  const entryUrl = asHttpUrl(entry);
  const result = await downloadSchemaClosure(entry, {
    outDir: resolve(opts.out),
    allowHttp: opts.allowHttp === true,
    allowedHosts: opts.allowHost ?? [],
    offline: opts.offline === true,
    revalidate: opts.revalidate === true,
    store: await RemoteSchemaStore.open({
      cwd: process.cwd(),
      offline: opts.offline === true,
    }),
    onFetch: (url, base) => {
      const via =
        entryUrl !== undefined && url === entryUrl.href
          ? ""
          : ` (imported by ${describeSchemaBase(base)})`;
      console.error(`fetching ${url}${via}`);
    },
    onRedirect: (fromUrl, toUrl) => {
      console.error(`warning: cross-origin redirect: ${fromUrl} -> ${toUrl}`);
    },
  });
  for (const diagnostic of result.diagnostics) {
    console.error(`warning: [${diagnostic.kind}] ${diagnostic.message}`);
  }
  if (result.unresolved.length > 0) {
    console.error(
      `warning: ${result.unresolved.length} schemaLocation${result.unresolved.length === 1 ? "" : "s"} could not be vendored and ${result.unresolved.length === 1 ? "was" : "were"} left as-is; the vendored closure is partial`,
    );
  }
  if (result.recorded > 0 && !opts.silent) {
    console.log(
      `recorded ${result.recorded} remote schema${result.recorded === 1 ? "" : "s"} in xsd-to-zod.lock.json`,
    );
  }
  if (!opts.silent) {
    const outDir = resolve(opts.out);
    const partial =
      result.unresolved.length > 0
        ? ` (${result.unresolved.length} location${result.unresolved.length === 1 ? "" : "s"} unresolved; closure is partial)`
        : "";
    console.log(
      `Vendored ${result.files.length} schema${result.files.length === 1 ? "" : "s"} to ${outDir}${partial}`,
    );
    console.log(`entry: ${join(outDir, ...result.entry.split("/"))}`);
  }
};

const generate = async (filesOrDirs: string[], opts: GenerateOptions): Promise<void> => {
  const { out, name, format, includeLibraries, allowMissingImports, silent } = opts;
  const datatypes = opts.datatypes ?? "string";
  if (datatypes !== "string" && datatypes !== "structured") {
    throw new Error(`invalid --datatypes mode: ${datatypes} (expected "string" or "structured")`);
  }
  const integers = opts.integers ?? "number";
  if (integers !== "number" && integers !== "bigint") {
    throw new Error(`invalid --integers mode: ${integers} (expected "number" or "bigint")`);
  }
  const decimal = opts.decimal ?? "number";
  if (decimal !== "number" && decimal !== "string") {
    throw new Error(`invalid --decimal mode: ${decimal} (expected "number" or "string")`);
  }
  if (opts.revalidate === true && opts.offline === true) {
    throw new Error("--revalidate and --offline cannot be used together");
  }
  const files = expandDirectories(filesOrDirs);
  const remoteInputs = filesOrDirs.flatMap((input) => {
    const url = asHttpUrl(input);
    return url ? [url] : [];
  });
  const skipTransitiveFetch = opts.fetch === false;
  if (skipTransitiveFetch && remoteInputs.length === 0) {
    throw new Error("--no-fetch only applies to remote http(s) inputs");
  }
  const fetchRemote = opts.fetch === true || remoteInputs.length > 0;
  if (!fetchRemote) {
    const flag =
      opts.frozen === true
        ? "--frozen"
        : opts.offline === true
          ? "--offline"
          : opts.revalidate === true
            ? "--revalidate"
            : undefined;
    if (flag !== undefined) {
      throw new Error(`${flag} only applies to remote http(s) inputs`);
    }
  }

  if (files.length === 0) {
    throw new Error("no .xsd files found in the given directories");
  }

  if (filesOrDirs.length > 1 && !name) {
    throw new Error("--name/-n is required when processing multiple XSD files");
  }

  const resolvedName = name ?? inputStem(filesOrDirs[0]);
  if (!resolvedName || resolvedName === ".") {
    throw new Error("cannot derive an output name from the input; pass --name/-n");
  }

  if (resolvedName === ".." || resolvedName !== basename(resolvedName)) {
    throw new Error("--name/-n must be a plain file name without path separators");
  }

  // All-or-nothing: compile everything in memory first, then write on
  // success only. If parseXsd or irToZod throws, no files are written.

  const nonLibraryFiles = includeLibraries
    ? files
    : files.filter((file) => asHttpUrl(file) !== undefined || !isLibrary(file));

  if (nonLibraryFiles.length === 0) {
    if (!silent) {
      console.log(
        "Skipped: no root elements (type-definition library). Use --include-libraries to include.",
      );
    }
    return;
  }

  const entryUrls = new Set(remoteInputs.map((url) => url.href));
  const remoteResolver = fetchRemote
    ? createFetchSchemaResolver({
        allowHttp: opts.allowHttp === true,
        allowedHosts: opts.allowHost ?? [],
        entryUrls: [...entryUrls],
        fetchTransitive: !skipTransitiveFetch,
        fetchRemoteFromLocal: opts.fetch === true,
        offline: opts.offline === true,
        revalidate: opts.revalidate === true,
        store: await RemoteSchemaStore.open({
          cwd: process.cwd(),
          frozen: opts.frozen === true,
          offline: opts.offline === true,
        }),
        onFetch: (url, base) => {
          const via = entryUrls.has(url) ? "" : ` (imported by ${describeSchemaBase(base)})`;
          console.error(`fetching ${url}${via}`);
        },
        onRedirect: (fromUrl, toUrl) => {
          console.error(`warning: cross-origin redirect: ${fromUrl} -> ${toUrl}`);
        },
      })
    : undefined;

  const ir = await parseXsd(nonLibraryFiles, {
    ...(allowMissingImports !== undefined && { allowMissingImports }),
    ...(remoteResolver !== undefined && { resolveSchema: remoteResolver.resolve }),
  });

  if (!allowMissingImports) {
    warnDiagnostics(ir, !fetchRemote);
  }
  warnUnenforcedConstructs(ir);

  const { schemas, warnings } = irToZod(ir, {
    datatypes,
    integers,
    decimal,
    ergonomic: opts.ergonomic === true,
  });
  reportWarnings(warnings);

  const outDir = resolve(out);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const zodFile = join(outDir, `${resolvedName}.zod.ts`);
  writeFileSync(zodFile, schemas, "utf8");

  if (format && !runPostGenerationFormatting([zodFile])) {
    console.error(
      "warning: --format requested but no formatter (biome, prettier, eslint) could process the file; it was left unformatted",
    );
  }

  const recorded = (await remoteResolver?.commit()) ?? 0;

  if (!silent && recorded > 0) {
    console.log(
      `recorded ${recorded} remote schema${recorded === 1 ? "" : "s"} in xsd-to-zod.lock.json`,
    );
  }

  if (!silent) {
    console.log(`Wrote ${zodFile}`);
  }
};

const validate = async (xmlFile: string, opts: ValidateOptions): Promise<void> => {
  const { xsd: xsdFile, root, engine } = opts;

  if (engine !== "zod" && engine !== "libxml2") {
    throw new Error(`invalid --engine mode: ${engine} (expected "zod" or "libxml2")`);
  }

  if (!existsSync(xmlFile)) {
    throw new Error(`xml file not found: ${xmlFile}`);
  }

  if (!existsSync(xsdFile)) {
    throw new Error(`xsd file not found: ${xsdFile}`);
  }

  if (engine === "libxml2") {
    const { formatIssues, validateXml } = await import("./validate.js");
    const validation = await validateXml(readXmlFile(xmlFile), readXmlFile(xsdFile), {
      url: resolve(xsdFile),
    });
    if (!validation.valid) {
      throw new Error(`Validation failed:\n${formatIssues(validation.issues).join("\n")}`);
    }
    console.log("Validation passed");
    return;
  }

  const ir = await parseXsd([xsdFile]);
  warnDiagnostics(ir);
  warnUnenforcedConstructs(ir);
  const { schemas, warnings } = irToZod(ir, { js: true });
  reportWarnings(warnings);
  const mod = await importGeneratedModule(schemas);

  const roots: { schema: z.ZodType; root: string }[] = [];
  for (const value of Object.values(mod)) {
    if (isZodSchema(value)) {
      const rootQname = xmlRegistry.get(value)?.root;
      if (rootQname) {
        roots.push({ schema: value, root: rootQname });
      }
    }
  }

  const selected = root
    ? roots.find((candidate) => candidate.root === root)
    : roots.length === 1
      ? roots[0]
      : undefined;

  if (!selected) {
    if (roots.length === 0) {
      throw new Error("no root elements found in schema");
    } else if (root) {
      throw new Error(
        `root element ${root} not found; available roots: ${roots.map((r) => r.root).join(", ")}`,
      );
    } else {
      throw new Error(
        `multiple root elements found, use --root to specify one: ${roots.map((r) => r.root).join(", ")}`,
      );
    }
  }

  const xml = readXmlFile(xmlFile);

  const parsed = safeParseXml(selected.schema, xml);
  if (!parsed.success) {
    const detail =
      parsed.error instanceof z.ZodError
        ? z.prettifyError(parsed.error)
        : parsed.error instanceof Error
          ? parsed.error.message
          : String(parsed.error);
    throw new Error(`Validation failed: ${detail}`);
  }

  console.log("Validation passed");
  console.log(JSON.stringify(parsed.data, null, 2));
};

const program = new Command()
  .name("xsd-to-zod")
  .version(PACKAGE_VERSION)
  .exitOverride()
  .enablePositionalOptions()
  .description("Turn XSD schemas into strongly-typed Zod parsers for XML.")
  .argument(
    "[files-or-dirs...]",
    "XSD schema files or directories (directories are recursively expanded)",
  )
  .option("-o, --out <dir>", "Output directory", ".")
  .option("-n, --name <name>", "Basename for the generated file (default: stem of first input)")
  .option("-f, --format", "Run formatter on the generated file")
  .option(
    "--include-libraries",
    "Include type-definition-only schemas (those without root elements)",
  )
  .option(
    "--allow-missing-imports",
    "Suppress warnings for unresolved XSD references; unresolved element refs map to z.unknown() instead of being dropped",
  )
  .option("--silent", "Suppress informational output (warnings are still shown)")
  .option(
    "--datatypes <mode>",
    'Mapping for the XSD date/time builtins: "string" (default) or "structured" (parse into plain objects, serialize canonically)',
  )
  .option(
    "--integers <mode>",
    'Mapping for the xs:integer family: "number" (default; JSON-safe, exact below 2^53, long/unsignedLong outer bounds dropped) or "bigint" (exact at any magnitude, but JSON.stringify throws on the parsed data)',
  )
  .option(
    "--decimal <mode>",
    'Mapping for xs:decimal: "number" (default; float64, lossy beyond ~16 significant digits) or "string" (exact canonical decimal lexical)',
  )
  .option(
    "--ergonomic",
    'Preview the 1.0 output shape: collapse lone-attribute value wrappers to scalars, drop the "@" prefix from attribute keys (colliding attributes keep it), and emit repeated choices as one tagged array',
  )
  .option("--fetch", "Resolve remote imports/includes for local schema inputs")
  .option("--no-fetch", "Fetch only remote entry schemas; skip their remote imports/includes")
  .option("--frozen", "Verify remote schemas against xsd-to-zod.lock.json without updating it")
  .option("--offline", "Resolve remote schemas from the local cache only")
  .option(
    "--revalidate",
    "Revalidate cached remote schemas against the server (ETag/If-None-Match) instead of serving them from the cache unchecked",
  )
  .option("--allow-http", "Permit insecure http:// schema URLs")
  .option(
    "--allow-host <host>",
    "Allow fetching from a host (repeatable; applies to entry URLs too)",
    collectOption,
    [],
  )
  .action(generate);

program
  .command("download")
  .description(
    "Vendor a schema and its remote import/include closure to self-contained local files",
  )
  .argument("<entry>", "Entry schema: http(s) URL or local .xsd file")
  .requiredOption("-o, --out <dir>", "Directory to vendor the schema closure into")
  .option("--offline", "Vendor remote schemas from the local cache only; fail on a cache miss")
  .option(
    "--revalidate",
    "Check upstream for changes via ETag (304 reuses the cache) instead of always downloading full bodies",
  )
  .option("--allow-http", "Permit insecure http:// schema URLs")
  .option(
    "--allow-host <host>",
    "Allow fetching from a host (repeatable; applies to entry URLs too)",
    collectOption,
    [],
  )
  .option("--silent", "Suppress informational output (warnings are still shown)")
  .action(download);

program
  .command("validate")
  .description("Validate XML against an XSD schema")
  .argument("<xml-file>", "XML file to validate")
  .requiredOption("-x, --xsd <file>", "XSD schema file")
  .option("-r, --root <name>", "Root element QName (auto-detected when unambiguous)")
  .option("-e, --engine <engine>", "Validation engine: zod (default) or libxml2", "zod")
  .action(validate);

program
  .command("bundle")
  .description("Merge XSD imports/includes into one self-contained file")
  .argument("<entry.xsd>", "Entry XSD file to bundle")
  .option("-o, --out <file>", "Output file path (default: <entry-stem>.bundled.xsd)")
  .option("-f, --format", "Run formatter on the output")
  .action((entryFile: string, opts: BundleOptions) => {
    const { format } = opts;
    let { out } = opts;

    if (!existsSync(entryFile)) {
      throw new Error(`entry file not found: ${entryFile}`);
    }

    if (!out) {
      const stem = entryFile
        .replace(/\.xsd$/i, "")
        .split(/[\\/]/)
        .pop();
      out = stem ? `${stem}.bundled.xsd` : "bundled.xsd";
    }

    const plan = planBundle(entryFile);
    const bodies = plan.schemas.map((schema) => stripImports(schema.body));

    const bundled = `${plan.schemaTag}\n${bodies.join("\n")}\n</${plan.entry.prefix}schema>`;

    const outDir = dirname(resolve(out));
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    writeFileSync(resolve(out), bundled, "utf8");

    if (format && !runPostGenerationFormatting([resolve(out)])) {
      console.error(
        "warning: --format requested but no formatter (biome, prettier, eslint) could process the file; it was left unformatted",
      );
    }

    console.log(`Bundled ${plan.schemas.length} file(s) → ${out}`);
  });

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const main = async (args: string[]): Promise<number> => {
  if (args.includes("--fetch") && args.includes("--no-fetch")) {
    console.error("error: --fetch and --no-fetch cannot be used together");
    return 1;
  }
  try {
    await program.parseAsync(args, { from: "user" });
    return 0;
  } catch (e) {
    // Commander throws CommanderError for --help/--version and for parsing errors.
    // helpDisplayed/version means help/version was shown successfully → exit 0.
    // Other CommanderError codes (exitCode: 1) mean commander already printed an
    // error message to stderr, so we just return 1 without duplicating it.
    if (e instanceof Error && "code" in e) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version") {
        return 0;
      }
      if (typeof e.code === "string" && e.code.startsWith("commander.")) {
        return 1;
      }
    }
    console.error(`error: ${errorMessage(e)}`);
    return 1;
  }
};

export const isDirectInvocation = (argv1: string | undefined, moduleUrl: string): boolean => {
  if (!argv1) {
    return false;
  }
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
};

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
