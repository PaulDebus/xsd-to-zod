import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readXmlFile } from './helpers.js';

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" elementFormDefault="qualified">
  <xs:element name="doc">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="count" type="xs:int"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

describe('validateXml (conformance tier)', () => {
  it('returns valid for a conforming document', async () => {
    const { validateXml } = await import('../src/validate.js');
    await expect(validateXml('<doc><count>1</count></doc>', XSD)).resolves.toEqual({ valid: true });
  });

  it('returns line-numbered issues for a non-conforming document', async () => {
    const { validateXml } = await import('../src/validate.js');
    const result = await validateXml('<doc>\n  <count>abc</count>\n</doc>', XSD);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0].message).toContain('count');
      expect(result.issues[0].line).toBe(2);
    }
  });

  it('throws for malformed XML and broken schemas (not instance-invalidity)', async () => {
    const { validateXml } = await import('../src/validate.js');
    await expect(validateXml('<doc><count></doc>', XSD)).rejects.toThrow();
    await expect(validateXml('<doc/>', 'not xml at all')).rejects.toThrow();
  });

  it('resolves relative xs:include against the schema url', async () => {
    const { validateXml } = await import('../src/validate.js');
    const xsdFile = path.resolve('testdata/curated/imports/include.xsd');
    const xmlFile = path.resolve('testdata/curated/imports/include.xml');
    const result = await validateXml(readXmlFile(xmlFile), readXmlFile(xsdFile), { url: xsdFile });
    expect(result.valid).toBe(true);
  });

  it('throws a clear install hint when libxml2-wasm is missing', async () => {
    vi.resetModules();
    vi.doMock('libxml2-wasm', () => {
      throw new Error("Cannot find package 'libxml2-wasm'");
    });
    try {
      const { validateXml } = await import('../src/validate.js');
      await expect(validateXml('<doc/>', XSD)).rejects.toThrow(/optional peer dependency 'libxml2-wasm'/);
    } finally {
      vi.doUnmock('libxml2-wasm');
      vi.resetModules();
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
