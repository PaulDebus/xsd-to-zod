import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { irToZod, parseXml, parseXsd, serializeXml } from "../src/index.js";
import { generateAndImport, withTempDirAsync } from "./helpers.js";

// Regression tests for the W3C sun/ms undefinedValue bucket: XML-namespace
// attributes used without a declaration (the xml prefix is bound by
// definition), and attribute defaults of an xs:list type arriving as scalars
// instead of arrays.

const XML_BASE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" elementFormDefault="qualified">
  <xs:import namespace="http://www.w3.org/XML/1998/namespace" />
  <xs:element name="root">
    <xs:complexType>
      <xs:attribute ref="xml:base" use="required" />
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const LIST_DEFAULT_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:attribute name="dims" default="1 2">
        <xs:simpleType>
          <xs:list itemType="xs:int" />
        </xs:simpleType>
      </xs:attribute>
      <xs:attribute name="names" type="xs:string" default="a b" />
      <xs:attribute name="tags" default="x y">
        <xs:simpleType>
          <xs:list itemType="xs:string" />
        </xs:simpleType>
      </xs:attribute>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const SINGLE_TOKEN_LIST_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:attribute name="dims" default="1">
        <xs:simpleType>
          <xs:list itemType="xs:int" />
        </xs:simpleType>
      </xs:attribute>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const EMPTY_LIST_DEFAULT_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:attribute name="dims" default="">
        <xs:simpleType>
          <xs:list itemType="xs:int" />
        </xs:simpleType>
      </xs:attribute>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const LIST_FIXED_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:attribute name="dims" fixed="1 2">
        <xs:simpleType>
          <xs:list itemType="xs:int" />
        </xs:simpleType>
      </xs:attribute>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const SINGLE_TOKEN_LIST_FIXED_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:attribute name="dims" fixed="1">
        <xs:simpleType>
          <xs:list itemType="xs:int" />
        </xs:simpleType>
      </xs:attribute>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const EMPTY_LIST_FIXED_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:attribute name="dims" fixed="">
        <xs:simpleType>
          <xs:list itemType="xs:int" />
        </xs:simpleType>
      </xs:attribute>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const LIST_FIXED_FLOAT_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:attribute name="vals" fixed="INF -INF">
        <xs:simpleType>
          <xs:list itemType="xs:double" />
        </xs:simpleType>
      </xs:attribute>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const LIST_FIXED_NAN_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:attribute name="val" fixed="NaN">
        <xs:simpleType>
          <xs:list itemType="xs:double" />
        </xs:simpleType>
      </xs:attribute>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const ELEMENT_LIST_FIXED_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="dims" fixed="1 2">
          <xs:simpleType>
            <xs:list itemType="xs:int" />
          </xs:simpleType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const generate = async (xsd: string): Promise<z.ZodType> => {
  let schema: z.ZodType | undefined;
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    const mod = await generateAndImport([file]);
    schema = Object.values(mod)[0] as z.ZodType;
  });
  if (schema === undefined) {
    throw new Error("no schema generated");
  }
  return schema;
};

describe("XML-namespace attributes without a declaration (#122)", () => {
  it("parses and re-serializes an undeclared xml:base attribute", async () => {
    const schema = await generate(XML_BASE_XSD);
    const parsed = parseXml(schema, '<root xml:base="a"/>');
    expect(parsed).toEqual({ "@base": "a" });

    // The xml prefix is bound by definition: serialized undeclared, not as a
    // generated ns0 prefix with an explicit declaration.
    const serialized = serializeXml(schema, parsed);
    expect(serialized).toContain('xml:base="a"');
    expect(serialized).not.toContain("xmlns:xml");
    expect(parseXml(schema, serialized)).toEqual(parsed);
  });
});

describe("xs:list attribute defaults (#122)", () => {
  it("applies list defaults as typed arrays, not scalars", async () => {
    const schema = await generate(LIST_DEFAULT_XSD);
    expect(parseXml(schema, "<root/>")).toEqual({
      "@dims": [1, 2],
      "@names": "a b",
      "@tags": ["x", "y"],
    });
  });

  it("still parses a present list attribute", async () => {
    const schema = await generate(LIST_DEFAULT_XSD);
    const parsed = parseXml(schema, '<root dims="3 4" tags="p q"/>');
    expect(parsed).toEqual({
      "@dims": [3, 4],
      "@names": "a b",
      "@tags": ["p", "q"],
    });
    expect(parseXml(schema, serializeXml(schema, parsed))).toEqual(parsed);
  });

  it("applies a single-token list default as a one-element array", async () => {
    const schema = await generate(SINGLE_TOKEN_LIST_XSD);
    expect(parseXml(schema, "<root/>")).toEqual({ "@dims": [1] });
  });

  it("applies an empty list default as an empty array", async () => {
    const schema = await generate(EMPTY_LIST_DEFAULT_XSD);
    expect(parseXml(schema, "<root/>")).toEqual({ "@dims": [] });
  });
});

