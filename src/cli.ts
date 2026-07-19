#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { irToZod } from './irToZod.js';
import { parseXsd } from './parseXsd.js';
import type { XsdIr } from './types.js';

// Thrown values are usually Errors but not guaranteed to be — never print
// "error: undefined".
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// References the parser could not resolve are kept lenient on the IR level;
// the CLI is where they become visible to the user (#77).
const warnUnresolvedRefs = (ir: XsdIr): void => {
  for (const ref of ir.unresolvedRefs) {
    console.error(`warning: ${ref}`);
  }
};
import { runPostGenerationFormatting } from './postProcess.js';
import { readXmlFile } from './readXmlFile.js';
import { safeParseXml } from './runtime.js';
import { xmlRegistry } from './xmlMeta.js';

export const USAGE = `xsd2zod — XSD-to-Zod code generator

Turn XSD schema files into strongly-typed Zod parsers that carry their XML
knowledge in a zod registry — one generated artifact for XML
parsing/serialization round-trips.

Usage:
  xsd2zod <files...> [options]
  xsd2zod validate <xml-file> [options]

Arguments:
  files                     One or more XSD schema files to process

Options:
  -o, --out <dir>           Output directory (default: current directory)
  -n, --name <name>         Basename for the generated file (default: stem of
                            first input file; required when >1 file is given)
  -f, --format              Run prettier/biome formatter on the generated file
  -h, --help                Show this help message

Examples:
  xsd2zod schema.xsd -o src/generated --format
  xsd2zod types.xsd elements.xsd -n my-api -o src/generated
  xsd2zod validate data.xml --xsd schema.xsd
`;

export type ParseArgsResult =
  | { ok: true; help: true }
  | { ok: true; help: false; files: string[]; out: string; name: string; format: boolean }
  | { ok: false; error: string };

const isFlag = (arg: string): string | undefined => {
  if (arg === '--help' || arg === '-h') return 'help';
  if (arg === '--out' || arg === '-o') return 'out';
  if (arg === '--name' || arg === '-n') return 'name';
  if (arg === '--format' || arg === '-f') return 'format';
  return undefined;
};

export const parseArgs = (args: string[]): ParseArgsResult => {
  const files: string[] = [];
  let out = '.';
  let name: string | undefined;
  let format = false;
  let i = 0;

  while (i < args.length) {
    const flag = isFlag(args[i]);
    if (flag === 'help') {
      return { ok: true, help: true };
    } else if (flag === 'out') {
      i++;
      out = args[i];
      if (!out || out.startsWith('-')) {
        return { ok: false, error: '--out/-o requires a directory argument' };
      }
    } else if (flag === 'name') {
      i++;
      name = args[i];
      if (!name || name.startsWith('-')) {
        return { ok: false, error: '--name/-n requires a string argument' };
      }
    } else if (flag === 'format') {
      format = true;
    } else if (args[i].startsWith('-')) {
      return { ok: false, error: `unknown option: ${args[i]}` };
    } else {
      files.push(args[i]);
    }
    i++;
  }

  if (files.length === 0) {
    return { ok: false, error: 'at least one XSD file is required' };
  }

  if (files.length > 1 && !name) {
    return { ok: false, error: '--name/-n is required when processing multiple XSD files' };
  }

  if (!name) {
    const stem = files[0].replace(/\.xsd$/i, '').split(/[\\/]/).pop()!;
    if (!stem) {
      return { ok: false, error: 'cannot derive an output name from the input file; pass --name/-n' };
    }
    name = stem;
  }

  // --name is joined into the output path — reject path traversal (#82).
  if (name === '..' || name !== basename(name)) {
    return { ok: false, error: '--name/-n must be a plain file name without path separators' };
  }

  return { ok: true, help: false, files, out, name, format };
};

