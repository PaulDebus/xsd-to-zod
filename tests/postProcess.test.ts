import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPostGenerationFormatting } from '../src/index.js';
import { withTempDir } from './helpers.js';

// Fake formatter bins: shell scripts that log their invocation into the temp
// project dir, so tests can assert which tools ran (and with which files).
const withProject = (
  tools: string[],
  configs: string[],
  fn: (ctx: { cwd: string; log: string }) => void
): void => {
  withTempDir((cwd) => {
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
    fn({ cwd, log: path.join(cwd, 'formatter.log') });
  });
};

const readLog = (log: string): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);

describe('runPostGenerationFormatting (#74)', () => {
  it('does nothing when there are no files', () => {
    withProject(['eslint'], ['eslint.config.js'], ({ cwd, log }) => {
      runPostGenerationFormatting([], cwd);
      expect(readLog(log)).toEqual([]);
    });
  });

  it('runs biome format + lint when biome.json exists', () => {
    withProject(['biome', 'eslint'], ['biome.json', 'eslint.config.js'], ({ cwd, log }) => {
      runPostGenerationFormatting(['out.zod.ts'], cwd);
      expect(readLog(log)).toEqual(['biome format --write out.zod.ts', 'biome lint --write out.zod.ts']);
    });
  });

  it('does not fall through from prettier to eslint', () => {
    withProject(['prettier', 'eslint'], ['.prettierrc', 'eslint.config.js'], ({ cwd, log }) => {
      runPostGenerationFormatting(['out.zod.ts'], cwd);
      expect(readLog(log)).toEqual(['prettier --write out.zod.ts']);
    });
  });

  it('skips eslint when no eslint config exists instead of crashing', () => {
    withProject(['eslint'], [], ({ cwd, log }) => {
      expect(() => runPostGenerationFormatting(['out.zod.ts'], cwd)).not.toThrow();
      expect(readLog(log)).toEqual([]);
    });
  });

  it('skips eslint when only a legacy .eslintrc exists — ESLint v9 ignores it (#74)', () => {
    withProject(['eslint'], ['.eslintrc.json'], ({ cwd, log }) => {
      expect(() => runPostGenerationFormatting(['out.zod.ts'], cwd)).not.toThrow();
      expect(readLog(log)).toEqual([]);
    });
  });

  it('runs eslint --fix when an eslint config exists', () => {
    withProject(['eslint'], ['eslint.config.js'], ({ cwd, log }) => {
      runPostGenerationFormatting(['out.zod.ts'], cwd);
      expect(readLog(log)).toEqual(['eslint --fix out.zod.ts']);
    });
  });

  it('propagates formatter failures', () => {
    withTempDir((cwd) => {
      const binDir = path.join(cwd, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      const bin = path.join(binDir, 'prettier');
      fs.writeFileSync(bin, '#!/bin/sh\necho boom >&2\nexit 1\n');
      fs.chmodSync(bin, 0o755);
      fs.writeFileSync(path.join(cwd, '.prettierrc'), '{}\n');
      expect(() => runPostGenerationFormatting(['out.zod.ts'], cwd)).toThrow(/prettier.*failed.*boom/s);
    });
  });
});
