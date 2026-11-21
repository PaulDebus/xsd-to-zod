import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { irToZod, parseXsd } from "../src/compiler.js";
import { parseXml, safeParseXml, serializeXml } from "../src/index.js";
import { generateAndImport, withTempDirAsync } from "./helpers.js";

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="ValueType">
    <xs:attribute name="text" type="xs:int" use="required"/>
  </xs:complexType>
  <xs:complexType name="Root">
    <xs:sequence>
      <xs:element name="count" type="ValueType"/>
      <xs:choice maxOccurs="unbounded">
        <xs:element name="a" type="xs:int"/>
        <xs:element name="b" type="xs:string"/>
      </xs:choice>
      <xs:element name="tail" type="xs:string" minOccurs="0"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="root" type="Root"/>
</xs:schema>`;

const generatedFor = async (): Promise<string> => {
  let source = "";
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, XSD);
    source = irToZod(await parseXsd([file])).schemas;
  });
  return source;
};

const moduleFor = async (): Promise<Record<string, unknown>> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, XSD);
    mod = await generateAndImport([file]);
  });
  return mod;
};

describe("default output shape", () => {
  it("collapses a lone-attribute wrapper slot to its scalar type", async () => {
    const source = await generatedFor();
    expect(source).toContain(`"count": number;`);
    expect(source).not.toContain(`"count": ValueType;`);
  });

  it("drops the @ prefix from attribute keys", async () => {
    const source = await generatedFor();
    expect(source).toContain(`"text": number;`);
    expect(source).not.toContain(`"@text"`);
  });

  it("emits a repeated choice as one tagged array", async () => {
    const source = await generatedFor();
    expect(source).toContain(`"choice": ({ "a": number } | { "b": string })[];`);
    expect(source).not.toContain(`"a"?:`);
  });

  it("falls back to a numeric suffix when a field named choice already exists", async () => {
    const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="T">
    <xs:sequence>
      <xs:element name="choice" type="xs:string"/>
      <xs:choice maxOccurs="unbounded">
        <xs:element name="a" type="xs:string"/>
        <xs:element name="b" type="xs:string"/>
      </xs:choice>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="root" type="T"/>
</xs:schema>`;
    let source = "";
    let mod: Record<string, unknown> = {};
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, xsd);
      source = irToZod(await parseXsd([file])).schemas;
      mod = await generateAndImport([file]);
    });
    expect(source).toContain(`"choice": string;`);
    expect(source).toContain(`"choice2": ({ "a": string } | { "b": string })[];`);
    const schema = mod["rootSchema"] as never;
    const xml = `<root><choice>x</choice><a>1</a><b>2</b></root>`;
    const parsed = parseXml(schema, xml) as Record<string, unknown>;
    expect(parsed).toEqual({ choice: "x", choice2: [{ a: "1" }, { b: "2" }] });
    expect(serializeXml(schema, parsed as never)).toBe(xml);
  });

  it("keeps attribute keys stable alongside a choice-named element and synthetic array", async () => {
    const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="T">
    <xs:sequence>
      <xs:element name="choice" type="xs:string"/>
      <xs:choice maxOccurs="unbounded">
        <xs:element name="a" type="xs:string"/>
        <xs:element name="b" type="xs:string"/>
      </xs:choice>
    </xs:sequence>
    <xs:attribute name="id" type="xs:string" use="required"/>
  </xs:complexType>
  <xs:element name="root" type="T"/>
</xs:schema>`;
    let source = "";
    let mod: Record<string, unknown> = {};
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, xsd);
      source = irToZod(await parseXsd([file])).schemas;
      mod = await generateAndImport([file]);
    });
    expect(source).toContain(`"choice": string;`);
    expect(source).toContain(`"choice2": ({ "a": string } | { "b": string })[];`);
    expect(source).toContain(`"id": string;`);
    const schema = mod["rootSchema"] as never;
    const xml = `<root id="r"><choice>x</choice><a>1</a><b>2</b></root>`;
    const parsed = parseXml(schema, xml) as Record<string, unknown>;
    expect(parsed).toEqual({ id: "r", choice: "x", choice2: [{ a: "1" }, { b: "2" }] });
    expect(serializeXml(schema, parsed as never)).toBe(xml);
  });

  it("parses wrappers as scalars and choices as tagged items in document order", async () => {
    const mod = await moduleFor();
    const schema = mod["rootSchema"] as never;
    const parsed = parseXml(
      schema,
      `<root><count text="7"/><a>1</a><b>x</b><a>2</a><tail>z</tail></root>`,
    );
    expect(parsed).toEqual({
      count: 7,
      choice: [{ a: 1 }, { b: "x" }, { a: 2 }],
      tail: "z",
    });
  });

  it("serializes the collapsed shape back to the original XML", async () => {
    const mod = await moduleFor();
    const schema = mod["rootSchema"] as never;
    const xml = `<root><count text="7"/><a>1</a><b>x</b><a>2</a><tail>z</tail></root>`;
    const serialized = serializeXml(schema, parseXml(schema, xml));
    expect(serialized).toBe(xml);
  });

  it("serializes hand-built collapsed data", async () => {
    const mod = await moduleFor();
    const schema = mod["rootSchema"] as never;
    expect(
      serializeXml(schema, {
        count: 7,
        choice: [{ b: "x" }, { a: 1 }],
        tail: "z",
      } as never),
    ).toBe(`<root><count text="7"/><b>x</b><a>1</a><tail>z</tail></root>`);
  });

  it("rejects a required repeated choice with no item", async () => {
    const mod = await moduleFor();
    const schema = mod["rootSchema"] as never;
    const result = safeParseXml(schema, `<root><count text="7"/><tail>z</tail></root>`);
    expect(result.success).toBe(false);
  });

  it("reports a missing required wrapper attribute against the element", async () => {
    const mod = await moduleFor();
    const schema = mod["rootSchema"] as never;
    expect(() => parseXml(schema, `<root><count/><tail>z</tail></root>`)).toThrow(
      /element "count" is missing its required attribute "text"/,
    );
  });
});

const CONCEPT_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           xmlns:t="urn:t" targetNamespace="urn:t" elementFormDefault="qualified">
  <xs:complexType name="Concept">
    <xs:choice maxOccurs="unbounded">
      <xs:element name="Name" type="xs:string"/>
      <xs:element name="Status" type="xs:string"/>
    </xs:choice>
  </xs:complexType>
  <xs:element name="root" type="t:Concept"/>
</xs:schema>`;

// An unrelated complex type deriving from xs:string. It used to veto the
// Concept choice collapse through hasDerivedTypes, changing the emitted shape.
const CONCEPT_WITH_TEXT_XSD = CONCEPT_XSD.replace(
  "</xs:schema>",
  `  <xs:complexType name="Text">
    <xs:simpleContent>
      <xs:extension base="xs:string">
        <xs:attribute name="language" type="xs:language"/>
      </xs:extension>
    </xs:simpleContent>
  </xs:complexType>
</xs:schema>`,
);

const generatedSource = async (xsd: string): Promise<string> => {
  let source = "";
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    source = irToZod(await parseXsd([file])).schemas;
  });
  return source;
};

