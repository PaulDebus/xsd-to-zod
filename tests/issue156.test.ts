import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { parseXml } from "../src/index.js";
import { generateAndImport, withTempDirAsync } from "./helpers.js";

const schemaFor = async (xsd: string): Promise<z.ZodType> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    mod = await generateAndImport([file]);
  });
  return Object.values(mod)[0] as z.ZodType;
};

// Regression test for #156: inherited repeated-choice fields must not get a
// mutual-exclusion refine that rejects valid XML.
const INHERITED_CHOICE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           targetNamespace="https://example.org/ns"
           elementFormDefault="qualified">
  <xs:complexType name="BaseType" abstract="true">
    <xs:choice maxOccurs="unbounded">
      <xs:element name="Name" type="xs:string" minOccurs="1" maxOccurs="unbounded"/>
      <xs:element name="Def" type="xs:string" minOccurs="1" maxOccurs="1"/>
    </xs:choice>
  </xs:complexType>

  <xs:complexType name="DerivedType">
    <xs:complexContent>
      <xs:extension base="BaseType">
        <xs:choice maxOccurs="unbounded">
          <xs:element name="Extra" type="xs:string" minOccurs="0" maxOccurs="unbounded"/>
        </xs:choice>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>

  <xs:element name="Root" type="DerivedType"/>
</xs:schema>`;

describe("inherited repeated-choice refinements (#156)", () => {
  it("accepts both branches of an inherited repeated choice", async () => {
    const schema = await schemaFor(INHERITED_CHOICE_XSD);
    expect(
      parseXml(
        schema,
        '<ns:Root xmlns:ns="https://example.org/ns"><ns:Name>A</ns:Name><ns:Def>B</ns:Def></ns:Root>',
      ),
    ).toEqual({
      Name: ["A"],
      Def: ["B"],
      Extra: [],
    });
  });

  it("accepts mixed base and extension branches in a repeated choice", async () => {
    const schema = await schemaFor(INHERITED_CHOICE_XSD);
    expect(
      parseXml(
        schema,
        '<ns:Root xmlns:ns="https://example.org/ns"><ns:Name>A</ns:Name><ns:Extra>B</ns:Extra></ns:Root>',
      ),
    ).toEqual({
      Name: ["A"],
      Def: [],
      Extra: ["B"],
    });
  });

  it("accepts empty instance when all branches are optional", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           targetNamespace="https://example.org/ns"
           elementFormDefault="qualified">
  <xs:complexType name="BaseType" abstract="true">
    <xs:choice maxOccurs="unbounded">
      <xs:element name="Name" type="xs:string" minOccurs="0" maxOccurs="unbounded"/>
      <xs:element name="Def" type="xs:string" minOccurs="0" maxOccurs="1"/>
    </xs:choice>
  </xs:complexType>

  <xs:complexType name="DerivedType">
    <xs:complexContent>
      <xs:extension base="BaseType">
        <xs:choice maxOccurs="unbounded">
          <xs:element name="Extra" type="xs:string" minOccurs="0" maxOccurs="unbounded"/>
        </xs:choice>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>

  <xs:element name="Root" type="DerivedType"/>
</xs:schema>`);
    expect(parseXml(schema, '<ns:Root xmlns:ns="https://example.org/ns"/>')).toEqual({
      Name: [],
      Def: [],
      Extra: [],
    });
  });

  it("still requires one branch when every inherited branch is required", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           targetNamespace="https://example.org/ns"
           elementFormDefault="qualified">
  <xs:complexType name="BaseType" abstract="true">
    <xs:choice maxOccurs="unbounded">
      <xs:element name="A" type="xs:string" minOccurs="1"/>
      <xs:element name="B" type="xs:string" minOccurs="1"/>
    </xs:choice>
  </xs:complexType>

  <xs:complexType name="DerivedType">
    <xs:complexContent>
      <xs:extension base="BaseType"/>
    </xs:complexContent>
  </xs:complexType>

  <xs:element name="Root" type="DerivedType"/>
</xs:schema>`);
    expect(
      parseXml(schema, '<ns:Root xmlns:ns="https://example.org/ns"><ns:A>a</ns:A></ns:Root>'),
    ).toEqual({
      A: ["a"],
      B: [],
    });
    expect(() => parseXml(schema, '<ns:Root xmlns:ns="https://example.org/ns"/>')).toThrow(
      /choice/,
    );
  });
});
