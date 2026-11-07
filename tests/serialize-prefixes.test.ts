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

// The attribute is declared before the sequence so its QName lexical is
// serialized first: its prefix is recorded in qnameNs, then adopted by the
// element path instead of being declared twice.
const QNAME_FIRST_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           xmlns:dt="${NS}"
           targetNamespace="${NS}"
           elementFormDefault="qualified">
  <xs:complexType name="ThingType">
    <xs:attribute name="kind" type="xs:QName"/>
    <xs:sequence>
      <xs:element name="name" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="Thing" type="dt:ThingType"/>
</xs:schema>`;

const WILDCARD_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           xmlns:dt="${NS}"
           targetNamespace="${NS}"
           elementFormDefault="qualified">
  <xs:complexType name="ThingType">
    <xs:sequence>
      <xs:element name="name" type="xs:string"/>
      <xs:any namespace="##other" processContents="lax" minOccurs="0" maxOccurs="unbounded"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="Thing" type="dt:ThingType"/>
</xs:schema>`;

const schemaFor = async (xsd = XSD): Promise<z.ZodType> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
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

  it("falls back when two namespaces prefer the same prefix", async () => {
    const schema = await schemaFor(WILDCARD_XSD);
    const parsed = parseXml(
      schema,
      `<dt:Thing xmlns:dt="${NS}" xmlns:o="urn:other"><dt:name>Wall</dt:name><o:extra>x</o:extra></dt:Thing>`,
    );
    const serialized = serializeXml(schema, parsed, {
      prefixes: { [NS]: "dt", "urn:other": "dt" },
    });
    expect(serialized).toContain(`xmlns:dt="${NS}"`);
    expect(serialized).toContain('xmlns:ns1="urn:other"');
    expect(serialized).toContain("<ns1:extra>x</ns1:extra>");
    expect(parseXml(schema, serialized)).toEqual(parsed);
  });

  it("adopts a prefix a QName attribute already declared for the namespace", async () => {
    const schema = await schemaFor(QNAME_FIRST_XSD);
    const xml = `<dt:Thing xmlns:dt="${NS}" kind="dt:Wall"><dt:name>Wall</dt:name></dt:Thing>`;
    const parsed = parseXml(schema, xml);
    const serialized = serializeXml(schema, parsed);
    expect(serialized).toBe(xml);
    expect(serialized.match(/xmlns:dt=/g)).toHaveLength(1);
    expect(parseXml(schema, serialized)).toEqual(parsed);
  });
});