describe("repeated-choice collapse locality", () => {
  it("emits the same collapsed shape with and without an unrelated string-derived type", async () => {
    for (const xsd of [CONCEPT_XSD, CONCEPT_WITH_TEXT_XSD]) {
      const source = await generatedSource(xsd);
      expect(source).toContain(`"choice": ({ "Name": string } | { "Status": string })[];`);
      expect(source).not.toContain(`"Name"?:`);
      expect(source).not.toContain(`"Status"?:`);
    }
  });

  it("still preserves a complex simpleContent xsi:type on a collapsed branch", async () => {
    let mod: Record<string, unknown> = {};
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, CONCEPT_WITH_TEXT_XSD);
      mod = await generateAndImport([file]);
    });
    const schema = mod["rootSchema"] as never;
    const xml = `<root xmlns="urn:t" xmlns:t="urn:t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Name xsi:type="t:Text" language="en">DE</Name><Status>active</Status></root>`;
    const parsed = parseXml(schema, xml) as Record<string, unknown>;
    expect(parsed).toEqual({ choice: [{ Name: "DE" }, { Status: "active" }] });
    const serialized = serializeXml(schema, parsed as never);
    expect(serialized).toContain('xsi:type="t:Text"');
    expect(serialized).toContain('language="en"');
    expect(parseXml(schema, serialized)).toEqual(parsed);
  });
});

