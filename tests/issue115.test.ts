import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { irToZod, parseXsd } from '../src/index.js';
import { generateAndImport, withTempDir, withTempDirAsync } from './helpers.js';

// Regression tests for length facet units: octets for hex/base64 binary,
// list items for IDREFS/NMTOKENS/ENTITIES — not string characters.

const codeFor = (xsd: string): string => {
  let code = '';
  withTempDir((dir) => {
    const file = path.join(dir, 'schema.xsd');
    fs.writeFileSync(file, xsd);
    code = irToZod(parseXsd([file])).schemas;
  });
  return code;
};

const schemaFor = async (xsd: string): Promise<z.ZodType> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, 'schema.xsd');
    fs.writeFileSync(file, xsd);
    mod = await generateAndImport([file]);
  });
  return Object.values(mod)[0] as z.ZodType;
};

const XSD = (body: string): string => `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="v">${body}</xs:element>
</xs:schema>`;

describe('length facet units (#115)', () => {
  it('hexBinary length counts octets, not characters', async () => {
    const code = codeFor(XSD(`
    <xs:simpleType>
      <xs:restriction base="xs:hexBinary">
        <xs:length value="2"/>
      </xs:restriction>
    </xs:simpleType>`));
    expect(code).toContain('val.length / 2 === 2');
    const schema = await schemaFor(XSD(`
    <xs:simpleType>
      <xs:restriction base="xs:hexBinary">
        <xs:length value="2"/>
      </xs:restriction>
    </xs:simpleType>`));
    expect(schema.safeParse('0A1B').success).toBe(true); // 2 octets, 4 chars
    expect(schema.safeParse('0A1B2C').success).toBe(false); // 3 octets
  });

  it('base64Binary length counts decoded octets', () => {
    const code = codeFor(XSD(`
    <xs:simpleType>
      <xs:restriction base="xs:base64Binary">
        <xs:maxLength value="3"/>
      </xs:restriction>
    </xs:simpleType>`));
    expect(code).toContain("s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0");
  });

  it('IDREFS length counts items, not characters', async () => {
    const schema = await schemaFor(XSD(`
    <xs:simpleType>
      <xs:restriction base="xs:IDREFS">
        <xs:length value="2"/>
      </xs:restriction>
    </xs:simpleType>`));
    expect(schema.safeParse('foofo more').success).toBe(true); // 2 items, 10 chars
    expect(schema.safeParse('a b c').success).toBe(false); // 3 items
  });

  it('NMTOKENS minLength counts items', () => {
    const code = codeFor(XSD(`
    <xs:simpleType>
      <xs:restriction base="xs:NMTOKENS">
        <xs:minLength value="2"/>
      </xs:restriction>
    </xs:simpleType>`));
    expect(code).toContain("val.trim().split(/\\s+/).length) >= 2");
  });
});
