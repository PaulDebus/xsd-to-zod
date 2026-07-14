#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXsd } from './parseXsd.js';
import { irToZod } from './irToZod.js';
import { runPostGenerationFormatting } from './postProcess.js';

export const USAGE = `Usage: xsd2zod <files...> [options]

Generate Zod schemas and runtime metadata from XSD files.

Arguments:
  files                     One or more XSD schema files

Options:
  --out, -o <dir>           Output directory (default: .)
  --name, -n <name>         Output basename (default: stem of single input; required when >1 file)
  --format, -f              Run prettier/biome formatter on generated files
  --help, -h                Show this help message
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
      if (!out || isFlag(out) !== undefined) {
        return { ok: false, error: '--out/-o requires a directory argument' };
      }
    } else if (flag === 'name') {
      i++;
      name = args[i];
      if (!name || isFlag(name) !== undefined) {
        return { ok: false, error: '--name/-n requires a string argument' };
      }
    } else if (flag === 'format') {
      format = true;
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
    name = stem;
  }

  return { ok: true, help: false, files, out, name, format };
};

const main = (): void => {
  const result = parseArgs(process.argv.slice(2));

  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }

  if (result.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const { files, out, name, format } = result;
  const outDir = resolve(out);

  if (!existsSync(outDir)) {
    console.error(`error: output directory does not exist: ${outDir}`);
    process.exit(1);
  }

  const ir = parseXsd(files);
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
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