describe("repeated-choice collapse through extension", () => {
  const ISO_SHAPED_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           xmlns:t="urn:t" targetNamespace="urn:t" elementFormDefault="qualified">
  <xs:complexType name="Base" abstract="true">
    <xs:choice maxOccurs="unbounded">
      <xs:element name="HasPartRef" type="xs:string"/>
      <xs:element name="IsSubtypeOfRef" type="xs:string"/>
    </xs:choice>
  </xs:complexType>
  <xs:complexType name="Mid">
    <xs:complexContent>
      <xs:extension base="t:Base">
        <xs:choice maxOccurs="unbounded">
          <xs:element name="HasObjectTypeRef" type="xs:string"/>
          <xs:element name="HasPropertyRef" type="xs:string"/>
        </xs:choice>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
  <xs:complexType name="Leaf">
    <xs:complexContent>
      <xs:extension base="t:Mid">
        <xs:choice maxOccurs="unbounded">
          <xs:element name="HasGroupOfPropertiesRef" type="xs:string"/>
          <xs:element name="HasUnitRef" type="xs:string"/>
        </xs:choice>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
  <xs:complexType name="ConceptType">
    <xs:choice maxOccurs="unbounded">
      <xs:element name="Name" type="xs:string"/>
      <xs:element name="Status" type="xs:string"/>
    </xs:choice>
  </xs:complexType>
  <xs:complexType name="PropertyType">
    <xs:choice maxOccurs="unbounded">
      <xs:element name="Label" type="xs:string"/>
      <xs:element name="Value" type="xs:string"/>
    </xs:choice>
  </xs:complexType>
  <xs:complexType name="Library">
    <xs:choice maxOccurs="unbounded">
      <xs:element name="Concept" type="t:ConceptType"/>
      <xs:element name="Property" type="t:PropertyType"/>
    </xs:choice>
  </xs:complexType>
  <xs:element name="library" type="t:Library"/>
</xs:schema>`;

  it("collapses every inherited repeated-choice group consistently", async () => {
    const source = await generatedSource(ISO_SHAPED_XSD);
    expect(source).toContain(
      `"choice": ({ "HasPartRef": string } | { "IsSubtypeOfRef": string })[];`,
    );
    expect(source).toContain(`"choice2": ({ "HasObjectTypeRef": string }`);
    expect(source).toContain(`"choice3": ({ "HasGroupOfPropertiesRef": string }`);
    expect(source).toContain(`"choice": ({ "Concept": ConceptType } | { "Property":`);
    expect(source).not.toContain(`"HasPartRef"?:`);
    expect(source).not.toContain(`"HasObjectTypeRef"?:`);
  });
});

const OPTIONAL_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="Root">
    <xs:sequence>
      <xs:choice minOccurs="0" maxOccurs="2">
        <xs:element name="p">
          <xs:complexType>
            <xs:sequence>
              <xs:element name="x" type="xs:int"/>
            </xs:sequence>
          </xs:complexType>
        </xs:element>
        <xs:element name="q" type="xs:string"/>
      </xs:choice>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="root" type="Root"/>
</xs:schema>`;

const WRAPPER_ARRAY_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="ValueType">
    <xs:attribute name="text" type="xs:string" use="required"/>
  </xs:complexType>
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="w" type="ValueType" maxOccurs="unbounded"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

describe("default output shape (optional and object branches)", () => {
  it("makes an optional choice array omit when empty and round-trip object branches", async () => {
    let mod: Record<string, unknown> = {};
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, OPTIONAL_XSD);
      mod = await generateAndImport([file]);
    });
    const schema = mod["rootSchema"] as never;
    expect(parseXml(schema, `<root><p><x>1</x></p><q>a</q></root>`)).toEqual({
      choice: [{ p: { x: 1 } }, { q: "a" }],
    });
    expect(parseXml(schema, `<root/>`)).toEqual({});
    expect(serializeXml(schema, { choice: [{ p: { x: 1 } }, { q: "a" }] } as never)).toBe(
      `<root><p><x>1</x></p><q>a</q></root>`,
    );
    expect(safeParseXml(schema, `<root><p><x>1</x></p><q>a</q><q>b</q></root>`).success).toBe(
      false,
    );
  });

  it("collapses a repeated wrapper slot to a scalar array", async () => {
    let mod: Record<string, unknown> = {};
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, WRAPPER_ARRAY_XSD);
      mod = await generateAndImport([file]);
    });
    const schema = mod["rootSchema"] as never;
    const parsed = parseXml(schema, `<root><w text="1.50"/><w text="2.25"/></root>`);
    expect(parsed).toEqual({ w: ["1.50", "2.25"] });
    expect(serializeXml(schema, parsed)).toBe(`<root><w text="1.50"/><w text="2.25"/></root>`);
  });
});

