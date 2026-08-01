import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseXml, parseXsd, serializeXml } from "../src/index.js";
import { findRootSchema, generateAndImport, withTempDirAsync } from "./helpers.js";

// Mixed content models (complexType mixed="true"): character data lands in an
// optional `_text` field alongside the declared child elements.

const importFor = async (xsd: string): Promise<Record<string, unknown>> => {
  let mod: Record<string, unknown> | undefined;
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    mod = await generateAndImport([file]);
  });
  if (!mod) {
    throw new Error("schema module was not generated");
  }
  return mod;
};

const NOTE_SCHEMA = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:mixed" xmlns:t="urn:mixed" elementFormDefault="qualified">
  <xs:complexType name="Note" mixed="true">
    <xs:sequence>
      <xs:element name="b" type="xs:string" minOccurs="0" maxOccurs="unbounded"/>
    </xs:sequence>
    <xs:attribute name="lang" type="xs:string"/>
  </xs:complexType>
  <xs:element name="note" type="t:Note"/>
</xs:schema>`;

describe("mixed content models", () => {
  it("captures text and child elements of a mixed type", async () => {
    const mod = await importFor(NOTE_SCHEMA);
    const xml = `<note xmlns="urn:mixed" lang="en">Dear <b>reader</b>, hi</note>`;
    const schema = findRootSchema(mod, xml);
    // The parser concatenates the text segments; interleaving with the child
    // elements is not preserved.
    expect(parseXml(schema, xml)).toEqual({
      "@lang": "en",
      _text: "Dear , hi",
      b: ["reader"],
    });
  });

  it("omits _text when the element has no character data", async () => {
    const mod = await importFor(NOTE_SCHEMA);
    const xml = `<note xmlns="urn:mixed" lang="en"><b>x</b></note>`;
    const data = parseXml(findRootSchema(mod, xml), xml) as Record<string, unknown>;
    expect(data).toEqual({ "@lang": "en", b: ["x"] });
    expect("_text" in data).toBe(false);
  });

  it("round-trips through serializeXml", async () => {
    const mod = await importFor(NOTE_SCHEMA);
    const xml = `<note xmlns="urn:mixed" lang="en">Dear <b>reader</b>, hi</note>`;
    const schema = findRootSchema(mod, xml);
    const data = parseXml(schema, xml);
    const serialized = serializeXml(schema, data);
    // Text is written before the child elements.
    expect(serialized).toContain(">Dear , hi<");
    expect(parseXml(schema, serialized)).toEqual(data);
  });

  it("supports mixed on an inline anonymous complex type", async () => {
    const mod = await importFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="p">
    <xs:complexType mixed="true">
      <xs:sequence>
        <xs:element name="i" type="xs:string" minOccurs="0"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`);
    const xml = `<p>hi<i>x</i></p>`;
    expect(parseXml(findRootSchema(mod, xml), xml)).toEqual({ _text: "hi", i: "x" });
  });

  it("supports mixed on xs:complexContent without duplicating _text", async () => {
    let fields: { kind: string }[] = [];
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(
        file,
        `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:mixed" xmlns:t="urn:mixed" elementFormDefault="qualified">
  <xs:complexType name="Base" mixed="true">
    <xs:sequence>
      <xs:element name="a" type="xs:string" minOccurs="0"/>
    </xs:sequence>
  </xs:complexType>
  <xs:complexType name="Derived">
    <xs:complexContent mixed="true">
      <xs:extension base="t:Base">
        <xs:sequence>
          <xs:element name="b" type="xs:string" minOccurs="0"/>
        </xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
  <xs:element name="doc" type="t:Derived"/>
</xs:schema>`,
      );
      // The derived type restates mixed on an already-mixed base: the merged
      // fields must carry exactly one text field.
      fields = parseXsd([file]).complexTypes["{urn:mixed}Derived"]?.fields ?? [];
      const mod = await generateAndImport([file]);
      const xml = `<doc xmlns="urn:mixed">t<a>1</a><b>2</b></doc>`;
      expect(parseXml(findRootSchema(mod, xml), xml)).toEqual({ _text: "t", a: "1", b: "2" });
    });
    expect(fields.filter((f) => f.kind === "text")).toHaveLength(1);
  });
});
