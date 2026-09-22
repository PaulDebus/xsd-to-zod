import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { irToZod, parseXsd } from "../src/index.js";
import { importGeneratedSchemas, withTempDirAsync } from "./helpers.js";

const generate = async (xsd: string): Promise<{ schemas: string; warnings: string[] }> => {
  let result: { schemas: string; warnings: string[] } = { schemas: "", warnings: [] };
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    result = irToZod(await parseXsd([file]));
  });
  return result;
};

const XSD_OPEN = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:anon" elementFormDefault="qualified">`;

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
});
