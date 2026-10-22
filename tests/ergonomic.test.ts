import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { irToZod, parseXml, parseXsd, safeParseXml, serializeXml } from "../src/index.js";
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

const generatedFor = async (ergonomic: boolean): Promise<string> => {
  let source = "";
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, XSD);
    source = irToZod(await parseXsd([file]), { ergonomic }).schemas;
  });
  return source;
};

const moduleFor = async (): Promise<Record<string, unknown>> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, XSD);
    mod = await generateAndImport([file], { ergonomic: true });
  });
  return mod;
};

describe("--ergonomic output shape", () => {
  it("collapses a lone-attribute wrapper slot to its scalar type", async () => {
    const source = await generatedFor(true);
    expect(source).toContain(`"count": number;`);
    expect(source).not.toContain(`"count": ValueType;`);
  });

  it("keeps the wrapper object without the flag", async () => {
    const source = await generatedFor(false);
    expect(source).toContain(`"count": ValueType;`);
  });

  it("emits a repeated choice as one tagged array", async () => {
    const source = await generatedFor(true);
    expect(source).toContain(`"_choice": ({ "a": number } | { "b": string })[];`);
    expect(source).not.toContain(`"a"?:`);
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
      _choice: [{ a: 1 }, { b: "x" }, { a: 2 }],
      tail: "z",
    });
  });

  it("serializes the ergonomic shape back to the original XML", async () => {
    const mod = await moduleFor();
    const schema = mod["rootSchema"] as never;
    const xml = `<root><count text="7"/><a>1</a><b>x</b><a>2</a><tail>z</tail></root>`;
    const serialized = serializeXml(schema, parseXml(schema, xml));
    expect(serialized).toBe(xml);
  });

  it("serializes hand-built ergonomic data", async () => {
    const mod = await moduleFor();
    const schema = mod["rootSchema"] as never;
    expect(
      serializeXml(schema, {
        count: 7,
        _choice: [{ b: "x" }, { a: 1 }],
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

describe("--ergonomic output shape (optional and object branches)", () => {
  it("makes an optional choice array omit when empty and round-trip object branches", async () => {
    let mod: Record<string, unknown> = {};
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, OPTIONAL_XSD);
      mod = await generateAndImport([file], { ergonomic: true });
    });
    const schema = mod["rootSchema"] as never;
    expect(parseXml(schema, `<root><p><x>1</x></p><q>a</q></root>`)).toEqual({
      _choice: [{ p: { x: 1 } }, { q: "a" }],
    });
    expect(parseXml(schema, `<root/>`)).toEqual({});
    expect(serializeXml(schema, { _choice: [{ p: { x: 1 } }, { q: "a" }] } as never)).toBe(
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
      mod = await generateAndImport([file], { ergonomic: true });
    });
    const schema = mod["rootSchema"] as never;
    const parsed = parseXml(schema, `<root><w text="1.50"/><w text="2.25"/></root>`);
    expect(parsed).toEqual({ w: ["1.50", "2.25"] });
    expect(serializeXml(schema, parsed)).toBe(`<root><w text="1.50"/><w text="2.25"/></root>`);
  });
});
