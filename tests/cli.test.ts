import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { cmdValidate, isDirectInvocation, main, parseArgs, parseValidateArgs, USAGE, VALIDATE_USAGE } from '../src/cli.js';
import { withTempDir, withTempDirAsync } from './helpers.js';

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="hello" type="xs:string"/>
</xs:schema>`;

// Runs the CLI in-process, capturing console output — much faster and less
// fragile than spawning `npx tsx` per test (#83).
const runCli = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  try {
    return { code: await main(args), stdout: logs.join('\n'), stderr: errors.join('\n') };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
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

  it('rejects unknown options instead of treating them as files (#82)', () => {
    expect(parseArgs(['a.xsd', '--fromat'])).toEqual({ ok: false, error: 'unknown option: --fromat' });
    expect(parseArgs(['--out=dir', 'a.xsd'])).toEqual({ ok: false, error: 'unknown option: --out=dir' });
  });

  it('rejects flag values that look like options (#82)', () => {
    expect(parseArgs(['a.xsd', '--out', '-x'])).toEqual({ ok: false, error: '--out/-o requires a directory argument' });
  });

  it('rejects --name with path separators (#82)', () => {
    const err = '--name/-n must be a plain file name without path separators';
    expect(parseArgs(['a.xsd', '-n', '../../somewhere/x'])).toEqual({ ok: false, error: err });
    expect(parseArgs(['a.xsd', '--name', 'sub/dir'])).toEqual({ ok: false, error: err });
    expect(parseArgs(['a.xsd', '--name', '..'])).toEqual({ ok: false, error: err });
  });

  it('rejects inputs that yield an empty output stem (#82)', () => {
    const r = parseArgs(['.xsd']);
    expect(r).toEqual({ ok: false, error: 'cannot derive an output name from the input file; pass --name/-n' });
  });
});

describe('CLI e2e', () => {
  it('prints USAGE on --help', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(USAGE.trim());
  });

  it('exits with error when no files given', async () => {
    const r = await runCli([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('at least one XSD file');
  });

  it('exits with error when output dir does not exist', async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      fs.writeFileSync(xsdFile, XSD);
      const fakeDir = path.join(dir, 'does-not-exist');
      const r = await runCli([xsdFile, '-o', fakeDir]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('output directory does not exist');
    });
  });

  it('generates a single .zod.ts artifact (no .meta.ts)', async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      fs.writeFileSync(xsdFile, XSD);
      const r = await runCli([xsdFile, '-o', dir, '--name', 'my']);

      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Wrote');
      expect(fs.existsSync(path.join(dir, 'my.zod.ts'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'my.meta.ts'))).toBe(false);
    });
  });

  it('defaults output name to input file stem', async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, 'my-stem.xsd');
      fs.writeFileSync(xsdFile, XSD);
      const r = await runCli([xsdFile, '-o', dir]);

      expect(r.code).toBe(0);
      expect(fs.existsSync(path.join(dir, 'my-stem.zod.ts'))).toBe(true);
    });
  });

  it('reports missing input files in the CLI error style instead of a stack trace (#82)', async () => {
    await withTempDirAsync(async (dir) => {
      const r = await runCli([path.join(dir, 'missing.xsd'), '-o', dir]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/^error: /);
      expect(r.stderr).not.toContain('at ');
    });
  });

  it('reports malformed XML in the CLI error style (#82)', async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, 'broken.xsd');
      fs.writeFileSync(xsdFile, '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element');
      const r = await runCli([xsdFile, '-o', dir]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/^error: /);
    });
  });

  it('warns about schema references that could not be resolved (#77)', async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      fs.writeFileSync(xsdFile, `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element ref="t:missing"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`);
      const r = await runCli([xsdFile, '-o', dir]);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('warning: unresolved element ref "{urn:test}missing"');
    });
  });
});

describe('isDirectInvocation (#80)', () => {
  it('resolves symlinks before comparing', () => {
    withTempDir((dir) => {
      const real = path.join(dir, 'cli.js');
      fs.writeFileSync(real, '// bin\n');
      const link = path.join(dir, 'xsd2zod');
      fs.symlinkSync(real, link);
      expect(isDirectInvocation(link, pathToFileURL(real).href)).toBe(true);
      expect(isDirectInvocation(real, pathToFileURL(real).href)).toBe(true);
    });
  });

  it('returns false for other scripts, missing argv1 and dangling paths', () => {
    withTempDir((dir) => {
      const real = path.join(dir, 'cli.js');
      const other = path.join(dir, 'other.js');
      fs.writeFileSync(real, '// bin\n');
      fs.writeFileSync(other, '// other\n');
      expect(isDirectInvocation(other, pathToFileURL(real).href)).toBe(false);
      expect(isDirectInvocation(undefined, pathToFileURL(real).href)).toBe(false);
      expect(isDirectInvocation(path.join(dir, 'gone.js'), pathToFileURL(real).href)).toBe(false);
    });
  });
});

describe('parseValidateArgs', () => {
  it('parses xsd + xml', () => {
    const r = parseValidateArgs(['data.xml', '-x', 'schema.xsd']);
    expect(r).toMatchObject({ ok: true, help: false, xmlFile: 'data.xml', xsdFile: 'schema.xsd', root: undefined });
  });

  it('parses short flags with xsd', () => {
    const r = parseValidateArgs(['data.xml', '-x', 'schema.xsd', '-r', '{urn:test}root']);
    expect(r).toMatchObject({ ok: true, xmlFile: 'data.xml', xsdFile: 'schema.xsd', root: '{urn:test}root' });
  });

  it('rejects --metadata as an unknown option', () => {
    const r = parseValidateArgs(['data.xml', '--metadata', 'meta.ts']);
    expect(r).toEqual({ ok: false, error: 'unknown option: --metadata' });
  });

  it('rejects missing xml file', () => {
    const r = parseValidateArgs(['--xsd', 'schema.xsd']);
    expect(r).toEqual({ ok: false, error: 'xml-file is required' });
  });

  it('rejects missing --xsd', () => {
    const r = parseValidateArgs(['data.xml']);
    expect(r).toEqual({ ok: false, error: '--xsd is required' });
  });

  it('rejects --xsd without value', () => {
    const r = parseValidateArgs(['data.xml', '--xsd', '--root']);
    expect(r).toEqual({ ok: false, error: '--xsd/-x requires a file argument' });
  });

  it('rejects --root without value', () => {
    const r = parseValidateArgs(['data.xml', '--xsd', 's.xsd', '--root', '--help']);
    expect(r).toEqual({ ok: false, error: '--root/-r requires a QName argument' });
  });

  it('returns help', () => {
    expect(parseValidateArgs(['--help'])).toEqual({ ok: true, help: true });
    expect(parseValidateArgs(['-h'])).toEqual({ ok: true, help: true });
  });
});

describe('CLI validate e2e', () => {
  it('prints VALIDATE_USAGE on validate --help', async () => {
    const r = await runCli(['validate', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(VALIDATE_USAGE.trim());
  });

  it('validates XML against XSD (success)', async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      const xmlFile = path.join(dir, 'test.xml');
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="root" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><root xmlns="urn:test">hello</root>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);

      const r = await runCli(['validate', xmlFile, '-x', xsdFile]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Validation passed');
      expect(r.stdout).toContain('hello');
    });
  });

  it('validates XML against XSD (failure — wrong root element)', async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      const xmlFile = path.join(dir, 'test.xml');
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="root" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><wrong xmlns="urn:test">hello</wrong>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);

      const r = await runCli(['validate', xmlFile, '-x', xsdFile]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Validation failed');
    });
  });

  it('fails when xml file does not exist', async () => {
    const r = await runCli(['validate', '/nonexistent.xml', '-x', '/nonexistent.xsd']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('xml file not found');
  });

  it('fails when xsd file does not exist', async () => {
    await withTempDirAsync(async (dir) => {
      const xmlFile = path.join(dir, 'test.xml');
      fs.writeFileSync(xmlFile, '<root/>');
      const r = await runCli(['validate', xmlFile, '-x', '/nonexistent.xsd']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('xsd file not found');
    });
  });

  it('fails with multiple root elements and no --root', async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      const xmlFile = path.join(dir, 'test.xml');
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="foo" type="xs:string"/>
  <xs:element name="bar" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><foo xmlns="urn:test">hi</foo>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);
      const r = await runCli(['validate', xmlFile, '-x', xsdFile]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('multiple root elements found');
    });
  });

  it('validates with --root selecting among multiple roots', async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      const xmlFile = path.join(dir, 'test.xml');
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="foo" type="xs:string"/>
  <xs:element name="bar" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><bar xmlns="urn:test">hi</bar>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);
      const r = await runCli(['validate', xmlFile, '-x', xsdFile, '--root', '{urn:test}bar']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Validation passed');
    });
  });

  it('fails when --root does not match any schema root', async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      const xmlFile = path.join(dir, 'test.xml');
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="foo" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><foo xmlns="urn:test">hi</foo>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);
      const r = await runCli(['validate', xmlFile, '-x', xsdFile, '--root', '{urn:test}baz']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('root element {urn:test}baz not found');
    });
  });

  it('fails when the schema declares no root elements', async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      const xmlFile = path.join(dir, 'test.xml');
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:complexType name="Orphan">
    <xs:sequence>
      <xs:element name="field" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
</xs:schema>`;
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, '<root/>');
      const r = await runCli(['validate', xmlFile, '-x', xsdFile]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('no root elements found in schema');
    });
  });
});