describe("xs:list attribute fixed values", () => {
  it("accepts the fixed list value as a typed array and rejects others", async () => {
    const schema = await generate(LIST_FIXED_XSD);
    expect(parseXml(schema, '<root dims="1 2"/>')).toEqual({ "@dims": [1, 2] });
    expect(() => parseXml(schema, '<root dims="3 4"/>')).toThrow();
    expect(() => parseXml(schema, '<root dims="1"/>')).toThrow();
  });

  it("accepts a single-token fixed list value as a one-element array", async () => {
    const schema = await generate(SINGLE_TOKEN_LIST_FIXED_XSD);
    expect(parseXml(schema, '<root dims="1"/>')).toEqual({ "@dims": [1] });
    expect(() => parseXml(schema, '<root dims="2"/>')).toThrow();
  });

  it("accepts an empty fixed list value as an empty array", async () => {
    const schema = await generate(EMPTY_LIST_FIXED_XSD);
    expect(parseXml(schema, '<root dims=""/>')).toEqual({ "@dims": [] });
    expect(() => parseXml(schema, '<root dims="1"/>')).toThrow();
  });

  it("emits a typed array literal constraint, not a scalar literal", async () => {
    let schemas = "";
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, LIST_FIXED_XSD);
      schemas = irToZod(parseXsd([file])).schemas;
    });
    expect(schemas).toContain(
      ".refine((val) => val.length === 2 && val.every((item, i) => Object.is(item, [1, 2][i])), { message: 'value does not match the fixed value' })",
    );
    expect(schemas).not.toContain("z.literal(NaN)");
  });

  it("substitutes the fixed list value when the attribute is absent", async () => {
    const schema = await generate(LIST_FIXED_XSD);
    const parsed = parseXml(schema, "<root/>");
    expect(parsed).toEqual({ "@dims": [1, 2] });
    const serialized = serializeXml(schema, parsed);
    expect(serialized).toContain('dims="1 2"');
    expect(parseXml(schema, serialized)).toEqual(parsed);
  });

  it("round-trips a fixed list attribute through parse and serialize", async () => {
    const schema = await generate(LIST_FIXED_XSD);
    const parsed = parseXml(schema, '<root dims="1 2"/>');
    expect(parsed).toEqual({ "@dims": [1, 2] });
    const serialized = serializeXml(schema, parsed);
    expect(serialized).toContain('dims="1 2"');
    expect(parseXml(schema, serialized)).toEqual(parsed);
  });

  it("accepts float/double special lexicals in a fixed list value", async () => {
    const schema = await generate(LIST_FIXED_FLOAT_XSD);
    expect(parseXml(schema, '<root vals="INF -INF"/>')).toEqual({
      "@vals": [Infinity, -Infinity],
    });
    expect(parseXml(schema, "<root/>")).toEqual({ "@vals": [Infinity, -Infinity] });
    expect(() => parseXml(schema, '<root vals="1 2"/>')).toThrow();
    const parsed = parseXml(schema, "<root/>");
    expect(serializeXml(schema, parsed)).toContain('vals="INF -INF"');
  });

  it("accepts a NaN fixed list value", async () => {
    const schema = await generate(LIST_FIXED_NAN_XSD);
    expect(parseXml(schema, '<root val="NaN"/>')).toEqual({ "@val": [NaN] });
    expect(parseXml(schema, "<root/>")).toEqual({ "@val": [NaN] });
    expect(() => parseXml(schema, '<root val="1"/>')).toThrow();
  });

  it("substitutes a fixed list value on a present-but-empty element", async () => {
    const schema = await generate(ELEMENT_LIST_FIXED_XSD);
    expect(parseXml(schema, "<root><dims/></root>")).toEqual({ dims: [1, 2] });
    expect(parseXml(schema, "<root><dims>1 2</dims></root>")).toEqual({ dims: [1, 2] });
    expect(() => parseXml(schema, "<root><dims>3 4</dims></root>")).toThrow();
  });
});

describe("xs:list root element fixed/default values", () => {
  const ROOT_LIST_FIXED_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="dims" fixed="1 2">
    <xs:simpleType>
      <xs:list itemType="xs:int" />
    </xs:simpleType>
  </xs:element>
</xs:schema>`;

  const ROOT_LIST_DEFAULT_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="dims" default="1 2">
    <xs:simpleType>
      <xs:list itemType="xs:int" />
    </xs:simpleType>
  </xs:element>
</xs:schema>`;

  it("emits a typed array fixed value, not a scalar literal", async () => {
    let schemas = "";
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, ROOT_LIST_FIXED_XSD);
      schemas = irToZod(parseXsd([file])).schemas;
    });
    expect(schemas).toContain("fixedValue: [1, 2]");
    expect(schemas).not.toContain("NaN");
  });

  it("substitutes the fixed list value on a present-but-empty root", async () => {
    const schema = await generate(ROOT_LIST_FIXED_XSD);
    expect(parseXml(schema, "<dims/>")).toEqual([1, 2]);
    expect(parseXml(schema, "<dims>1 2</dims>")).toEqual([1, 2]);
    // Roots never encode the fixed constraint in the schema (same as scalar
    // roots): present content is validated as the bare list type.
    expect(parseXml(schema, "<dims>3 4</dims>")).toEqual([3, 4]);
    expect(serializeXml(schema, [1, 2])).toBe("<dims>1 2</dims>");
  });

  it("substitutes the default list value on a present-but-empty root", async () => {
    const schema = await generate(ROOT_LIST_DEFAULT_XSD);
    expect(parseXml(schema, "<dims/>")).toEqual([1, 2]);
    expect(parseXml(schema, "<dims>3 4</dims>")).toEqual([3, 4]);
  });
});
