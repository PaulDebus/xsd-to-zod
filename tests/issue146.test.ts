import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { irToZod, parseXsd } from '../src/index.js';
import { withTempDir } from './helpers.js';

// Static types must survive codegen: z.infer<typeof XSchema> yields the TS
// type of the XSD complex type, not any (#146). The old
// `schemas: Record<string, z.ZodTypeAny>` registry erased every per-schema
// generic. Asserted by typechecking a consumer file against the generated
// module with tsc — @ts-expect-error lines fail the run if the inferred type
// silently degrades to any.

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:static" xmlns:t="urn:static">
  <xs:simpleType name="StatusCode">
    <xs:restriction base="xs:string">
      <xs:enumeration value="active"/>
      <xs:enumeration value="inactive"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:complexType name="PersonType">
    <xs:sequence>
      <xs:element name="name" type="xs:string"/>
      <xs:element name="status" type="t:StatusCode" minOccurs="0"/>
      <xs:element name="manager" type="t:PersonType" minOccurs="0"/>
      <xs:element name="scores" type="xs:int" maxOccurs="unbounded"/>
      <xs:element name="nickname" type="xs:string" nillable="true"/>
    </xs:sequence>
    <xs:attribute name="id" type="xs:string" use="required"/>
    <xs:attribute name="lang" type="xs:string" default="en"/>
  </xs:complexType>
  <xs:element name="person" type="t:PersonType"/>
</xs:schema>`;

const CONSUMER = `import { z } from 'zod';
import { personSchema, PersonType } from './schema.zod.js';

type Person = z.infer<typeof personSchema>;

// The inferred type matches the interface — and is not any.
const person: Person = {
  name: 'Alice',
  scores: [1, 2],
  nickname: null,
  '@id': 'p1',
  '@lang': 'en',
};
const sameAsInterface: PersonType = person;
const backAgain: Person = sameAsInterface;

// Recursive and optional members keep their types.
const manager: PersonType | undefined = person.manager;
const status: 'active' | 'inactive' | undefined = person.status;
const scores: number[] = person.scores;

// @ts-expect-error — name is a required string, not optional
const missing: Person = { scores: [], nickname: null, '@id': 'x', '@lang': 'en' };
// @ts-expect-error — status is an enum, not an arbitrary string
const badStatus: Person = { name: 'x', status: 'bogus', scores: [], nickname: null, '@id': 'x', '@lang': 'en' };
// @ts-expect-error — scores is number[], not string[]
const badScores: Person = { name: 'x', scores: ['a'], nickname: null, '@id': 'x', '@lang': 'en' };

export { person, manager, status, scores, missing, badStatus, badScores };
`;

describe('generated schemas preserve static types (#146)', () => {
  it('z.infer yields the XSD complex type, enforced by tsc', () => {
    // Under the package-root dotdir so the generated module's bare
    // 'xsd-to-zod' self-reference resolves (it does not from os.tmpdir()).
    const baseDir = path.resolve('.xsd-to-zod-tests');
    fs.mkdirSync(baseDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(baseDir, 'issue146-'));
    try {
      const xsdFile = path.join(dir, 'schema.xsd');
      fs.writeFileSync(xsdFile, XSD);
      fs.writeFileSync(path.join(dir, 'schema.zod.ts'), irToZod(parseXsd([xsdFile])).schemas);
      fs.writeFileSync(path.join(dir, 'consumer.ts'), CONSUMER);

      const tsc = path.resolve('node_modules/.bin/tsc');
      const result = spawnSync(
        tsc,
        [
          '--noEmit',
          '--ignoreConfig',
          '--strict',
          '--skipLibCheck',
          '--target', 'es2022',
          '--module', 'nodenext',
          '--moduleResolution', 'nodenext',
          path.join(dir, 'consumer.ts'),
        ],
        { encoding: 'utf8' }
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('emits interfaces only in TS mode, annotations only in TS mode', () => {
    withTempDir((dir) => {
      const xsdFile = path.join(dir, 'schema.xsd');
      fs.writeFileSync(xsdFile, XSD);
      const ts = irToZod(parseXsd([xsdFile])).schemas;
      expect(ts).toContain('export interface PersonType {');
      expect(ts).toContain('const PersonTypeSchema: z.ZodType<PersonType> = z.lazy(');
      const js = irToZod(parseXsd([xsdFile]), { js: true }).schemas;
      expect(js).not.toContain('export interface');
      expect(js).not.toContain('z.ZodType<');
      expect(js).toContain('const PersonTypeSchema = z.lazy(');
    });
  });

  it('renames interfaces that collide with TS type keywords', () => {
    const RESERVED_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:reserved" xmlns:t="urn:reserved">
  <xs:complexType name="boolean">
    <xs:sequence><xs:element name="v" type="xs:string"/></xs:sequence>
  </xs:complexType>
  <xs:complexType name="any">
    <xs:sequence><xs:element name="b" type="t:boolean"/></xs:sequence>
  </xs:complexType>
  <xs:element name="root" type="t:any"/>
</xs:schema>`;
    withTempDir((dir) => {
      const xsdFile = path.join(dir, 'schema.xsd');
      fs.writeFileSync(xsdFile, RESERVED_XSD);
      const code = irToZod(parseXsd([xsdFile])).schemas;
      expect(code).toContain('export interface booleanType {');
      expect(code).toContain('export interface anyType {');
      expect(code).toContain('"b": booleanType;');
      expect(code).not.toContain('interface boolean {');
      expect(code).not.toContain('interface any {');
    });
  });
});
