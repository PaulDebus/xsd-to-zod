import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { parseXml, serializeXml } from "../src/index.js";
import { generateAndImport, withTempDirAsync } from "./helpers.js";

// A present simple-typed element without character data has empty-string
// content — including when attributes (xsi:type, schemaLocation) make the XML
// parser yield an object node instead of a bare string. Element children
// under a simple type are not character data and still reject.

const schemaFor = async (xsd: string): Promise<z.ZodType> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    mod = await generateAndImport([file]);
  });
  return Object.values(mod)[0] as z.ZodType;
};

describe("empty content of simple-typed elements", () => {
  it("reads an attribute-carrying leaf without text as empty-string content", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="T">
    <xs:sequence>
      <xs:element name="item" type="xs:anySimpleType" maxOccurs="unbounded"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="root" type="T"/>
</xs:schema>`);
    const parsed = parseXml(
      schema,
      '<root xmlns:xs="http://www.w3.org/2001/XMLSchema"><item>abc</item><item xs:attr="1"/></root>',
    );
    expect(parsed).toEqual({ item: ["abc", ""] });
    expect(parseXml(schema, serializeXml(schema, parsed))).toEqual(parsed);
  });

  it("reads a simple-typed root without character data as empty-string content", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root" type="xs:anySimpleType"/>
</xs:schema>`);
    const parsed = parseXml(schema, "<root><!-- only a comment --></root>");
    expect(parsed).toBe("");
    expect(parseXml(schema, serializeXml(schema, parsed))).toBe("");
  });

  it("still rejects element children under a simple type", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root" type="xs:string"/>
</xs:schema>`);
    expect(() => parseXml(schema, "<root><child/></root>")).toThrow();
  });

  it("still rejects empty content for numeric types", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root" type="xs:int"/>
</xs:schema>`);
    expect(() => parseXml(schema, "<root><!-- only a comment --></root>")).toThrow();
  });
});
