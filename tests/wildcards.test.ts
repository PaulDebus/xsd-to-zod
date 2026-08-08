import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { parseXml, serializeXml } from "../src/index.js";
import { generateAndImport, withTempDirAsync } from "./helpers.js";

// xs:any / xs:anyAttribute wildcards (lax tier): unmatched content is captured
// in the open shape next to the declared fields and re-serialized.

const schemaFor = async (xsd: string): Promise<z.ZodType> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    mod = await generateAndImport([file]);
  });
  return Object.values(mod)[0] as z.ZodType;
};

describe("xs:any / xs:anyAttribute wildcards", () => {
  it("captures unmatched elements in the open shape and round-trips them", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t" xmlns:t="urn:t" elementFormDefault="qualified">
  <xs:complexType name="Doc">
    <xs:sequence>
      <xs:element name="known" type="xs:string"/>
      <xs:any namespace="##any" processContents="lax" minOccurs="0" maxOccurs="unbounded"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="doc" type="t:Doc"/>
</xs:schema>`);
    const xml =
      '<doc xmlns="urn:t" xmlns:o="urn:other"><known>k</known><o:x a="1">v</o:x><plain>w</plain></doc>';
    const parsed = parseXml(schema, xml) as Record<string, unknown>;
    expect(parsed).toEqual({
      known: "k",
      "{urn:other}x": { "@a": "1", _text: "v" },
      "{urn:t}plain": "w",
    });
    const serialized = serializeXml(schema, parsed);
    expect(serialized).toContain(">k</ns0:known>");
    const reparsed = parseXml(schema, serialized);
    expect(reparsed).toEqual(parsed);
  });

  it("captures unmatched attributes with xs:anyAttribute", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="Doc">
    <xs:attribute name="id" type="xs:int"/>
    <xs:anyAttribute namespace="##any" processContents="lax"/>
  </xs:complexType>
  <xs:element name="doc" type="Doc"/>
</xs:schema>`);
    const parsed = parseXml(schema, '<doc id="7" extra="yes"/>') as Record<string, unknown>;
    expect(parsed).toEqual({ "@id": 7, "@extra": "yes" });
    const serialized = serializeXml(schema, parsed);
    expect(serialized).toContain('extra="yes"');
    expect(parseXml(schema, serialized)).toEqual(parsed);
  });

  it("does not sweep declared fields or xsi directives", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="Doc">
    <xs:sequence><xs:any namespace="##any" processContents="lax" minOccurs="0" maxOccurs="unbounded"/></xs:sequence>
    <xs:attribute name="id" type="xs:int"/>
    <xs:anyAttribute namespace="##any" processContents="lax"/>
  </xs:complexType>
  <xs:element name="doc" type="Doc"/>
</xs:schema>`);
    const parsed = parseXml(
      schema,
      '<doc xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="7" xsi:type="xs:string"><x/></doc>',
    ) as Record<string, unknown>;
    expect(parsed).toEqual({ "@id": 7, "{}x": "" });
  });
});

describe("wildcard position and overflow", () => {
  it("re-serializes extras at the wildcard's position in the sequence", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="Doc">
    <xs:sequence>
      <xs:element name="a" type="xs:int"/>
      <xs:any namespace="##any" processContents="skip" minOccurs="1" maxOccurs="unbounded"/>
      <xs:element name="d" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="doc" type="Doc"/>
</xs:schema>`);
    const parsed = parseXml(
      schema,
      '<doc xmlns:h="urn:html"><a>1</a><h:html><h:body>t</h:body></h:html><d>x</d></doc>',
    ) as Record<string, unknown>;
    expect(parsed).toEqual({
      a: 1,
      "{urn:html}html": { "{urn:html}body": "t" },
      d: "x",
    });
    const serialized = serializeXml(schema, parsed);
    // The extra must come back BETWEEN a and d, not appended at the end.
    expect(serialized.indexOf("<a>")).toBeLessThan(serialized.indexOf("<ns0:html>"));
    expect(serialized.indexOf("<ns0:html>")).toBeLessThan(serialized.indexOf("<d>"));
    expect(parseXml(schema, serialized)).toEqual(parsed);
  });

  it("captures occurrences beyond a scalar field's capacity as wildcard extras", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="Doc">
    <xs:sequence>
      <xs:any namespace="##any" processContents="skip"/>
      <xs:element name="element1" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="doc" type="Doc"/>
</xs:schema>`);
    const parsed = parseXml(
      schema,
      "<doc><element1>a</element1><element1>a</element1></doc>",
    ) as Record<string, unknown>;
    // One occurrence feeds the field; the other is a wildcard extra.
    expect(parsed).toEqual({ element1: "a", "{}element1": "a" });
    const serialized = serializeXml(schema, parsed);
    expect(serialized).toBe("<doc><element1>a</element1><element1>a</element1></doc>");
    expect(parseXml(schema, serialized)).toEqual(parsed);
  });

  it("attributes extras to the wildcard allowing their namespace", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t" xmlns:t="urn:t" elementFormDefault="qualified">
  <xs:complexType name="Doc">
    <xs:sequence>
      <xs:any namespace="##other" processContents="skip" minOccurs="0" maxOccurs="unbounded"/>
      <xs:element name="mid" type="xs:string"/>
      <xs:any namespace="##targetNamespace" processContents="skip" minOccurs="0" maxOccurs="unbounded"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="doc" type="t:Doc"/>
</xs:schema>`);
    const parsed = parseXml(
      schema,
      '<doc xmlns="urn:t" xmlns:o="urn:other"><o:x/><mid>m</mid><y/></doc>',
    ) as Record<string, unknown>;
    expect(parsed).toEqual({ "{urn:other}x": "", mid: "m", "{urn:t}y": "" });
    const serialized = serializeXml(schema, parsed);
    // ##other extra before mid, ##targetNamespace extra after it.
    expect(serialized.indexOf(":x")).toBeLessThan(serialized.indexOf(":mid>"));
    expect(serialized.indexOf(":mid>")).toBeLessThan(serialized.indexOf(":y"));
    expect(parseXml(schema, serialized)).toEqual(parsed);
  });
});
