import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, USAGE } from '../src/cli.js';

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="hello" type="xs:string"/>
</xs:schema>`;

const withTempDir = (fn: (dir: string) => void): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsd2zod-cli-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe('parseArgs', () => {
  it('parses help flag', () => {
    expect(parseArgs(['--help'])).toEqual({ ok: true, help: true });
    expect(parseArgs(['-h'])).toEqual({ ok: true, help: true });
  });

  it('parses files', () => {
    const r = parseArgs(['schema.xsd']);
    expect(r).toMatchObject({ ok: true, help: false, files: ['schema.xsd'] });
  });

  it('parses multiple files with --name', () => {
    const r = parseArgs(['a.xsd', 'b.xsd', '--name', 'all']);
    expect(r).toMatchObject({ ok: true, help: false, files: ['a.xsd', 'b.xsd'], name: 'all' });
  });

  it('defaults name to first file stem', () => {
    const r = parseArgs(['/some/path/my-schema.xsd']);
    expect(r).toMatchObject({ ok: true, name: 'my-schema' });
  });

  it('requires --name when more than one file', () => {
    const r = parseArgs(['a.xsd', 'b.xsd']);
    expect(r).toEqual({ ok: false, error: '--name/-n is required when processing multiple XSD files' });
  });

  it('parses --name', () => {
    const r = parseArgs(['a.xsd', 'b.xsd', '--name', 'foo']);
    expect(r).toMatchObject({ ok: true, name: 'foo' });
  });

  it('parses --out', () => {
    const r = parseArgs(['a.xsd', '--out', 'some/dir']);
    expect(r).toMatchObject({ ok: true, out: 'some/dir' });
  });

  it('rejects --out without value', () => {
    const r = parseArgs(['a.xsd', '--out', '--name']);
    expect(r).toEqual({ ok: false, error: '--out/-o requires a directory argument' });
  });

  it('parses --format', () => {
    const r = parseArgs(['a.xsd', '--format']);
    expect(r).toMatchObject({ ok: true, format: true });
  });

  it('rejects missing files', () => {
    const r = parseArgs([]);
    expect(r).toEqual({ ok: false, error: 'at least one XSD file is required' });
  });

  it('rejects --name without value', () => {
    const r = parseArgs(['a.xsd', '--name', '--out']);
    expect(r).toEqual({ ok: false, error: '--name/-n requires a string argument' });
  });
});

describe('CLI e2e', () => {
  const cliEntry = path.resolve('src/cli.ts');

  it('prints USAGE on --help', () => {
    const out = execSync(`npx tsx ${cliEntry} --help`, { encoding: 'utf8' });
    expect(out.trim()).toBe(USAGE.trim());
  });

  it('exits with error when no files given', () => {
    try {
      execSync(`npx tsx ${cliEntry}`, { encoding: 'utf8', stdio: 'pipe' });
      expect.fail('should have thrown');
    } catch (e: unknown) {
      const err = e as Error & { stderr?: Buffer };
      expect(err.message).toContain('at least one XSD file');
    }
  });

  it('exits with error when output dir does not exist', () => {
    withTempDir((dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      fs.writeFileSync(xsdFile, XSD);
      const fakeDir = path.join(dir, 'does-not-exist');
      try {
        execSync(`npx tsx ${cliEntry} ${xsdFile} -o ${fakeDir}`, { encoding: 'utf8', stdio: 'pipe' });
        expect.fail('should have thrown');
      } catch (e: unknown) {
        const err = e as Error & { stderr?: Buffer };
        expect(err.message).toContain('output directory does not exist');
      }
    });
  });

  it('generates .zod.ts and .meta.ts files', () => {
    withTempDir((dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      fs.writeFileSync(xsdFile, XSD);
      const out = execSync(`npx tsx ${cliEntry} ${xsdFile} -o ${dir} --name my`, { encoding: 'utf8' });

      expect(out).toContain('Wrote');
      expect(fs.existsSync(path.join(dir, 'my.zod.ts'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'my.meta.ts'))).toBe(true);
    });
  });

  it('defaults output name to input file stem', () => {
    withTempDir((dir) => {
      const xsdFile = path.join(dir, 'my-stem.xsd');
      fs.writeFileSync(xsdFile, XSD);
      execSync(`npx tsx ${cliEntry} ${xsdFile} -o ${dir}`, { encoding: 'utf8' });

      expect(fs.existsSync(path.join(dir, 'my-stem.zod.ts'))).toBe(true);
    });
  });
});