export const VALIDATE_USAGE = `xsd2zod validate — Validate XML against an XSD schema

Usage:
  xsd2zod validate <xml-file> [options]

Arguments:
  xml-file                  XML file to validate

Options:
  -x, --xsd <file>          XSD schema file
  -r, --root <name>         Root element QName (zod engine; auto-detected when
                            unambiguous)
  -e, --engine <engine>     Validation engine: 'zod' (default — typed parse via
                            the generated schemas) or 'libxml2' (full XSD
                            conformance; requires the optional libxml2-wasm
                            peer dependency)
  -h, --help                Show this help message

Examples:
  xsd2zod validate data.xml --xsd schema.xsd
  xsd2zod validate data.xml --xsd schema.xsd --root '{urn:example}order'
  xsd2zod validate data.xml --xsd schema.xsd --engine libxml2
`;

export type ValidateEngine = 'zod' | 'libxml2';

export type ValidateArgsResult =
  | { ok: true; help: true }
  | { ok: true; help: false; xmlFile: string; xsdFile: string; root?: string; engine: ValidateEngine }
  | { ok: false; error: string };

export const parseValidateArgs = (args: string[]): ValidateArgsResult => {
  let xmlFile: string | undefined;
  let xsdFile: string | undefined;
  let root: string | undefined;
  let engine: string | undefined;
  let i = 0;

  const isFlag = (arg: string): string | undefined => {
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--xsd' || arg === '-x') return 'xsd';
    if (arg === '--root' || arg === '-r') return 'root';
    if (arg === '--engine' || arg === '-e') return 'engine';
    return undefined;
  };

  while (i < args.length) {
    const flag = isFlag(args[i]);
    if (flag === 'help') {
      return { ok: true, help: true };
    } else if (flag === 'xsd') {
      i++;
      xsdFile = args[i];
      if (!xsdFile || xsdFile.startsWith('-')) {
        return { ok: false, error: '--xsd/-x requires a file argument' };
      }
    } else if (flag === 'root') {
      i++;
      root = args[i];
      if (!root || root.startsWith('-')) {
        return { ok: false, error: '--root/-r requires a QName argument' };
      }
    } else if (flag === 'engine') {
      i++;
      engine = args[i];
      if (!engine || engine.startsWith('-')) {
        return { ok: false, error: '--engine/-e requires an engine argument' };
      }
    } else if (args[i].startsWith('-')) {
      return { ok: false, error: `unknown option: ${args[i]}` };
    } else {
      xmlFile = args[i];
    }
    i++;
  }

  if (!xmlFile) {
    return { ok: false, error: 'xml-file is required' };
  }

  if (!xsdFile) {
    return { ok: false, error: '--xsd is required' };
  }

  if (engine !== undefined && engine !== 'zod' && engine !== 'libxml2') {
    return { ok: false, error: `unknown engine: ${engine} (expected 'zod' or 'libxml2')` };
  }

  return { ok: true, help: false, xmlFile, xsdFile, root, engine: engine ?? 'zod' };
};

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

