import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { irToZod, parseXsd, parseXml, Xsd2ZodError } from '../src/index.js';
import { generateAndImport, withTempDir, withTempDirAsync } from './helpers.js';

// Targeted regression tests for the issue-#84 codegen fixes.
const NUM_ENUM_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:num-enum" xmlns:t="urn:num-enum" elementFormDefault="qualified">
  <xs:simpleType name="Ratio">
    <xs:restriction base="xs:decimal">
      <xs:enumeration value="1.0"/>
      <xs:enumeration value="2.50"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="Small">
    <xs:restriction base="xs:integer">
      <xs:minInclusive value="1"/>
      <xs:enumeration value="1"/>
      <xs:enumeration value="02"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:element name="ratio" type="t:Ratio"/>
</xs:schema>`;

const COLLISION_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:dup" xmlns:t="urn:dup" elementFormDefault="qualified">
  <xs:simpleType name="Dup">
    <xs:restriction base="xs:string"/>
  </xs:simpleType>
  <xs:complexType name="Dup">
    <xs:sequence/>
  </xs:complexType>
  <xs:element name="dup" type="t:Dup"/>
</xs:schema>`;

describe('enum facet coercion (#84)', () => {
  it('emits numeric enum lexicals coerced to numbers', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'schema.xsd');
      fs.writeFileSync(file, NUM_ENUM_XSD);
      const { schemas } = irToZod(parseXsd([file]));
      // Number('1.0') → 1, Number('2.50') → 2.5 — not raw lexicals, not strings.
      expect(schemas).toContain('z.union([z.literal(1), z.literal(2.5)])');
    });
  });

  it('coerces enum values in the mixed-facet refine path too', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'schema.xsd');
      fs.writeFileSync(file, NUM_ENUM_XSD);
      const { schemas } = irToZod(parseXsd([file]));
      expect(schemas).toContain('.refine((val) => [1, 2].includes(val)');
    });
  });

  it('round-trips non-canonical numeric enum lexicals', async () => {
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, 'schema.xsd');
      fs.writeFileSync(file, NUM_ENUM_XSD);
      const mod = await generateAndImport([file]);
      const ratioSchema = mod.ratioSchema as z.ZodType;
      expect(parseXml(ratioSchema, '<ratio xmlns="urn:num-enum">1.0</ratio>')).toBe(1);
      expect(parseXml(ratioSchema, '<ratio xmlns="urn:num-enum">2.50</ratio>')).toBe(2.5);
      expect(() => parseXml(ratioSchema, '<ratio xmlns="urn:num-enum">3.0</ratio>')).toThrow();
    });
  });
});

describe('type name collision (#84)', () => {
  it('throws an Xsd2ZodError when a simpleType and complexType share a qname', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'schema.xsd');
      fs.writeFileSync(file, COLLISION_XSD);
      const run = () => irToZod(parseXsd([file]));
      expect(run).toThrow(Xsd2ZodError);
      expect(run).toThrow(/type name collision/);
      try {
        run();
        expect.unreachable();
      } catch (e) {
        expect((e as Xsd2ZodError).code).toBe('type-name-collision');
      }
    });
  });
});
