import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { withTempDir } from './helpers.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const distCli = path.join(repoRoot, 'dist', 'cli.js');

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="hello" type="xs:string"/>
</xs:schema>`;

// Windows needs elevated privileges for symlinks; CI runs on Linux.
describe.skipIf(process.platform === 'win32')('CLI e2e through the npm bin symlink (#80)', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], {
      cwd: repoRoot, stdio: 'pipe', shell: process.platform === 'win32'
    });
  }, 180_000);

  // npm installs the bin as node_modules/.bin/xsd-to-zod -> dist/cli.js; the
  // in-process tests only call main() directly, so spawn the real thing.
  it('runs the built CLI when invoked through the bin symlink', () => {
    withTempDir((dir) => {
      const binDir = path.join(dir, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      const link = path.join(binDir, 'xsd-to-zod');
      fs.symlinkSync(distCli, link);

      const xsdFile = path.join(dir, 'test.xsd');
      fs.writeFileSync(xsdFile, XSD);

      const out = execFileSync('node', [link, xsdFile, '-o', dir, '--name', 'my'], { encoding: 'utf8' });
      expect(out).toContain('Wrote');
      expect(fs.existsSync(path.join(dir, 'my.zod.ts'))).toBe(true);
      // Single artifact — no .meta.ts anymore.
      expect(fs.existsSync(path.join(dir, 'my.meta.ts'))).toBe(false);
    });
  }, 60_000);
});
