import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { irToZod, parseXsd } from "../src/index.js";
import { TS_TYPE_RESERVED, XSD_LEXICAL_VALIDATORS, XSD_STRUCTURED_TYPES } from "../src/irToZod.js";
import { importGeneratedSchemas, withTempDirAsync } from "./helpers.js";

const generate = async (xsd: string): Promise<{ schemas: string; warnings: string[] }> =>
  generateFiles({ "schema.xsd": xsd });

const generateFiles = async (
  files: Record<string, string>,
): Promise<{ schemas: string; warnings: string[] }> => {
  let result: { schemas: string; warnings: string[] } = { schemas: "", warnings: [] };
  await withTempDirAsync(async (dir) => {
    const paths = Object.entries(files).map(([name, xsd]) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, xsd);
      return file;
    });
    result = irToZod(await parseXsd(paths));
  });
  return result;
};

const XSD_OPEN = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:anon" elementFormDefault="qualified">`;

const XSD_OPEN_NS = (ns: string) => `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="${ns}" elementFormDefault="qualified">`;

describe("anonymous type naming", () => {
  it("names a top-level anonymous complex type after its element", async () => {
    const { schemas, warnings } = await generate(`${XSD_OPEN}
  <xs:element name="Library">
    <xs:complexType>
      <xs:sequence><xs:element name="Title" type="xs:string"/></xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`);
    expect(schemas).toContain("export interface Library {");
    expect(schemas).toContain("const LibraryTypeSchema: z.ZodType<Library>");
    expect(schemas).toContain("export const LibrarySchema = z.lazy(() => LibraryTypeSchema)");
    expect(schemas).not.toMatch(/(interface|const) anonymous_/);
    expect(warnings).toEqual([]);
  });

  it("names a top-level anonymous simple type after its element", async () => {
    const { schemas, warnings } = await generate(`${XSD_OPEN}
  <xs:element name="Code">
    <xs:simpleType><xs:restriction base="xs:string"/></xs:simpleType>
  </xs:element>
</xs:schema>`);
    expect(schemas).toContain("const CodeTypeSchema = ");
    expect(schemas).not.toMatch(/const anonymous_/);
    expect(warnings).toEqual([]);
  });

  it("keeps the Parent_Child_Type scheme for nested anonymous types, without the prefix", async () => {
    const { schemas, warnings } = await generate(`${XSD_OPEN}
  <xs:group name="G">
    <xs:sequence>
      <xs:element name="item">
        <xs:complexType>
          <xs:sequence><xs:element name="z" type="xs:string"/></xs:sequence>
        </xs:complexType>
      </xs:element>
    </xs:sequence>
  </xs:group>
  <xs:element name="Root">
    <xs:complexType>
      <xs:sequence><xs:group ref="G"/></xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`);
    expect(schemas).toContain("export interface Root {");
    expect(schemas).toContain("export interface Root_Type_item_Type {");
    expect(schemas).not.toMatch(/(interface|const) anonymous_/);
    expect(warnings).toEqual([]);
  });

  it("keeps the synthetic name, warns, and comments when the friendly name collides", async () => {
    const { schemas, warnings } = await generate(`${XSD_OPEN}
  <xs:complexType name="Library">
    <xs:sequence><xs:element name="x" type="xs:string"/></xs:sequence>
  </xs:complexType>
  <xs:element name="Library">
    <xs:complexType>
      <xs:sequence><xs:element name="y" type="xs:string"/></xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`);
    expect(schemas).toContain("export interface Library {");
    expect(schemas).toContain("export interface anonymous_Library_Type {");
    expect(schemas).toMatch(
      /\/\/ Friendly name "Library" collides.*\nexport interface anonymous_Library_Type/,
    );
    expect(warnings).toEqual([
      '[naming-collision] {urn:anon}anonymous_Library_Type: friendly name "Library" is already taken in the generated module; kept the synthetic name "anonymous_Library_Type"',
    ]);
    await expect(importGeneratedSchemas(schemas)).resolves.toBeTypeOf("object");
  });

  it("keeps one synthetic name, warns, and comments when two namespaces mint the same friendly name", async () => {
    const itemSchema = (ns: string) => `${XSD_OPEN_NS(ns)}
  <xs:element name="Item">
    <xs:complexType>
      <xs:sequence><xs:element name="x" type="xs:string"/></xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;
    const { schemas, warnings } = await generateFiles({
      "a.xsd": itemSchema("urn:a"),
      "b.xsd": itemSchema("urn:b"),
    });
    expect(schemas.match(/export interface Item \{/g)).toHaveLength(1);
    expect(schemas.match(/export interface anonymous_Item_Type \{/g)).toHaveLength(1);
    expect(schemas).toMatch(
      /\/\/ Friendly name "Item" collides.*\nexport interface anonymous_Item_Type/,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^\[naming-collision\] \{urn:[ab]\}anonymous_Item_Type: friendly name "Item" is already taken in the generated module; kept the synthetic name "anonymous_Item_Type"$/,
    );
    await expect(importGeneratedSchemas(schemas)).resolves.toBeTypeOf("object");
  });

  it("suffixes an interface named like a generated-module import", async () => {
    const { schemas } = await generate(`${XSD_OPEN}
  <xs:element name="z">
    <xs:complexType>
      <xs:sequence><xs:element name="y" type="xs:string"/></xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`);
    expect(schemas).toContain("export interface zType {");
    expect(schemas).not.toContain("export interface z {");
    await expect(importGeneratedSchemas(schemas)).resolves.toBeTypeOf("object");
  });

  it("leaves shared named types alone when two elements reference one type", async () => {
    const { schemas, warnings } = await generate(`${XSD_OPEN}
  <xs:complexType name="Shared">
    <xs:sequence><xs:element name="x" type="xs:string"/></xs:sequence>
  </xs:complexType>
  <xs:element name="A" type="Shared"/>
  <xs:element name="B" type="Shared"/>
</xs:schema>`);
    expect(schemas).toContain("export interface Shared {");
    expect(schemas).not.toMatch(/(interface|const) anonymous_/);
    expect(warnings).toEqual([]);
    await expect(importGeneratedSchemas(schemas)).resolves.toBeTypeOf("object");
  });

  it("keeps friendly names alongside a polymorphic family", async () => {
    const { schemas, warnings } = await generate(`${XSD_OPEN}
  <xs:complexType name="Base" abstract="true">
    <xs:sequence><xs:element name="id" type="xs:string"/></xs:sequence>
  </xs:complexType>
  <xs:complexType name="Derived">
    <xs:complexContent>
      <xs:extension base="Base">
        <xs:sequence><xs:element name="extra" type="xs:string"/></xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
  <xs:element name="Library">
    <xs:complexType>
      <xs:sequence><xs:element name="Title" type="xs:string"/></xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`);
    expect(schemas).toContain("export interface Library {");
    expect(schemas).toContain("BaseObjectSchema");
    expect(schemas).not.toMatch(/(interface|const) anonymous_/);
    expect(warnings).toEqual([]);
    await expect(importGeneratedSchemas(schemas)).resolves.toBeTypeOf("object");
  });
});

describe("TS_TYPE_RESERVED", () => {
  it("covers every identifier the generated module can import", () => {
    const importable = [
      // Fixed imports of every generated module and the facet helpers
      // assembled into the import line (usage flags / withFacets).
      "z",
      "xmlRegistry",
      "xsdTotalDigits",
      "xsdFractionDigits",
      "xsdPattern",
      ...XSD_LEXICAL_VALIDATORS.values(),
      ...[...XSD_STRUCTURED_TYPES.values()].flatMap((t) => [t.parseFn, t.writeFn, t.tsType]),
    ];
    for (const name of importable) {
      expect(TS_TYPE_RESERVED.has(name), name).toBe(true);
    }
  });
});
