import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { irToZod, parseXsd } from '../src/index.js';
import { discoverCuratedCases } from './helpers.js';

// Smoke test: generated .zod.ts output must typecheck under the project's strict
// settings for every curated fixture. Catches codegen bugs that produce invalid
// TypeScript (#70 class) which runtime tests only see as dynamic import failures.
// All files are checked in a single tsc invocation — one process for the whole
// corpus keeps this fast, and tsc's output names the offending file on failure.
// Files live in the gitignored .xsd2zod-tests dotdir so the `xsd2zod` import in
// generated code resolves via package self-reference (not possible from inside
// node_modules).
describe('generated code typechecks', () => {
  const cases = discoverCuratedCases();

  it(`tsc --noEmit passes for all ${cases.length} curated cases`, () => {
    const baseDir = path.resolve('.xsd2zod-tests');
    fs.mkdirSync(baseDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(baseDir, 'tsc-smoke-'));
    try {
      const files: string[] = [];
      for (const c of cases) {
        const { schemas } = irToZod(parseXsd(c.xsdFiles));
        const file = path.join(dir, `${c.name.replaceAll('/', '--')}.zod.ts`);
        fs.writeFileSync(file, schemas);
        files.push(file);
      }

      const tsc = path.resolve('node_modules/.bin/tsc');
      const result = spawnSync(
        tsc,
        [
          '--noEmit',
          '--ignoreConfig',
          '--strict',
          '--skipLibCheck',
          '--target', 'es2022',
          '--module', 'nodenext',
          '--moduleResolution', 'nodenext',
          ...files,
        ],
        { encoding: 'utf8' }
      );

      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