describe('cmdValidate unit', () => {
  it('throws when args are invalid', async () => {
    await expect(cmdValidate(['--xsd'])).rejects.toThrow('--xsd/-x requires a file argument');
  });

  it('throws when xml file not found', async () => {
    await expect(cmdValidate(['/nonexistent.xml', '--xsd', '/nonexistent.xsd'])).rejects.toThrow('xml file not found');
  });

  it('throws when xsd file not found', async () => {
    withTempDir((dir) => {
      const xmlFile = path.join(dir, 'test.xml');
      fs.writeFileSync(xmlFile, '<root/>');
      return expect(cmdValidate([xmlFile, '--xsd', '/nonexistent.xsd'])).rejects.toThrow('xsd file not found');
    });
  });

  it('validates XML against XSD successfully', async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      const xmlFile = path.join(dir, 'test.xml');
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="root" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><root xmlns="urn:test">hello</root>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);
      await expect(cmdValidate([xmlFile, '--xsd', xsdFile])).resolves.toBeUndefined();
    });
  });

  it('throws when XML does not match XSD', async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      const xmlFile = path.join(dir, 'test.xml');
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="root" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><wrong xmlns="urn:test">hello</wrong>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);
      await expect(cmdValidate([xmlFile, '--xsd', xsdFile])).rejects.toThrow('Validation failed');
    });
  });

  it('handles --help', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdValidate(['--help']);
    expect(logSpy).toHaveBeenCalledWith(VALIDATE_USAGE);
    logSpy.mockRestore();
  });
});