// Import generated code as a module. Written in a dotdir at the package root
// so the generated 'xsd2zod' self-reference and its 'zod' import resolve
// (self-reference does not work from inside node_modules).
const importGeneratedModule = async (schemasCode: string): Promise<Record<string, unknown>> => {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const baseDir = join(packageRoot, '.xsd2zod-cli');
  mkdirSync(baseDir, { recursive: true });
  const dir = mkdtempSync(join(baseDir, 'run-'));
  try {
    const file = join(dir, 'generated.mjs');
    writeFileSync(file, schemasCode, 'utf8');
    return await import(pathToFileURL(file).href) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const cmdValidate = async (args: string[]): Promise<void> => {
  const result = parseValidateArgs(args);

  if (!result.ok) {
    throw new CliError(result.error);
  }

  if (result.help) {
    console.log(VALIDATE_USAGE);
    return;
  }

  if (!existsSync(result.xmlFile)) {
    throw new CliError(`xml file not found: ${result.xmlFile}`);
  }

  if (!existsSync(result.xsdFile)) {
    throw new CliError(`xsd file not found: ${result.xsdFile}`);
  }

  if (result.engine === 'libxml2') {
    // Conformance tier: full XSD semantics via libxml2-wasm (optional peer
    // dependency). --root is a zod-engine concept and is ignored here.
    const { validateXml } = await import('./validate.js');
    const validation = await validateXml(readXmlFile(result.xmlFile), readXmlFile(result.xsdFile), {
      url: resolve(result.xsdFile),
    });
    if (!validation.valid) {
      const detail = validation.issues
        .map((issue) => `${issue.line !== undefined ? `line ${issue.line}: ` : ''}${issue.message}`)
        .join('\n');
      throw new CliError(`Validation failed:\n${detail}`);
    }
    console.log('Validation passed');
    return;
  }

  const ir = parseXsd([result.xsdFile]);
  warnUnresolvedRefs(ir);
  const { schemas } = irToZod(ir, { js: true });
  const mod = await importGeneratedModule(schemas);

  const roots: { schema: z.ZodType; root: string }[] = [];
  for (const value of Object.values(mod)) {
    if (value !== null && typeof value === 'object' && '_zod' in value) {
      const root = xmlRegistry.get(value as z.ZodType)?.root;
      if (root) {
        roots.push({ schema: value as z.ZodType, root });
      }
    }
  }

  const selected = result.root
    ? roots.find((candidate) => candidate.root === result.root)
    : roots.length === 1
      ? roots[0]
      : undefined;

  if (!selected) {
    if (roots.length === 0) {
      throw new CliError('no root elements found in schema');
    } else if (result.root) {
      throw new CliError(`root element ${result.root} not found; available roots: ${roots.map((r) => r.root).join(', ')}`);
    } else {
      throw new CliError(`multiple root elements found, use --root to specify one: ${roots.map((r) => r.root).join(', ')}`);
    }
  }

  const xml = readXmlFile(result.xmlFile);

  const parsed = safeParseXml(selected.schema, xml);
  if (!parsed.success) {
    const detail = parsed.error instanceof z.ZodError
      ? z.prettifyError(parsed.error)
      : (parsed.error as Error).message;
    throw new CliError(`Validation failed: ${detail}`);
  }

  console.log('Validation passed');
  console.log(JSON.stringify(parsed.data, null, 2));
};

export const main = async (args: string[]): Promise<number> => {
  if (args[0] === 'validate') {
    try {
      await cmdValidate(args.slice(1));
    } catch (e) {
      console.error(`error: ${errorMessage(e)}`);
      return 1;
    }
    return 0;
  }

  try {
    const result = parseArgs(args);

    if (!result.ok) {
      console.error(`error: ${result.error}`);
      return 1;
    }

    if (result.help) {
      console.log(USAGE);
      return 0;
    }

    const { files, out, name, format } = result;
    const outDir = resolve(out);

    if (!existsSync(outDir)) {
      console.error(`error: output directory does not exist: ${outDir}`);
      return 1;
    }

    const ir = parseXsd(files);
    warnUnresolvedRefs(ir);
    const { schemas } = irToZod(ir);

    const zodFile = join(outDir, `${name}.zod.ts`);

    writeFileSync(zodFile, schemas, 'utf8');

    if (format) {
      runPostGenerationFormatting([zodFile]);
    }

    console.log(`Wrote ${zodFile}`);
    return 0;
  } catch (e) {
    // One error style for everything that can go wrong after arg parsing:
    // missing input files, malformed XML, unwritable output paths (#82).
    console.error(`error: ${errorMessage(e)}`);
    return 1;
  }
};

// npm installs the bin as a symlink (node_modules/.bin/xsd2zod → dist/cli.js);
// process.argv[1] keeps the symlink path while the ESM loader resolves
// import.meta.url to the realpath — compare realpaths on both sides so the
// CLI actually runs when invoked through the symlink (#80).
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
