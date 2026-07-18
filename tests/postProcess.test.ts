import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPostGenerationFormatting } from '../src/index.js';

// Fake formatter bins: shell scripts that log their invocation into the temp
// project dir, so tests can assert which tools ran (and with which files).
const setupProject = (tools: string[], configs: string[]): { cwd: string; log: string; cleanup: () => void } => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'postprocess-'));
  const binDir = path.join(cwd, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const tool of tools) {
    const bin = path.join(binDir, tool);
    fs.writeFileSync(bin, `#!/bin/sh\necho "$(basename "$0") $@" >> formatter.log\n`);
    fs.chmodSync(bin, 0o755);
  }
  for (const config of configs) {
    fs.writeFileSync(path.join(cwd, config), '{}\n');
  }
  return {
    cwd,
    log: path.join(cwd, 'formatter.log'),
    cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }),
  };
};

const readLog = (log: string): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);

describe('runPostGenerationFormatting (#74)', () => {
  it('does nothing when there are no files', () => {
    const { cwd, log, cleanup } = setupProject(['eslint'], ['eslint.config.js']);
    try {
      runPostGenerationFormatting([], cwd);
      expect(readLog(log)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('runs biome format + lint when biome.json exists', () => {
    const { cwd, log, cleanup } = setupProject(['biome', 'eslint'], ['biome.json', 'eslint.config.js']);
    try {
      runPostGenerationFormatting(['out.zod.ts'], cwd);
      expect(readLog(log)).toEqual(['biome format --write out.zod.ts', 'biome lint --write out.zod.ts']);
    } finally {
      cleanup();
    }
  });

  it('does not fall through from prettier to eslint', () => {
    const { cwd, log, cleanup } = setupProject(['prettier', 'eslint'], ['.prettierrc', 'eslint.config.js']);
    try {
      runPostGenerationFormatting(['out.zod.ts'], cwd);
      expect(readLog(log)).toEqual(['prettier --write out.zod.ts']);
    } finally {
      cleanup();
    }
  });

  it('skips eslint when no eslint config exists instead of crashing', () => {
    const { cwd, log, cleanup } = setupProject(['eslint'], []);
    try {
      expect(() => runPostGenerationFormatting(['out.zod.ts'], cwd)).not.toThrow();
      expect(readLog(log)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('runs eslint --fix when an eslint config exists', () => {
    const { cwd, log, cleanup } = setupProject(['eslint'], ['eslint.config.js']);
    try {
      runPostGenerationFormatting(['out.zod.ts'], cwd);
      expect(readLog(log)).toEqual(['eslint --fix out.zod.ts']);
    } finally {
      cleanup();
    }
  });

  it('propagates formatter failures', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'postprocess-'));
    const binDir = path.join(cwd, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, 'prettier');
    fs.writeFileSync(bin, '#!/bin/sh\necho boom >&2\nexit 1\n');
    fs.chmodSync(bin, 0o755);
    fs.writeFileSync(path.join(cwd, '.prettierrc'), '{}\n');
    try {
      expect(() => runPostGenerationFormatting(['out.zod.ts'], cwd)).toThrow(/prettier.*failed.*boom/s);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
