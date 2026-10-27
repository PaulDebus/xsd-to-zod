import { describe, expect, it } from "vitest";
import { parseXsd } from "../src/parseXsd.js";
import { parseXml, safeParseXml, serializeXml } from "../src/runtime.js";
import { validateXml } from "../src/validate.js";
import { findRootSchemas, generateAndImport } from "./helpers.js";
import { compileReviewSchema, withReviewFiles } from "./reviewHelpers.js";

describe("schema collection correctness", () => {
  it.each(["extension", "restriction"])(
    "inherits simple-content attributes once through %s",
    async (kind) => {
      const own =
        kind === "extension"
          ? '<xs:attribute name="b" type="xs:string"/>'
          : '<xs:attribute name="a" type="xs:string" use="required"/>';
      const { schema, xsd, generated } =
        await compileReviewSchema(`<xs:complexType name="Base"><xs:simpleContent><xs:extension base="xs:string"><xs:attribute name="a" type="xs:string" use="required"/></xs:extension></xs:simpleContent></xs:complexType>
      <xs:complexType name="Derived"><xs:simpleContent><xs:${kind} base="Base">${own}</xs:${kind}></xs:simpleContent></xs:complexType><xs:element name="root" type="Derived"/>`);
      const value = parseXml(schema, '<root a="yes">text</root>');
      expect(value).toEqual({ _text: "text", "@a": "yes" });
      expect(safeParseXml(schema, "<root>text</root>").success).toBe(false);
      expect(await validateXml(serializeXml(schema, value), xsd)).toEqual({ valid: true });
      expect(generated.schemas).not.toContain('"@a": string;\n  "@a"');
    },
  );

  it("inherits required attributes through complex restrictions and honors prohibition", async () => {
    const { schema, xsd } = await compileReviewSchema(
      `<xs:complexType name="Base"><xs:attribute name="a" type="xs:string" use="required"/><xs:attribute name="b" type="xs:string"/></xs:complexType><xs:complexType name="Derived"><xs:complexContent><xs:restriction base="Base"><xs:attribute name="b" use="prohibited"/></xs:restriction></xs:complexContent></xs:complexType><xs:element name="root" type="Derived"/>`,
    );
    expect(safeParseXml(schema, "<root/>").success).toBe(false);
    const data = parseXml(schema, '<root a="kept"/>');
    expect(data).toEqual({ "@a": "kept" });
    expect(safeParseXml(schema, '<root a="kept" b="forbidden"/>').success).toBe(false);
    expect(await validateXml(serializeXml(schema, data), xsd)).toEqual({ valid: true });
  });

  it("lets attribute wildcards admit names excluded from declared attribute uses", async () => {
    const { schema, xsd } = await compileReviewSchema(
      '<xs:element name="root"><xs:complexType><xs:attribute name="a" use="prohibited"/><xs:anyAttribute namespace="##local" processContents="lax"/></xs:complexType></xs:element>',
    );
    const xml = '<root a="allowed-by-wildcard"/>';
    expect(await validateXml(xml, xsd)).toEqual({ valid: true });
    expect(safeParseXml(schema, xml).success).toBe(true);
  });

  it("preserves global attribute defaults and fixed values through refs", async () => {
    const { schema } = await compileReviewSchema(
      `<xs:attribute name="a" type="xs:int" fixed="7"/><xs:attribute name="b" type="xs:int" default="9"/><xs:element name="root"><xs:complexType><xs:attribute ref="a"/><xs:attribute ref="b"/></xs:complexType></xs:element>`,
    );
    expect(parseXml(schema, "<root/>")).toEqual({ "@a": 7, "@b": 9 });
    expect(safeParseXml(schema, '<root a="8"/>').success).toBe(false);
  });

  it("keeps explicit declarations when anonymous type names collide", async () => {
    const { schema } = await compileReviewSchema(
      `<xs:complexType name="anonymous_s_Type"><xs:sequence><xs:element name="other" type="xs:int"/></xs:sequence></xs:complexType><xs:element name="s"><xs:complexType><xs:sequence><xs:element name="own" type="xs:int"/></xs:sequence></xs:complexType></xs:element><xs:element name="root" type="anonymous_s_Type"/>`,
    );
    expect(parseXml(schema, "<root><other>1</other></root>")).toEqual({ other: 1 });
  });

  it("reserves later named declarations before nested complex synthesis", async () => {
    const { schema } = await compileReviewSchema(
      '<xs:complexType name="Parent"><xs:sequence><xs:element name="item"><xs:complexType><xs:attribute name="nested"/></xs:complexType></xs:element></xs:sequence></xs:complexType><xs:complexType name="Parent_item_Type"><xs:attribute name="real" type="xs:int" use="required"/></xs:complexType><xs:element name="root" type="Parent_item_Type"/>',
    );
    expect(parseXml(schema, '<root real="7"/>')).toEqual({ "@real": 7 });
  });

  it("reserves inline simple-type children and keeps parent namespace context", async () => {
    const { schema, ir } = await compileReviewSchema(
      '<xs:element name="items"><xs:simpleType><xs:list><xs:simpleType><xs:restriction base="xs:string"/></xs:simpleType></xs:list></xs:simpleType></xs:element><xs:simpleType name="anonymous_items_SimpleType_itemType"><xs:restriction base="xs:int"/></xs:simpleType><xs:attribute name="a" xmlns:toString="http://www.w3.org/2001/XMLSchema"><xs:simpleType><xs:restriction base="toString:int"/></xs:simpleType></xs:attribute><xs:element name="root"><xs:complexType><xs:sequence><xs:element name="v" type="anonymous_items_SimpleType_itemType"/></xs:sequence><xs:attribute ref="a"/></xs:complexType></xs:element>',
    );
    expect(ir.diagnostics).toEqual([]);
    expect(parseXml(schema, '<root a="8"><v>7</v></root>')).toEqual({ v: 7, "@a": 8 });
  });

  it("ignores empty union member tokens and inherits local namespace contexts", async () => {
    const { schema, ir } = await compileReviewSchema(
      `<xs:simpleType name="U" xmlns:s="http://www.w3.org/2001/XMLSchema"><xs:union memberTypes=" s:int s:boolean "/></xs:simpleType><xs:element name="root" type="U"/>`,
    );
    expect(ir.diagnostics).toEqual([]);
    expect(parseXml(schema, "<root>5</root>")).toBe(5);
    expect(safeParseXml(schema, "<root>abc</root>").success).toBe(false);
  });

  it("supports inline list bases and simple-content restriction facets", async () => {
    const list = await compileReviewSchema(
      `<xs:simpleType name="Pair"><xs:restriction><xs:simpleType><xs:list itemType="xs:int"/></xs:simpleType><xs:length value="2"/></xs:restriction></xs:simpleType><xs:element name="root" type="Pair"/>`,
    );
    expect(parseXml(list.schema, "<root>1 2</root>")).toEqual([1, 2]);
    expect(safeParseXml(list.schema, "<root>ab</root>").success).toBe(false);
    const text = await compileReviewSchema(
      `<xs:complexType name="Base"><xs:simpleContent><xs:extension base="xs:string"/></xs:simpleContent></xs:complexType><xs:complexType name="Short"><xs:simpleContent><xs:restriction base="Base"><xs:maxLength value="2"/></xs:restriction></xs:simpleContent></xs:complexType><xs:element name="root" type="Short"/>`,
    );
    expect(parseXml(text.schema, "<root>ab</root>")).toEqual({ _text: "ab" });
    expect(safeParseXml(text.schema, "<root>abc</root>").success).toBe(false);
  });

  it("retains unrelated types and original inline dependencies across chameleon redefine", async () => {
    await withReviewFiles(
      {
        "base.xsd":
          '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:simpleType name="T"><xs:restriction base="xs:string"/></xs:simpleType><xs:simpleType name="T_Unrelated"><xs:restriction base="xs:int"/></xs:simpleType></xs:schema>',
        "main.xsd":
          '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:t" targetNamespace="urn:t"><xs:redefine schemaLocation="base.xsd"><xs:simpleType name="T"><xs:restriction base="t:T"><xs:maxLength value="2"/></xs:restriction></xs:simpleType></xs:redefine><xs:element name="root" type="t:T_Unrelated"/></xs:schema>',
      },
      async (files) => {
        const ir = await parseXsd([files[1] ?? ""]);
        expect(ir.simpleTypes["{urn:t}T_Unrelated"]).toBeDefined();
        expect(ir.diagnostics).toEqual([]);
        const mod = await generateAndImport([files[1] ?? ""]);
        const schema = findRootSchemas(mod)[0]?.schema;
        if (schema === undefined) {
          throw new Error("missing root");
        }
        expect(parseXml(schema, '<root xmlns="urn:t">5</root>')).toBe(5);
        expect(safeParseXml(schema, '<root xmlns="urn:t">abc</root>').success).toBe(false);
      },
    );
  });
});
