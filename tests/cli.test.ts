import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdValidate, loadMetadataFromMetaTs, main, parseArgs, parseValidateArgs, USAGE, VALIDATE_USAGE } from '../src/cli.js';
import { buildRuntimeMetadata } from '../src/irToZod.js';
import { parseXsd } from '../src/parseXsd.js';
import { withTempDir } from './helpers.js';

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="hello" type="xs:string"/>
</xs:schema>`;

// Runs the CLI in-process, capturing console output — much faster and less
// fragile than spawning `npx tsx` per test (#83).
const runCli = (args: string[]): { code: number; stdout: string; stderr: string } => {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  try {
    return { code: main(args), stdout: logs.join('\n'), stderr: errors.join('\n') };
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
});

describe('CLI e2e', () => {
  it('prints USAGE on --help', () => {
    const r = runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(USAGE.trim());
  });

  it('exits with error when no files given', () => {
    const r = runCli([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('at least one XSD file');
  });

  it('exits with error when output dir does not exist', () => {
    withTempDir((dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      fs.writeFileSync(xsdFile, XSD);
      const fakeDir = path.join(dir, 'does-not-exist');
      const r = runCli([xsdFile, '-o', fakeDir]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('output directory does not exist');
    });
  });

  it('generates .zod.ts and .meta.ts files', () => {
    withTempDir((dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      fs.writeFileSync(xsdFile, XSD);
      const r = runCli([xsdFile, '-o', dir, '--name', 'my']);

      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Wrote');
      expect(fs.existsSync(path.join(dir, 'my.zod.ts'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'my.meta.ts'))).toBe(true);
    });
  });

  it('defaults output name to input file stem', () => {
    withTempDir((dir) => {
      const xsdFile = path.join(dir, 'my-stem.xsd');
      fs.writeFileSync(xsdFile, XSD);
      const r = runCli([xsdFile, '-o', dir]);

      expect(r.code).toBe(0);
      expect(fs.existsSync(path.join(dir, 'my-stem.zod.ts'))).toBe(true);
    });
  });
});

describe('parseValidateArgs', () => {
  it('parses xsd + xml', () => {
    const r = parseValidateArgs(['data.xml', '-x', 'schema.xsd']);
    expect(r).toMatchObject({ ok: true, help: false, xmlFile: 'data.xml', xsdFile: 'schema.xsd', metadataFile: undefined, root: undefined });
  });

  it('parses short flags with xsd', () => {
    const r = parseValidateArgs(['data.xml', '-x', 'schema.xsd', '-r', '{urn:test}root']);
    expect(r).toMatchObject({ ok: true, xmlFile: 'data.xml', xsdFile: 'schema.xsd', metadataFile: undefined, root: '{urn:test}root' });
  });

  it('parses long flags with metadata', () => {
    const r = parseValidateArgs(['data.xml', '--metadata', 'meta.ts', '--root', '{urn:test}root']);
    expect(r).toMatchObject({ ok: true, xmlFile: 'data.xml', xsdFile: undefined, metadataFile: 'meta.ts', root: '{urn:test}root' });
  });

  it('rejects --xsd and --metadata together', () => {
    const r = parseValidateArgs(['data.xml', '--xsd', 'schema.xsd', '--metadata', 'meta.ts']);
    expect(r).toEqual({ ok: false, error: '--xsd and --metadata are mutually exclusive' });
  });

  it('rejects missing xml file', () => {
    const r = parseValidateArgs(['--xsd', 'schema.xsd']);
    expect(r).toEqual({ ok: false, error: 'xml-file is required' });
  });

  it('rejects missing source', () => {
    const r = parseValidateArgs(['data.xml']);
    expect(r).toEqual({ ok: false, error: 'either --xsd or --metadata is required' });
  });

  it('rejects --xsd without value', () => {
    const r = parseValidateArgs(['data.xml', '--xsd', '--metadata']);
    expect(r).toEqual({ ok: false, error: '--xsd/-x requires a file argument' });
  });

  it('rejects --metadata without value', () => {
    const r = parseValidateArgs(['data.xml', '--metadata', '--xsd']);
    expect(r).toEqual({ ok: false, error: '--metadata/-m requires a file argument' });
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
  it('prints VALIDATE_USAGE on validate --help', () => {
    const r = runCli(['validate', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(VALIDATE_USAGE.trim());
  });

  it('validates XML against XSD (success)', () => {
    withTempDir((dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      const xmlFile = path.join(dir, 'test.xml');
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="root" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><root xmlns="urn:test">hello</root>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);

      const r = runCli(['validate', xmlFile, '-x', xsdFile]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Validation passed');
      expect(r.stdout).toContain('hello');
    });
  });

  it('validates XML against XSD (failure — wrong root element)', () => {
    withTempDir((dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      const xmlFile = path.join(dir, 'test.xml');
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="root" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><wrong xmlns="urn:test">hello</wrong>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);

      const r = runCli(['validate', xmlFile, '-x', xsdFile]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Validation failed');
    });
  });

  it('validates XML against metadata file (success)', () => {
    withTempDir((dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      const xmlFile = path.join(dir, 'test.xml');
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="greeting" type="xs:string"/>
</xs:schema>`;
      fs.writeFileSync(xsdFile, xsd);

      const ir = parseXsd([xsdFile]);
      const meta = buildRuntimeMetadata(ir);
      const metaTs = `// AUTO-GENERATED — DO NOT EDIT\nexport const runtimeMetadata = ${JSON.stringify(meta, null, 2)} as const;\n`;
      const metaFile = path.join(dir, 'test.meta.ts');
      fs.writeFileSync(metaFile, metaTs);

      const xml = '<?xml version="1.0"?><greeting xmlns="urn:test">hi</greeting>';
      fs.writeFileSync(xmlFile, xml);

      const r = runCli(['validate', xmlFile, '-m', metaFile]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Validation passed');
    });
  });

  it('fails when xml file does not exist', () => {
    const r = runCli(['validate', '/nonexistent.xml', '-x', '/nonexistent.xsd']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('xml file not found');
  });

  it('fails when xsd file does not exist', () => {
    withTempDir((dir) => {
      const xmlFile = path.join(dir, 'test.xml');
      fs.writeFileSync(xmlFile, '<root/>');
      const r = runCli(['validate', xmlFile, '-x', '/nonexistent.xsd']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('xsd file not found');
    });
  });

  it('fails when metadata file does not exist', () => {
    withTempDir((dir) => {
      const xmlFile = path.join(dir, 'test.xml');
      fs.writeFileSync(xmlFile, '<root/>');
      const r = runCli(['validate', xmlFile, '-m', '/nonexistent.meta.ts']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('metadata file not found');
    });
  });

  it('fails with multiple root elements and no --root', () => {
    withTempDir((dir) => {
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
      const r = runCli(['validate', xmlFile, '-x', xsdFile]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('multiple root elements found');
    });
  });

  it('fails with invalid metadata file', () => {
    withTempDir((dir) => {
      const metaFile = path.join(dir, 'bad.meta.ts');
      const xmlFile = path.join(dir, 'test.xml');
      fs.writeFileSync(metaFile, 'not valid ts');
      fs.writeFileSync(xmlFile, '<root/>');
      const r = runCli(['validate', xmlFile, '-m', metaFile]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('failed to parse metadata');
    });
  });
});

describe('loadMetadataFromMetaTs', () => {
  it('parses a valid .meta.ts file', () => {
    withTempDir((dir) => {
      const meta = {
        types: {},
        roots: [{ rootElement: '{urn:test}root' as const, typeName: '{urn:test}RootType' as const, fields: [] }]
      };
      const content = `// AUTO-GENERATED — DO NOT EDIT\nexport const runtimeMetadata = ${JSON.stringify(meta, null, 2)} as const;\n`;
      const metaFile = path.join(dir, 'test.meta.ts');
      fs.writeFileSync(metaFile, content);
      const result = loadMetadataFromMetaTs(metaFile);
      expect(result).toEqual(meta);
    });
  });

  it('throws on invalid metadata', () => {
    withTempDir((dir) => {
      const metaFile = path.join(dir, 'invalid.meta.ts');
      fs.writeFileSync(metaFile, 'not json');
      expect(() => loadMetadataFromMetaTs(metaFile)).toThrow('failed to parse metadata');
    });
  });
});

describe('cmdValidate unit', () => {
  it('throws when args are invalid', () => {
    expect(() => cmdValidate(['--xsd'])).toThrow('--xsd/-x requires a file argument');
  });

  it('throws when xml file not found', () => {
    expect(() => cmdValidate(['/nonexistent.xml', '--xsd', '/nonexistent.xsd'])).toThrow('xml file not found');
  });

  it('throws when xsd file not found', () => {
    withTempDir((dir) => {
      const xmlFile = path.join(dir, 'test.xml');
      fs.writeFileSync(xmlFile, '<root/>');
      expect(() => cmdValidate([xmlFile, '--xsd', '/nonexistent.xsd'])).toThrow('xsd file not found');
    });
  });

  it('throws when metadata file not found', () => {
    withTempDir((dir) => {
      const xmlFile = path.join(dir, 'test.xml');
      fs.writeFileSync(xmlFile, '<root/>');
      expect(() => cmdValidate([xmlFile, '--metadata', '/nonexistent.meta.ts'])).toThrow('metadata file not found');
    });
  });

  it('validates XML against XSD successfully', () => {
    withTempDir((dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      const xmlFile = path.join(dir, 'test.xml');
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="root" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><root xmlns="urn:test">hello</root>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);
      expect(() => cmdValidate([xmlFile, '--xsd', xsdFile])).not.toThrow();
    });
  });

  it('throws when XML does not match XSD', () => {
    withTempDir((dir) => {
      const xsdFile = path.join(dir, 'test.xsd');
      const xmlFile = path.join(dir, 'test.xml');
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="root" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><wrong xmlns="urn:test">hello</wrong>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);
      expect(() => cmdValidate([xmlFile, '--xsd', xsdFile])).toThrow('Validation failed');
    });
  });

  it('throws when metadata has no roots', () => {
    withTempDir((dir) => {
      const xmlFile = path.join(dir, 'test.xml');
      const metaFile = path.join(dir, 'test.meta.ts');
      fs.writeFileSync(xmlFile, '<root/>');
      const meta = { types: {}, roots: [] };
      const content = `export const runtimeMetadata = ${JSON.stringify(meta)} as const;`;
      fs.writeFileSync(metaFile, content);
      expect(() => cmdValidate([xmlFile, '--metadata', metaFile])).toThrow('no root elements in metadata');
    });
  });

  it('throws when --root element not found in metadata', () => {
    withTempDir((dir) => {
      const xmlFile = path.join(dir, 'test.xml');
      const metaFile = path.join(dir, 'test.meta.ts');
      fs.writeFileSync(xmlFile, '<root/>');
      const meta = { types: {}, roots: [{ rootElement: '{urn:x}foo', typeName: '{urn:x}Foo', fields: [] }] };
      const content = `export const runtimeMetadata = ${JSON.stringify(meta)} as const;`;
      fs.writeFileSync(metaFile, content);
      expect(() => cmdValidate([xmlFile, '--metadata', metaFile, '--root', '{urn:x}bar'])).toThrow('root element {urn:x}bar not found in metadata');
    });
  });

  it('throws when metadata has multiple roots and no --root', () => {
    withTempDir((dir) => {
      const xmlFile = path.join(dir, 'test.xml');
      const metaFile = path.join(dir, 'test.meta.ts');
      fs.writeFileSync(xmlFile, '<root/>');
      const meta = {
        types: {},
        roots: [
          { rootElement: '{urn:x}foo', typeName: '{urn:x}Foo', fields: [] },
          { rootElement: '{urn:x}bar', typeName: '{urn:x}Bar', fields: [] }
        ]
      };
      const content = `export const runtimeMetadata = ${JSON.stringify(meta)} as const;`;
      fs.writeFileSync(metaFile, content);
      expect(() => cmdValidate([xmlFile, '--metadata', metaFile])).toThrow('multiple root elements found');
    });
  });

  it('throws on invalid metadata file format', () => {
    withTempDir((dir) => {
      const xmlFile = path.join(dir, 'test.xml');
      const metaFile = path.join(dir, 'test.meta.ts');
      fs.writeFileSync(xmlFile, '<root/>');
      fs.writeFileSync(metaFile, 'not valid ts');
      expect(() => cmdValidate([xmlFile, '--metadata', metaFile])).toThrow('failed to parse metadata');
    });
  });

  it('handles --help', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdValidate(['--help']);
    expect(logSpy).toHaveBeenCalledWith(VALIDATE_USAGE);
    logSpy.mockRestore();
  });
});
