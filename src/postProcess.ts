import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const run = (command: string, args: string[], cwd: string): void => {
  const result = spawnSync(command, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
};

// Resolve the tool's local bin instead of spawning `npx <tool>`: faster, and
// portable — `npx` is a .cmd shim on Windows and fails there without shell.
const binPath = (cwd: string, binName: string): string | undefined => {
  const binDir = path.join(cwd, 'node_modules', '.bin');
  for (const candidate of [binName, `${binName}.cmd`, `${binName}.ps1`]) {
    const full = path.join(binDir, candidate);
    if (fs.existsSync(full)) {
      return full;
    }
  }
  return undefined;
};

const hasConfig = (cwd: string, candidates: string[]): boolean =>
  candidates.some((candidate) => fs.existsSync(path.join(cwd, candidate)));

const PRETTIER_CONFIGS = ['.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js'];
const ESLINT_CONFIGS = [
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
  '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs'
];

export const runPostGenerationFormatting = (generatedFiles: string[], cwd = process.cwd()): void => {
  if (generatedFiles.length === 0) {
    return;
  }

  const biome = binPath(cwd, 'biome');
  if (biome && fs.existsSync(path.join(cwd, 'biome.json'))) {
    run(biome, ['format', '--write', ...generatedFiles], cwd);
    run(biome, ['lint', '--write', ...generatedFiles], cwd);
    return;
  }

  const prettier = binPath(cwd, 'prettier');
  if (prettier && hasConfig(cwd, PRETTIER_CONFIGS)) {
    run(prettier, ['--write', ...generatedFiles], cwd);
    return;
  }

  // ESLint v9 exits non-zero without a config file — only run it when one
  // exists, so a config-less project doesn't crash the CLI after the output
  // files were already written (#74).
  const eslint = binPath(cwd, 'eslint');
  if (eslint && hasConfig(cwd, ESLINT_CONFIGS)) {
    run(eslint, ['--fix', ...generatedFiles], cwd);
  }
};