const ATTRIBUTE_NAMING_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="Item">
    <xs:sequence>
      <xs:element name="name" type="xs:string"/>
    </xs:sequence>
    <xs:attribute name="name" type="xs:string"/>
    <xs:attribute name="xsiType" type="xs:string"/>
    <xs:attribute name="id" type="xs:string" use="required"/>
  </xs:complexType>
  <xs:element name="root" type="Item"/>
</xs:schema>`;

const WILDCARD_ATTRIBUTE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="Item">
    <xs:sequence>
      <xs:element name="name" type="xs:string"/>
    </xs:sequence>
    <xs:attribute name="id" type="xs:string"/>
    <xs:anyAttribute namespace="##any" processContents="lax"/>
  </xs:complexType>
  <xs:element name="root" type="Item"/>
</xs:schema>`;

describe("default attribute keys", () => {
  it("keeps @ on an attribute whose bare key collides with an element", async () => {
    let source = "";
    let warnings: string[] = [];
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, ATTRIBUTE_NAMING_XSD);
      const result = irToZod(await parseXsd([file]));
      source = result.schemas;
      warnings = result.warnings;
    });
    expect(source).toContain(`"id": string;`);
    expect(source).toContain(`"name": string;`);
    expect(source).toContain(`"@name"?: string | undefined;`);
    expect(source).toContain(`"@xsiType"?: string | undefined;`);
    expect(source).toContain(`// Attribute "name" keeps the "@" prefix`);
    expect(warnings.some((w) => w.includes(`[naming-collision]`) && w.includes(`"name"`))).toBe(
      true,
    );
  });

  it("round-trips a colliding attribute and a clean attribute", async () => {
    let mod: Record<string, unknown> = {};
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, ATTRIBUTE_NAMING_XSD);
      mod = await generateAndImport([file]);
    });
    const schema = mod["rootSchema"] as never;
    const xml = `<root name="attr" xsiType="t" id="x"><name>elem</name></root>`;
    const parsed = parseXml(schema, xml);
    expect(parsed).toEqual({ name: "elem", "@name": "attr", "@xsiType": "t", id: "x" });
    expect(serializeXml(schema, parsed)).toBe(xml);
  });

  it("keeps @ on wildcard-captured attributes", async () => {
    let mod: Record<string, unknown> = {};
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, WILDCARD_ATTRIBUTE_XSD);
      mod = await generateAndImport([file]);
    });
    const schema = mod["rootSchema"] as never;
    const xml = `<root id="1" extra="yes"><name>x</name></root>`;
    const parsed = parseXml(schema, xml);
    expect(parsed).toEqual({ name: "x", id: "1", "@extra": "yes" });
    const serialized = serializeXml(schema, parsed);
    expect(serialized).toContain('id="1"');
    expect(serialized).toContain('extra="yes"');
    expect(parseXml(schema, serialized)).toEqual(parsed);
  });
});
