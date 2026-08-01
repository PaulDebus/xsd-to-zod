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
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { z } from "zod";
import { Xsd2ZodError } from "./errors.js";
import { irToZod } from "./irToZod.js";
import { parseXsd } from "./parseXsd.js";
import type { XsdIr } from "./types.js";

const errorMessage = (e: unknown): string => {
  if (e instanceof Xsd2ZodError) {
    const location = e.file ? `${e.file}: ` : "";
    return `${location}${e.message} [${e.code}]`;
  }
  return e instanceof Error ? e.message : String(e);
};

const warnDiagnostics = (ir: XsdIr): void => {
  for (const diagnostic of ir.diagnostics) {
    console.error(`warning: [${diagnostic.kind}] ${diagnostic.message}`);
  }
};

import { runPostGenerationFormatting } from "./postProcess.js";
import { readXmlFile } from "./readXmlFile.js";
import { safeParseXml } from "./runtime.js";
import { xmlRegistry } from "./xmlMeta.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shared pattern matching `<xs:import>`, `<xs:include>`, or `<xs:redefine>` (with optional `xs:` prefix). */
const IMPORT_INCLUDE_REDUCE_RE = /<(?:xs:)?(?:import|include|redefine)\b/;

const isZodSchema = (value: unknown): value is z.ZodType =>
  value !== null && typeof value === "object" && "_zod" in value;

const importGeneratedModule = async (schemasCode: string): Promise<Record<string, unknown>> => {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const baseDir = join(packageRoot, ".xsd-to-zod-cli");
  mkdirSync(baseDir, { recursive: true });
  const dir = mkdtempSync(join(baseDir, "run-"));
  try {
    const file = join(dir, "generated.mjs");
    writeFileSync(file, schemasCode, "utf8");
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const expandDirectories = (files: string[], visitedDirs = new Set<string>()): string[] => {
  const expanded: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) {
      expanded.push(file);
      continue;
    }
    const stat = statSync(file);
    if (stat.isDirectory()) {
      // Guard against symlink cycles: visit each real directory only once.
      const real = realpathSync(file);
      if (visitedDirs.has(real)) {
        continue;
      }
      visitedDirs.add(real);
      const entries = readdirSync(file);
      for (const entry of entries) {
        expanded.push(...expandDirectories([join(file, entry)], visitedDirs));
      }
    } else if (extname(file) === ".xsd") {
      expanded.push(file);
    }
  }
  return expanded.sort();
};

export const discoverDependencies = (entryFile: string, visited = new Set<string>()): string[] => {
  const resolved = resolve(entryFile);
  if (visited.has(resolved)) {
    return [];
  }
  visited.add(resolved);

  const content = readFileSync(resolved, "utf8");
  const files: string[] = [resolved];

  const re = new RegExp(
    `${IMPORT_INCLUDE_REDUCE_RE.source}[^>]*schemaLocation=["']([^"']+)["']`,
    "g",
  );
  let match: RegExpExecArray | null = re.exec(content);
  while (match !== null) {
    const depPath = resolve(dirname(resolved), match[1] ?? "");
    if (existsSync(depPath)) {
      files.push(...discoverDependencies(depPath, visited));
    }
    match = re.exec(content);
  }

  return files;
};

export const stripImports = (xsd: string): string =>
  xsd
    .replace(new RegExp(`${IMPORT_INCLUDE_REDUCE_RE.source}[^>]*\\/?>`, "g"), "")
    .replace(
      new RegExp(
        `${IMPORT_INCLUDE_REDUCE_RE.source}[^>]*>[\\s\\S]*?<\\/(?:xs:)?(?:import|include|redefine)>`,
        "g",
      ),
      "",
    );

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
    const tagRe = /<\/?(?:\w+:)?(\w+)[^>]*\/?>/g;
    tagRe.lastIndex = start;
    let m: RegExpExecArray | null = tagRe.exec(content);
    while (m !== null) {
      const tag = m[0];
      const local = m[1];
      if (tag.startsWith("</")) {
        depth--;
        if (depth === 0) {
          break;
        }
      } else {
        if (depth === 1 && local === "element") {
          return false;
        }
        if (!tag.endsWith("/")) {
          depth++;
        }
      }
      m = tagRe.exec(content);
    }
    return true;
  } catch {
    return false;
  }
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

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

const generate = async (filesOrDirs: string[], opts: GenerateOptions): Promise<void> => {
  const { out, name, format, includeLibraries, allowMissingImports, silent } = opts;
  const files = expandDirectories(filesOrDirs);

  if (files.length === 0) {
    throw new Error("no .xsd files found in the given directories");
  }

  if (filesOrDirs.length > 1 && !name) {
    throw new Error("--name/-n is required when processing multiple XSD files");
  }

  const resolvedName =
    name ??
    filesOrDirs[0]
      ?.replace(/\.xsd$/i, "")
      .split(/[\\/]/)
      .filter(Boolean)
      .pop();
  if (!resolvedName || resolvedName === ".") {
    throw new Error("cannot derive an output name from the input; pass --name/-n");
  }

  if (resolvedName === ".." || resolvedName !== basename(resolvedName)) {
    throw new Error("--name/-n must be a plain file name without path separators");
  }

  // All-or-nothing: compile everything in memory first, then write on
  // success only. If parseXsd or irToZod throws, no files are written.

  const nonLibraryFiles = includeLibraries ? files : files.filter((file) => !isLibrary(file));

  if (nonLibraryFiles.length === 0) {
    if (!silent) {
      console.log(
        "Skipped: no root elements (type-definition library). Use --include-libraries to include.",
      );
    }
    return;
  }

  const ir = parseXsd(nonLibraryFiles, {
    ...(allowMissingImports !== undefined && { allowMissingImports }),
  });

  if (!allowMissingImports) {
    warnDiagnostics(ir);
  }

  const { schemas } = irToZod(ir);

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

  if (!silent) {
    console.log(`Wrote ${zodFile}`);
  }
};

const validate = async (xmlFile: string, opts: ValidateOptions): Promise<void> => {
  const { xsd: xsdFile, root, engine } = opts;

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

  const ir = parseXsd([xsdFile]);
  warnDiagnostics(ir);
  const { schemas } = irToZod(ir, { js: true });
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
  .action(generate);

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

    const files = discoverDependencies(entryFile);

    const entryContent = readFileSync(entryFile, "utf8");

    const bodies: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const schemaMatch = content.match(/<((?:xs:)?schema)\b[^>]*>([\s\S]*)<\/\1>/);
      if (schemaMatch) {
        bodies.push(stripImports(schemaMatch[2] ?? ""));
      }
    }

    const tagMatch = entryContent.match(/<((?:xs:)?schema)\b[^>]*>/);
    const schemaTag = tagMatch?.[0] ?? '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">';

    const bundled = `${schemaTag}\n${bodies.join("\n")}\n</xs:schema>`;

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

    console.log(`Bundled ${files.length} file(s) → ${out}`);
  });

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const main = async (args: string[]): Promise<number> => {
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
