import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { parseXml, serializeXml } from "../src/index.js";
import { generateAndImport, withTempDirAsync } from "./helpers.js";

// Regression tests for the W3C sun/ms undefinedValue bucket: XML-namespace
// attributes used without a declaration (the xml prefix is bound by
// definition), and attribute defaults of an xs:list type arriving as scalars
// instead of arrays.

const XML_BASE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" elementFormDefault="qualified">
  <xs:import namespace="http://www.w3.org/XML/1998/namespace" />
  <xs:element name="root">
    <xs:complexType>
      <xs:attribute ref="xml:base" use="required" />
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const LIST_DEFAULT_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:attribute name="dims" default="1 2">
        <xs:simpleType>
          <xs:list itemType="xs:int" />
        </xs:simpleType>
      </xs:attribute>
      <xs:attribute name="names" type="xs:string" default="a b" />
      <xs:attribute name="tags" default="x y">
        <xs:simpleType>
          <xs:list itemType="xs:string" />
        </xs:simpleType>
      </xs:attribute>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const generate = async (xsd: string): Promise<z.ZodType> => {
  let schema: z.ZodType | undefined;
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    const mod = await generateAndImport([file]);
    schema = Object.values(mod)[0] as z.ZodType;
  });
  if (schema === undefined) {
    throw new Error("no schema generated");
  }
  return schema;
};

describe("XML-namespace attributes without a declaration (#122)", () => {
  it("parses and re-serializes an undeclared xml:base attribute", async () => {
    const schema = await generate(XML_BASE_XSD);
    const parsed = parseXml(schema, '<root xml:base="a"/>');
    expect(parsed).toEqual({ "@base": "a" });

    // The xml prefix is bound by definition: serialized undeclared, not as a
    // generated ns0 prefix with an explicit declaration.
    const serialized = serializeXml(schema, parsed);
    expect(serialized).toContain('xml:base="a"');
    expect(serialized).not.toContain("xmlns:xml");
    expect(parseXml(schema, serialized)).toEqual(parsed);
  });
});

describe("xs:list attribute defaults (#122)", () => {
  it("applies list defaults as typed arrays, not scalars", async () => {
    const schema = await generate(LIST_DEFAULT_XSD);
    expect(parseXml(schema, "<root/>")).toEqual({
      "@dims": [1, 2],
      "@names": "a b",
      "@tags": ["x", "y"],
    });
  });

  it("still parses a present list attribute", async () => {
    const schema = await generate(LIST_DEFAULT_XSD);
    const parsed = parseXml(schema, '<root dims="3 4" tags="p q"/>');
    expect(parsed).toEqual({
      "@dims": [3, 4],
      "@names": "a b",
      "@tags": ["p", "q"],
    });
    expect(parseXml(schema, serializeXml(schema, parsed))).toEqual(parsed);
  });
});
