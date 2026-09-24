import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { irToZod, parseXml, parseXsd, serializeXml } from "../src/index.js";
import { generateAndImport, onlyRootSchema, withTempDirAsync } from "./helpers.js";

// Shared-registry-metadata hoisting: extension-heavy schemas used to
// repeat the base type's whole fields block per derived type and per xsiType
// variant; the blocks are now named consts referenced from each site.

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:hoist" xmlns:t="urn:hoist" elementFormDefault="qualified">
  <xs:complexType name="ConceptType" abstract="true">
    <xs:sequence>
      <xs:element name="name" type="xs:string"/>
      <xs:element name="definition" type="xs:string" minOccurs="0"/>
      <xs:choice minOccurs="0">
        <xs:element name="note" type="xs:string"/>
        <xs:element name="remark" type="xs:string"/>
      </xs:choice>
    </xs:sequence>
    <xs:attribute name="id" type="xs:string" use="required"/>
  </xs:complexType>
  <xs:complexType name="ProductType">
    <xs:complexContent>
      <xs:extension base="t:ConceptType">
        <xs:sequence>
          <xs:element name="price" type="xs:decimal" minOccurs="0"/>
        </xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
  <xs:complexType name="ServiceType">
    <xs:complexContent>
      <xs:extension base="t:ConceptType">
        <xs:sequence>
          <xs:element name="duration" type="xs:decimal" minOccurs="0"/>
        </xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
  <xs:simpleType name="StringOrString">
    <xs:union memberTypes="xs:string xs:string"/>
  </xs:simpleType>
  <xs:element name="concept" type="t:ConceptType"/>
</xs:schema>`;

const generate = async (): Promise<string> => {
  let schemas = "";
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, XSD);
    schemas = irToZod(await parseXsd([file])).schemas;
  });
  return schemas;
};

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("hoisted registry metadata", () => {
  it("emits the base type's fields block once and references it from derived types", async () => {
    const schemas = await generate();
    expect(occurrences(schemas, '"name": { kind: "element", qname: "{urn:hoist}name" }')).toBe(1);
    expect(schemas).toContain("const ConceptTypeFields");
    expect(schemas).toContain("fields: { ...ConceptTypeFields,");
  });

  it("registers one hoisted meta object on every const of a polymorphic family", async () => {
    const schemas = await generate();
    expect(schemas).toContain("const ConceptTypeMeta: XmlMeta = {");
    // Named const and declared variant share the family head's meta const;
    // a derived type's named const and xsiType variant share its own.
    expect(occurrences(schemas, ".register(xmlRegistry, ConceptTypeMeta)")).toBe(2);
    expect(occurrences(schemas, ".register(xmlRegistry, ProductTypeMeta)")).toBe(2);
    expect(schemas).toContain("XmlMeta } from 'xsd-to-zod';");
  });

  it("shares an inherited choices block between base and derived types", async () => {
    const schemas = await generate();
    expect(occurrences(schemas, "const ConceptTypeChoices")).toBe(1);
    expect(occurrences(schemas, "choices: ConceptTypeChoices")).toBeGreaterThanOrEqual(3);
  });

  it("dedupes trivial unions of identical member expressions", async () => {
    const schemas = await generate();
    expect(schemas).toContain("const StringOrStringSchema = z.string()");
    expect(schemas).not.toContain("z.union([z.string(), z.string()])");
  });

  it("keeps parse/serialize behavior through the shared meta", async () => {
    let mod: Record<string, unknown> = {};
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, XSD);
      mod = await generateAndImport([file]);
    });
    const schema = onlyRootSchema(mod) as z.ZodType;
    const xml = `<concept xmlns="urn:hoist" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ProductType" id="p1"><name>n</name><note>x</note><price>9.5</price></concept>`;
    const data = parseXml(schema, xml);
    expect(data).toEqual({
      name: "n",
      note: "x",
      price: 9.5,
      "@id": "p1",
      xsiType: "{urn:hoist}ProductType",
    });
    const out = serializeXml(schema, data);
    expect(out).toContain('xsi:type="ns0:ProductType"');
    expect(parseXml(schema, out)).toEqual(data);
  });
});
