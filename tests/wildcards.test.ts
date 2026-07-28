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
