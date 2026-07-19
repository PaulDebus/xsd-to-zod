#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntimeMetadata, irToZod } from './irToZod.js';
import { parseXsd } from './parseXsd.js';
import { runPostGenerationFormatting } from './postProcess.js';
import { readXmlFile } from './readXmlFile.js';
import { parseXmlWithMetadata } from './runtime.js';
import type { RuntimeMetadata, XsdIr } from './types.js';

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

export const USAGE = `xsd2zod — XSD-to-Zod code generator

Turn XSD schema files into strongly-typed Zod parsers and runtime metadata
for XML parsing/serialization round-trips.

Usage:
  xsd2zod <files...> [options]
  xsd2zod validate <xml-file> [options]

Arguments:
  files                     One or more XSD schema files to process

Options:
  -o, --out <dir>           Output directory (default: current directory)
  -n, --name <name>         Basename for generated files (default: stem of first
                            input file; required when >1 file is given)
  -f, --format              Run prettier/biome formatter on generated files
  -h, --help                Show this help message

Examples:
  xsd2zod schema.xsd -o src/generated --format
  xsd2zod types.xsd elements.xsd -n my-api -o src/generated
  xsd2zod validate data.xml --xsd schema.xsd
  xsd2zod validate data.xml --metadata my-api.meta.ts
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

export const VALIDATE_USAGE = `xsd2zod validate — Validate XML against XSD schema or generated metadata

Usage:
  xsd2zod validate <xml-file> [options]

Arguments:
  xml-file                  XML file to validate

Options:
  -x, --xsd <file>          XSD schema file (generates metadata on the fly)
  -m, --metadata <file>     Pre-generated .meta.ts file with runtime metadata
  -r, --root <name>         Root element QName (auto-detected when unambiguous)
  -h, --help                Show this help message

Examples:
  xsd2zod validate data.xml --xsd schema.xsd
  xsd2zod validate data.xml --metadata my-api.meta.ts
`;

export type ValidateArgsResult =
  | { ok: true; help: true }
  | { ok: true; help: false; xmlFile: string; xsdFile?: string; metadataFile?: string; root?: string }
  | { ok: false; error: string };

export const parseValidateArgs = (args: string[]): ValidateArgsResult => {
  let xmlFile: string | undefined;
  let xsdFile: string | undefined;
  let metadataFile: string | undefined;
  let root: string | undefined;
  let i = 0;

  const isFlag = (arg: string): string | undefined => {
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--xsd' || arg === '-x') return 'xsd';
    if (arg === '--metadata' || arg === '-m') return 'metadata';
    if (arg === '--root' || arg === '-r') return 'root';
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
    } else if (flag === 'metadata') {
      i++;
      metadataFile = args[i];
      if (!metadataFile || metadataFile.startsWith('-')) {
        return { ok: false, error: '--metadata/-m requires a file argument' };
      }
    } else if (flag === 'root') {
      i++;
      root = args[i];
      if (!root || root.startsWith('-')) {
        return { ok: false, error: '--root/-r requires a QName argument' };
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

  if (xsdFile && metadataFile) {
    return { ok: false, error: '--xsd and --metadata are mutually exclusive' };
  }

  if (!xsdFile && !metadataFile) {
    return { ok: false, error: 'either --xsd or --metadata is required' };
  }

  return { ok: true, help: false, xmlFile, xsdFile, metadataFile, root };
};

export const loadMetadataFromMetaTs = (metaFile: string): RuntimeMetadata => {
  const content = readFileSync(metaFile, 'utf8');
  let json = content.trim();
  json = json.replace(/^\/\/.*$/m, '').trim();
  json = json.replace(/^export\s+const\s+runtimeMetadata\s*=\s*/, '');
  json = json.replace(/\s*as\s+const\s*;?\s*$/, '');
  try {
    return JSON.parse(json) as RuntimeMetadata;
  } catch (e) {
    throw new Error(`failed to parse metadata file ${metaFile}: ${errorMessage(e)}`);
  }
};

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export const cmdValidate = (args: string[]): void => {
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

  let runtimeMetadata: RuntimeMetadata;

  if (result.xsdFile) {
    if (!existsSync(result.xsdFile)) {
      throw new CliError(`xsd file not found: ${result.xsdFile}`);
    }
    const ir = parseXsd([result.xsdFile]);
    warnUnresolvedRefs(ir);
    runtimeMetadata = buildRuntimeMetadata(ir);
  } else {
    if (!existsSync(result.metadataFile!)) {
      throw new CliError(`metadata file not found: ${result.metadataFile}`);
    }
    try {
      runtimeMetadata = loadMetadataFromMetaTs(result.metadataFile!);
    } catch (e) {
      throw new CliError(errorMessage(e));
    }
  }

  const rootQName = result.root;
  const rootMeta = rootQName
    ? runtimeMetadata.roots.find((r) => r.rootElement === rootQName)
    : runtimeMetadata.roots.length === 1
      ? runtimeMetadata.roots[0]
      : undefined;

  if (!rootMeta) {
    if (runtimeMetadata.roots.length === 0) {
      throw new CliError('no root elements in metadata');
    } else if (rootQName) {
      throw new CliError(`root element ${rootQName} not found in metadata`);
    } else {
      throw new CliError(`multiple root elements found, use --root to specify one: ${runtimeMetadata.roots.map((r) => r.rootElement).join(', ')}`);
    }
  }

  const xml = readXmlFile(result.xmlFile);

  try {
    const parsed = parseXmlWithMetadata(xml, rootMeta, runtimeMetadata.types);
    console.log('Validation passed');
    console.log(JSON.stringify(parsed, null, 2));
  } catch (e) {
    throw new CliError(`Validation failed: ${errorMessage(e)}`);
  }
};

export const main = (args: string[]): number => {
  if (args[0] === 'validate') {
    try {
      cmdValidate(args.slice(1));
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
    const { schemas, metadata } = irToZod(ir);

    const zodFile = join(outDir, `${name}.zod.ts`);
    const metaFile = join(outDir, `${name}.meta.ts`);

    writeFileSync(zodFile, schemas, 'utf8');
    writeFileSync(metaFile, metadata, 'utf8');

    const generated = [zodFile, metaFile];

    if (format) {
      runPostGenerationFormatting(generated);
    }

    console.log(`Wrote ${zodFile}`);
    console.log(`Wrote ${metaFile}`);
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
  process.exit(main(process.argv.slice(2)));
}
