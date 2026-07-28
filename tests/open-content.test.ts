import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { parseXml, serializeXml } from "../src/index.js";
import { generateAndImport, withTempDirAsync } from "./helpers.js";

// Open content (xs:anyType): elements declared without a type carry a
// normalized open shape — clark-keyed children, '@'-prefixed attributes,
// '_text' — that round-trips without a schema.

const schemaFor = async (xsd: string): Promise<z.ZodType> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    mod = await generateAndImport([file]);
  });
  return Object.values(mod)[0] as z.ZodType;
};

describe("xs:anyType open content", () => {
  it("walks and re-serializes arbitrary children, attributes and namespaces", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t" xmlns:t="urn:t">
  <xs:element name="root"/>
</xs:schema>`);
    const xml =
      '<t:root xmlns:t="urn:t" xmlns:o="urn:other"><t:child a="1">text</t:child><o:item>x</o:item><o:item>y</o:item></t:root>';
    const parsed = parseXml(schema, xml) as Record<string, unknown>;
    expect(parsed).toEqual({
      "{urn:t}child": { "@a": "1", _text: "text" },
      "{urn:other}item": ["x", "y"],
    });
    const serialized = serializeXml(schema, parsed);
    const reparsed = parseXml(schema, serialized);
    expect(reparsed).toEqual(parsed);
  });

  it("parses a leaf open element as its text string", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root"/>
</xs:schema>`);
    expect(parseXml(schema, "<root>abc</root>")).toBe("abc");
  });

  it("parses a completely empty open element as empty-string content, not nil", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root"/>
</xs:schema>`);
    const parsed = parseXml(schema, "<root/>");
    expect(parsed).toBe("");
    expect(parseXml(schema, serializeXml(schema, parsed))).toBe("");
  });

  it("applies default/fixed to present-but-empty open fields", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root" type="ct"/>
  <xs:complexType name="ct">
    <xs:sequence>
      <xs:element name="a" default="default"/>
      <xs:element name="b" fixed="fixed"/>
    </xs:sequence>
  </xs:complexType>
</xs:schema>`);
    expect(parseXml(schema, "<root><a></a><b></b></root>")).toEqual({
      a: "default",
      b: "fixed",
    });
  });

  it("drops xsi:* directives from the open shape", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t" xmlns:t="urn:t">
  <xs:element name="root"/>
</xs:schema>`);
    const parsed = parseXml(
      schema,
      '<t:root xmlns:t="urn:t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xsd:anyType"><t:c xsi:nil="false">x</t:c></t:root>',
    ) as Record<string, unknown>;
    expect(parsed).toEqual({ "{urn:t}c": "x" });
  });
});
