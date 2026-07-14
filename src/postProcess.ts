import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const run = (command: string, args: string[], cwd: string): void => {
  const result = spawnSync(command, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
};

const hasBin = (cwd: string, binName: string): boolean => {
  const binPath = path.join(cwd, 'node_modules', '.bin', binName);
  return fs.existsSync(binPath);
};

export const runPostGenerationFormatting = (generatedFiles: string[], cwd = process.cwd()): void => {
  if (generatedFiles.length === 0) {
    return;
  }

  const biomeConfig = path.join(cwd, 'biome.json');
  if (fs.existsSync(biomeConfig) && hasBin(cwd, 'biome')) {
    run('npx', ['biome', 'format', '--write', ...generatedFiles], cwd);
    run('npx', ['biome', 'lint', '--write', ...generatedFiles], cwd);
    return;
  }

  const prettierConfigCandidates = ['.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js'];
  const hasPrettierConfig = prettierConfigCandidates.some((candidate) => fs.existsSync(path.join(cwd, candidate)));
  if (hasPrettierConfig && hasBin(cwd, 'prettier')) {
    run('npx', ['prettier', '--write', ...generatedFiles], cwd);
  }

  if (hasBin(cwd, 'eslint')) {
    run('npx', ['eslint', '--fix', ...generatedFiles], cwd);
  }
};
