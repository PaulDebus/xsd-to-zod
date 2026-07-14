#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseXsd } from './parseXsd.js';
import { irToZod } from './irToZod.js';
import { runPostGenerationFormatting } from './postProcess.js';

const USAGE = `Usage: xsd2zod <files...> [options]

Generate Zod schemas and runtime metadata from XSD files.

Arguments:
  files                     One or more XSD schema files

Options:
  --out, -o <dir>           Output directory (default: .)
  --name, -n <name>         Output basename (default: stem of single input; required when >1 file)
  --format, -f              Run prettier/biome formatter on generated files
  --help, -h                Show this help message
`;

const isFlag = (arg: string): string | undefined => {
  if (arg === '--help' || arg === '-h') return 'help';
  if (arg === '--out' || arg === '-o') return 'out';
  if (arg === '--name' || arg === '-n') return 'name';
  if (arg === '--format' || arg === '-f') return 'format';
  return undefined;
};

const parseArgs = (args: string[]): { files: string[]; out: string; name?: string; format: boolean } => {
  const files: string[] = [];
  let out = '.';
  let name: string | undefined;
  let format = false;
  let i = 0;

  while (i < args.length) {
    const flag = isFlag(args[i]);
    if (flag === 'help') {
      console.log(USAGE);
      process.exit(0);
    } else if (flag === 'out') {
      i++;
      out = args[i];
      if (!out || isFlag(out) !== undefined) {
        console.error('error: --out/-o requires a directory argument');
        process.exit(1);
      }
    } else if (flag === 'name') {
      i++;
      name = args[i];
      if (!name || isFlag(name) !== undefined) {
        console.error('error: --name/-n requires a string argument');
        process.exit(1);
      }
    } else if (flag === 'format') {
      format = true;
    } else {
      files.push(args[i]);
    }
    i++;
  }

  if (files.length === 0) {
    console.error('error: at least one XSD file is required');
    console.error(USAGE);
    process.exit(1);
  }

  if (files.length > 1 && !name) {
    console.error('error: --name/-n is required when processing multiple XSD files');
    process.exit(1);
  }

  if (!name) {
    const stem = files[0].replace(/\.xsd$/i, '').split(/[\\/]/).pop()!;
    name = stem;
  }

  return { files, out, name, format };
};

const main = (): void => {
  const { files, out, name, format } = parseArgs(process.argv.slice(2));
  const outDir = resolve(out);
  mkdirSync(outDir, { recursive: true });

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

main();
