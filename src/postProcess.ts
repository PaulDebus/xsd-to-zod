import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const run = (command: string, args: string[], cwd: string): void => {
  // .cmd shims (Windows) can only be spawned through a shell; quote the path
  // so spaces in it survive the command line.
  const isCmdShim = command.endsWith('.cmd');
  const result = spawnSync(isCmdShim ? `"${command}"` : command, args, {
    cwd, stdio: 'pipe', encoding: 'utf8', shell: isCmdShim
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
};

// Resolve the tool's local bin instead of spawning `npx <tool>`: faster, and
// portable — `npx` is a .cmd shim on Windows and fails there without shell.
// Only spawn what the platform can execute: on Windows the extension-less
// shim is a POSIX shell script and equally fails without a shell, so pick the
// .cmd shim there (spawned with shell in run()).
const binPath = (cwd: string, binName: string): string | undefined => {
  const binDir = path.join(cwd, 'node_modules', '.bin');
  const candidates = process.platform === 'win32' ? [`${binName}.cmd`] : [binName];
  for (const candidate of candidates) {
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
// ESLint v9 only honours flat config; legacy .eslintrc* files are ignored and
// eslint still exits non-zero, so they must not count as "has config" (#74).
const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs'];

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
