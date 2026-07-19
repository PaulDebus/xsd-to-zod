import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { irToZod, parseXsd, parseXml as parseXmlRuntime, serializeXml as serializeXmlRuntime } from '../src/index.js';
import { importGeneratedSchemas, withTempDir } from './helpers.js';

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:rt" xmlns:t="urn:rt" elementFormDefault="qualified">
  <xs:complexType name="DocType">
    <xs:sequence>
      <xs:element name="text" type="xs:string"/>
      <xs:element name="count" type="xs:int"/>
      <xs:element name="flag" type="xs:boolean"/>
      <xs:element name="measure" type="xs:double" minOccurs="0"/>
    </xs:sequence>
    <xs:attribute name="version" type="xs:int"/>
    <xs:attribute name="active" type="xs:boolean"/>
  </xs:complexType>
  <xs:element name="doc" type="t:DocType" nillable="true"/>
</xs:schema>`;

let rootSchema: z.ZodType;

const parseXml = (xml: string): Record<string, unknown> =>
  parseXmlRuntime(rootSchema, xml) as Record<string, unknown>;
const serializeXml = (obj: Record<string, unknown>): string =>
  serializeXmlRuntime(rootSchema, obj);

const doc = (inner: string, attrs = 'version="007" active="1"'): string =>
  `<doc xmlns="urn:rt" ${attrs}>${inner}</doc>`;

beforeAll(async () => {
  let schemasCode = '';
  withTempDir((dir) => {
    const file = path.join(dir, 'schema.xsd');
    fs.writeFileSync(file, XSD);
    schemasCode = irToZod(parseXsd([file])).schemas;
  });
  const mod = await importGeneratedSchemas(schemasCode);
  rootSchema = mod.docSchema as z.ZodType;
});

describe('validation modes', () => {
  it('parseXml throws ZodError on schema-invalid data', async () => {
    const { z } = await import('zod');
    // flag is xs:boolean; "true" coerces fine, but removing the required
    // <count> makes the walked data schema-invalid.
    expect(() => parseXml(doc('<text>x</text><flag>1</flag>'))).toThrow(z.ZodError);
  });

  it('{ validate: false } skips schema validation but still walks and coerces', async () => {
    const { safeParseXml } = await import('../src/index.js');
    const withoutRequired = doc('<text>x</text><flag>1</flag>');
    const skipped = safeParseXml(rootSchema, withoutRequired, { validate: false });
    expect(skipped.success).toBe(true);
    if (skipped.success) {
      expect(skipped.data).toMatchObject({ text: 'x', flag: true });
    }
    const validated = safeParseXml(rootSchema, withoutRequired);
    expect(validated.success).toBe(false);
  });
});

describe('entities in character data (#64)', () => {
  it('decodes predefined and numeric entities in text', () => {
    const parsed = parseXml(doc('<text>a &lt; b &amp; c &gt; d &#65;&#x42;</text><count>1</count><flag>true</flag>'));
    expect(parsed.text).toBe('a < b & c > d AB');
  });

  it('decodes entities in attribute values', () => {
    const parsed = parseXml(`<doc xmlns="urn:rt" version="1" active="true"><text>x</text><count>1</count><flag>0</flag></doc>`.replace('version="1"', 'version="&#49;"'));
    expect(parsed.version).toBeUndefined();
    expect(parsed['@version']).toBe(1);
  });

  it('does not double-decode &amp;lt;', () => {
    const parsed = parseXml(doc('<text>&amp;lt;</text><count>1</count><flag>1</flag>'));
    expect(parsed.text).toBe('&lt;');
  });

  it('keeps CDATA content verbatim, including entity-looking text', () => {
    const parsed = parseXml(doc('<text><![CDATA[a &lt; b &amp; <tag>]]></text><count>1</count><flag>0</flag>'));
    expect(parsed.text).toBe('a &lt; b &amp; <tag>');
  });

  it('round-trips serialized entity text', () => {
    const parsed = parseXml(doc('<text>a &lt; b &amp; c</text><count>2</count><flag>false</flag>'));
    const reparsed = parseXml(serializeXml(parsed));
    expect(reparsed).toEqual(parsed);
  });

  it('skips leading comments and processing instructions', () => {
    const xml = `<?xml version="1.0"?>\n<!-- a comment -->\n<?pi data?>\n${doc('<text>x</text><count>1</count><flag>1</flag>')}`;
    expect(parseXml(xml).text).toBe('x');
  });
});

describe('type coercion (#65)', () => {
  it('coerces attribute values through their declared type', () => {
    const parsed = parseXml(doc('<text>x</text><count>1</count><flag>0</flag>'));
    expect(parsed['@version']).toBe(7);
    expect(parsed['@active']).toBe(true);
    expect(parsed.flag).toBe(false);
  });

  it('preserves numeric-looking xs:string lexicals', () => {
    const parsed = parseXml(doc('<text>3.50</text><count>1</count><flag>1</flag>'));
    expect(parsed.text).toBe('3.50');
  });

  it('rejects invalid xs:int lexicals instead of producing NaN', () => {
    expect(() => parseXml(doc('<text>x</text><count>abc</count><flag>1</flag>'))).toThrow('Invalid xs:int lexical');
  });

  it('rejects empty xs:int elements instead of inventing 0', () => {
    expect(() => parseXml(doc('<text>x</text><count/><flag>1</flag>'))).toThrow('Invalid xs:int lexical');
  });

  it('rejects non-boolean lexicals for xs:boolean', () => {
    expect(() => parseXml(doc('<text>x</text><count>1</count><flag>yes</flag>'))).toThrow('Invalid xs:boolean lexical');
  });

  it('rejects INF/-INF/NaN coherently — zod cannot express non-finite numbers', () => {
    // The XSD float/double specials are valid lexicals, but zod's z.number()
    // refuses non-finite values at the base-type level, so the zod tier
    // rejects them at the coercion point already (full float semantics belong
    // to the libxml2 conformance tier).
    expect(() => parseXml(doc('<text>x</text><count>1</count><flag>1</flag><measure>-INF</measure>'))).toThrow('Invalid xs:double lexical: "-INF"');
    expect(() => parseXml(doc('<text>x</text><count>1</count><flag>1</flag><measure>NaN</measure>'))).toThrow('Invalid xs:double lexical: "NaN"');
  });

  it('returns null for an xsi:nil root', () => {
    const xml = '<doc xmlns="urn:rt" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true"/>';
    expect(parseXml(xml)).toBeNull();
  });
});
