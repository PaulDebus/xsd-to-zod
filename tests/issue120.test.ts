import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { parseXml, serializeXml } from '../src/index.js';
import { generateAndImport, withTempDirAsync } from './helpers.js';

// Regression tests for element value substitution on empty content:
// fixed/default on a present-but-empty root element, and empty simpleContent.

const schemaFor = async (xsd: string): Promise<z.ZodType> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, 'schema.xsd');
    fs.writeFileSync(file, xsd);
    mod = await generateAndImport([file]);
  });
  return Object.values(mod)[0] as z.ZodType;
};

describe('root element fixed/default on empty content (#120)', () => {
  it('applies the default to a present-but-empty root', async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root" type="xs:decimal" default="12"/>
</xs:schema>`);
    expect(parseXml(schema, '<root/>')).toBe(12);
  });

  it('applies fixed to a present-but-empty root and still enforces it otherwise', async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root" type="xs:int" fixed="37"/>
</xs:schema>`);
    expect(parseXml(schema, '<root/>')).toBe(37);
  });

  it('keeps explicit content over the default', async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root" type="xs:decimal" default="12"/>
</xs:schema>`);
    expect(parseXml(schema, '<root>4.5</root>')).toBe(4.5);
  });
});

describe('empty simpleContent (#120)', () => {
  const SIMPLE_CONTENT_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:sc" xmlns:t="urn:sc" elementFormDefault="qualified">
  <xs:complexType name="Doc">
    <xs:simpleContent>
      <xs:extension base="xs:string">
        <xs:attribute name="a" type="xs:string"/>
      </xs:extension>
    </xs:simpleContent>
  </xs:complexType>
  <xs:element name="doc" type="t:Doc"/>
</xs:schema>`;

  it('parses an attribute-only element as empty-string content', async () => {
    const schema = await schemaFor(SIMPLE_CONTENT_XSD);
    const parsed = parseXml(schema, '<doc xmlns="urn:sc" a="1"/>') as Record<string, unknown>;
    expect(parsed).toEqual({ _text: '', '@a': '1' });
    expect(serializeXml(schema, parsed)).toContain('a="1"');
  });
});
