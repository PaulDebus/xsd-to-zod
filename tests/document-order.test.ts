import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { parseXml, serializeXml } from "../src/index.js";
import { generateAndImport, withTempDirAsync } from "./helpers.js";

// Interleaved repeated compositors: the grouped data shape loses cross-tag
// document order, so the parser records it per object (documentOrderStore)
// and the serializer replays it. Data that no longer matches the recording —
// and data that was never parsed — falls back to schema-order emission.

const schemaFor = async (xsd: string): Promise<z.ZodType> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    mod = await generateAndImport([file]);
  });
  return Object.values(mod)[0] as z.ZodType;
};

const namedSchemaFor = async (xsd: string, name: string): Promise<z.ZodType> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    mod = await generateAndImport([file]);
  });
  return mod[name] as z.ZodType;
};

const REPEATING_CHOICE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="T">
    <xs:choice maxOccurs="unbounded">
      <xs:element name="a" type="xs:string"/>
      <xs:element name="b" type="xs:string"/>
    </xs:choice>
  </xs:complexType>
  <xs:element name="t" type="T"/>
</xs:schema>`;

describe("document order of interleaved repeated compositors", () => {
  it("round-trips a repeating choice in document order", async () => {
    const schema = await schemaFor(REPEATING_CHOICE_XSD);
    const xml = "<t><a>1</a><b>2</b><a>3</a><b>4</b></t>";
    expect(parseXml(schema, xml)).toEqual({ a: ["1", "3"], b: ["2", "4"] });
    expect(serializeXml(schema, parseXml(schema, xml))).toBe(xml);
  });

  it("round-trips interleaved sequence groups in document order", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="T">
    <xs:sequence maxOccurs="unbounded">
      <xs:element name="a" type="xs:string"/>
      <xs:element name="b" type="xs:string" minOccurs="0"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="t" type="T"/>
</xs:schema>`);
    const xml = "<t><a>1</a><b>2</b><a>3</a></t>";
    expect(serializeXml(schema, parseXml(schema, xml))).toBe(xml);
  });

  it("keeps document order through nested objects", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="Item"><xs:sequence>
    <xs:element name="id" type="xs:string"/>
  </xs:sequence></xs:complexType>
  <xs:complexType name="T">
    <xs:choice maxOccurs="unbounded">
      <xs:element name="x" type="Item"/>
      <xs:element name="y" type="Item"/>
    </xs:choice>
  </xs:complexType>
  <xs:element name="t" type="T"/>
</xs:schema>`);
    const xml = "<t><x><id>1</id></x><y><id>2</id></y><x><id>3</id></x></t>";
    expect(serializeXml(schema, parseXml(schema, xml))).toBe(xml);
  });

  it("preserves order on the validate:false fast path", async () => {
    const schema = await schemaFor(REPEATING_CHOICE_XSD);
    const xml = "<t><b>1</b><a>2</a><b>3</b></t>";
    const data = parseXml(schema, xml, { validate: false });
    expect(serializeXml(schema, data)).toBe(xml);
  });

  it("in-place edits keep the recorded order", async () => {
    const schema = await schemaFor(REPEATING_CHOICE_XSD);
    const data = parseXml(schema, "<t><a>1</a><b>2</b><a>3</a></t>") as {
      a: string[];
      b: string[];
    };
    data.a[1] = "changed";
    expect(serializeXml(schema, data)).toBe("<t><a>1</a><b>2</b><a>changed</a></t>");
  });

  it("reordering within one field's array is honored", async () => {
    const schema = await schemaFor(REPEATING_CHOICE_XSD);
    const data = parseXml(schema, "<t><a>1</a><b>2</b><a>3</a></t>") as {
      a: string[];
      b: string[];
    };
    data.a.reverse();
    expect(serializeXml(schema, data)).toBe("<t><a>3</a><b>2</b><a>1</a></t>");
  });

  it("added occurrences fall back to schema order", async () => {
    const schema = await schemaFor(REPEATING_CHOICE_XSD);
    const data = parseXml(schema, "<t><a>1</a><b>2</b><a>3</a></t>") as {
      a: string[];
      b: string[];
    };
    data.a.push("9");
    expect(serializeXml(schema, data)).toBe("<t><a>1</a><a>3</a><a>9</a><b>2</b></t>");
  });

  it("removed occurrences fall back to schema order", async () => {
    const schema = await schemaFor(REPEATING_CHOICE_XSD);
    const data = parseXml(schema, "<t><a>1</a><b>2</b><a>3</a></t>") as {
      a?: string[];
      b?: string[];
    };
    delete data.b;
    expect(serializeXml(schema, data)).toBe("<t><a>1</a><a>3</a></t>");
  });

  it("hand-built data serializes in schema order", async () => {
    const schema = await schemaFor(REPEATING_CHOICE_XSD);
    expect(serializeXml(schema, { a: ["1", "3"], b: ["2"] })).toBe(
      "<t><a>1</a><a>3</a><b>2</b></t>",
    );
  });

  it("wildcard extras interleave with declared fields in document order", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
  xmlns:n="urn:other" elementFormDefault="qualified">
  <xs:complexType name="T">
    <xs:sequence>
      <xs:element name="a" type="xs:string" maxOccurs="unbounded"/>
      <xs:any namespace="urn:other" processContents="skip" maxOccurs="unbounded"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="t" type="T"/>
</xs:schema>`);
    const xml = '<t xmlns:n="urn:other"><a>1</a><n:x>2</n:x><a>3</a></t>';
    const data = parseXml(schema, xml);
    expect(serializeXml(schema, data)).toContain(">1</");
    const serialized = serializeXml(schema, data);
    // The extra sits between the two declared occurrences, not flushed after.
    expect(serialized.indexOf(">1<")).toBeLessThan(serialized.indexOf(">2<"));
    expect(serialized.indexOf(">2<")).toBeLessThan(serialized.indexOf(">3<"));
  });

  it("substitution-group members keep their document order", async () => {
    const schema = await namedSchemaFor(
      `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="T">
    <xs:sequence>
      <xs:element ref="head" maxOccurs="unbounded"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="head" type="xs:string"/>
  <xs:element name="member" substitutionGroup="head" type="xs:string"/>
  <xs:element name="t" type="T"/>
</xs:schema>`,
      "tSchema",
    );
    const xml = "<t><head>1</head><member>2</member><head>3</head></t>";
    expect(serializeXml(schema, parseXml(schema, xml))).toBe(xml);
  });
});
