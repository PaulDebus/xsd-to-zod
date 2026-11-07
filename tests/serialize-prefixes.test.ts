import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { parseXml, serializeXml } from "../src/index.js";
import { generateAndImport, onlyRootSchema, withTempDirAsync } from "./helpers.js";

const NS = "https://standards.iso.org/iso/23387/ed-2/en/";

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           xmlns:dt="${NS}"
           targetNamespace="${NS}"
           elementFormDefault="qualified">
  <xs:complexType name="ThingType">
    <xs:sequence>
      <xs:element name="name" type="xs:string"/>
      <xs:element name="identifier" type="xs:string" maxOccurs="unbounded"/>
    </xs:sequence>
    <xs:attribute name="kind" type="xs:QName"/>
  </xs:complexType>
  <xs:element name="Thing" type="dt:ThingType"/>
</xs:schema>`;

const schemaFor = async (): Promise<z.ZodType> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, XSD);
    mod = await generateAndImport([file]);
  });
  return onlyRootSchema(mod);
};

const XML = `<dt:Thing xmlns:dt="${NS}" kind="dt:Wall"><dt:name>Wall</dt:name><dt:identifier>a</dt:identifier><dt:identifier>b</dt:identifier></dt:Thing>`;

describe("serializeXml namespace prefixes", () => {
  it("uses the prefix declared by the source schema without an option", async () => {
    const schema = await schemaFor();
    const parsed = parseXml(schema, XML);
    const serialized = serializeXml(schema, parsed);
    expect(serialized).toBe(XML);
    expect(parseXml(schema, serialized)).toEqual(parsed);
  });

  it("lets an explicit option override the schema prefix", async () => {
    const schema = await schemaFor();
    const parsed = parseXml(schema, XML);
    const serialized = serializeXml(schema, parsed, { prefixes: { [NS]: "i23387" } });
    expect(serialized).toContain(`<i23387:Thing xmlns:i23387="${NS}"`);
    expect(serialized).toContain("<i23387:name>Wall</i23387:name>");
    expect(parseXml(schema, serialized)).toEqual(parsed);
  });

  it("does not use a reserved prefix", async () => {
    const schema = await schemaFor();
    const parsed = parseXml(schema, XML);
    const serialized = serializeXml(schema, parsed, { prefixes: { [NS]: "xml" } });
    expect(serialized).toContain("<ns0:Thing");
    expect(parseXml(schema, serialized)).toEqual(parsed);
  });
});
