import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { parseXml } from '../src/index.js';
import { generateAndImport, withTempDirAsync } from './helpers.js';

// Regression tests for the issue-#134 choice emptiness fix: a choice group
// with any minOccurs="0" branch is emptiable, even when other branches are
// required and the choice repeats.

const schemaFor = async (xsd: string): Promise<z.ZodType> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, 'schema.xsd');
    fs.writeFileSync(file, xsd);
    mod = await generateAndImport([file]);
  });
  return Object.values(mod)[0] as z.ZodType;
};

const CONCEPT_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="ConceptType">
    <xs:choice maxOccurs="unbounded">
      <xs:element name="Name" type="xs:string" minOccurs="1" maxOccurs="unbounded"/>
      <xs:element name="Definition" type="xs:string" minOccurs="1" maxOccurs="1"/>
      <xs:element name="LanguageOfCreator" type="xs:language" minOccurs="0" maxOccurs="1"/>
    </xs:choice>
    <xs:attribute name="id" type="xs:string" use="required"/>
  </xs:complexType>
  <xs:element name="Concept" type="ConceptType"/>
</xs:schema>`;

describe('emptiable choice groups (#134)', () => {
  it('accepts the empty instance when any branch is optional', async () => {
    const schema = await schemaFor(CONCEPT_XSD);
    // Repeated-choice branches materialize as empty arrays when absent (#107).
    expect(parseXml(schema, '<Concept id="x"/>')).toEqual({ '@id': 'x', Name: [], Definition: [], LanguageOfCreator: [] });
  });

  it('still accepts single and repeated branch selections', async () => {
    const schema = await schemaFor(CONCEPT_XSD);
    expect(parseXml(schema, '<Concept id="x"><Name>n</Name></Concept>')).toEqual({ '@id': 'x', Name: ['n'], Definition: [], LanguageOfCreator: [] });
    expect(parseXml(schema, '<Concept id="x"><LanguageOfCreator>en</LanguageOfCreator></Concept>')).toEqual({ '@id': 'x', LanguageOfCreator: ['en'], Name: [], Definition: [] });
    expect(parseXml(schema, '<Concept id="x"><Name>a</Name><Name>b</Name><Definition>d</Definition></Concept>')).toEqual({ '@id': 'x', Name: ['a', 'b'], Definition: ['d'], LanguageOfCreator: [] });
  });

  it('still requires one branch when every branch is non-emptiable', async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="T">
    <xs:choice maxOccurs="unbounded">
      <xs:element name="A" type="xs:string" minOccurs="1"/>
      <xs:element name="B" type="xs:string" minOccurs="1"/>
    </xs:choice>
  </xs:complexType>
  <xs:element name="t" type="T"/>
</xs:schema>`);
    expect(parseXml(schema, '<t><B>b</B></t>')).toEqual({ A: [], B: ['b'] });
    expect(() => parseXml(schema, '<t/>')).toThrow(/choice/);
  });
});
