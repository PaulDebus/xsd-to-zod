import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseXml, safeParseXml, serializeXml } from "../src/runtime.js";
import { validateXml } from "../src/validate.js";
import { expectTscPasses } from "./helpers.js";
import { compileReviewSchema } from "./reviewHelpers.js";

describe("generator validation and typing regressions", () => {
  it("isolates singleton union metadata from its constrained member", async () => {
    const { schema } = await compileReviewSchema(
      `<xs:simpleType name="A"><xs:restriction base="xs:decimal"><xs:minInclusive value="5"/></xs:restriction></xs:simpleType><xs:simpleType name="U"><xs:union memberTypes="A"/></xs:simpleType><xs:element name="root" type="A"/>`,
    );
    expect(safeParseXml(schema, "<root>1</root>").success).toBe(false);
    expect(parseXml(schema, "<root>5</root>")).toBe(5);
  });

  it("chooses validating union members for element and attribute defaults", async () => {
    const { schema, xsd } = await compileReviewSchema(
      `<xs:simpleType name="U"><xs:union memberTypes="xs:boolean xs:int"/></xs:simpleType><xs:element name="root"><xs:complexType><xs:sequence><xs:element name="v" type="U" default="2"/><xs:element name="flag" type="xs:boolean" default=" true "/></xs:sequence><xs:attribute name="a" type="U" default="2"/><xs:attribute name="enabled" type="xs:boolean" default=" 1 "/></xs:complexType></xs:element>`,
    );
    const value = parseXml(schema, "<root><v/><flag/></root>");
    expect(value).toEqual({ v: 2, flag: true, "@a": 2, "@enabled": true });
    expect(await validateXml(serializeXml(schema, value), xsd)).toEqual({ valid: true });
    expect(parseXml(schema, serializeXml(schema, { v: 2, flag: true }))).toEqual(value);
  });

  it("checks decimal facets before float64 rounding", async () => {
    for (const facet of [
      '<xs:totalDigits value="16"/>',
      '<xs:enumeration value="9007199254740992"/>',
    ]) {
      const { schema } = await compileReviewSchema(
        `<xs:simpleType name="D"><xs:restriction base="xs:decimal">${facet}</xs:restriction></xs:simpleType><xs:element name="root" type="D"/>`,
      );
      const invalid = facet.includes("totalDigits") ? "1234567890123456.1" : "9007199254740993";
      expect(safeParseXml(schema, `<root>${invalid}</root>`).success).toBe(false);
    }
  });

  it.each([
    ['<xs:element name="root" type="xs:decimal"/>', "1e3"],
    [
      '<xs:element name="root"><xs:complexType><xs:sequence><xs:element name="v" type="xs:int" fixed="1"/></xs:sequence></xs:complexType></xs:element>',
      "<v>1e0</v>",
    ],
    [
      '<xs:simpleType name="I"><xs:restriction base="xs:int"><xs:enumeration value="1"/></xs:restriction></xs:simpleType><xs:element name="root" type="I"/>',
      "1.0",
    ],
    ['<xs:element name="root" type="xs:decimal"/>', "1&#160;"],
  ])("preserves numeric lexical grammars", async (body, content) => {
    const { schema } = await compileReviewSchema(body);
    expect(safeParseXml(schema, `<root>${content}</root>`).success).toBe(false);
  });

  it("counts Unicode characters and preserves non-XML whitespace", async () => {
    const unicode = await compileReviewSchema(
      `<xs:simpleType name="S"><xs:restriction base="xs:string"/></xs:simpleType><xs:simpleType name="One"><xs:restriction base="S"><xs:length value="1"/></xs:restriction></xs:simpleType><xs:element name="root" type="One"/>`,
    );
    expect(parseXml(unicode.schema, "<root>😀</root>")).toBe("😀");
    const token = await compileReviewSchema('<xs:element name="root" type="xs:token"/>');
    expect(parseXml(token.schema, "<root>a&#160;b</root>")).toBe("a\u00a0b");
  });

  it("preserves structured list restrictions and original pattern lexicals", async () => {
    const list = await compileReviewSchema(
      `<xs:simpleType name="L"><xs:list itemType="xs:date"/></xs:simpleType><xs:simpleType name="R"><xs:restriction base="L"><xs:length value="1"/></xs:restriction></xs:simpleType><xs:element name="root" type="R"/>`,
      { datatypes: "structured" },
    );
    expect(
      await validateXml(
        serializeXml(list.schema, parseXml(list.schema, "<root>2024-01-01</root>")),
        list.xsd,
      ),
    ).toEqual({ valid: true });
    const pattern = await compileReviewSchema(
      `<xs:simpleType name="D"><xs:restriction base="xs:dateTime"><xs:pattern value=".*[.]00Z"/></xs:restriction></xs:simpleType><xs:element name="root" type="D"/>`,
      { datatypes: "structured" },
    );
    const output = serializeXml(
      pattern.schema,
      parseXml(pattern.schema, "<root>2000-01-01T00:00:00.00Z</root>"),
    );
    expect(output).toContain(".00Z");
    expect(await validateXml(output, pattern.xsd)).toEqual({ valid: true });
    expect(() =>
      serializeXml(pattern.schema, {
        year: 2000,
        month: 1,
        day: 1,
        hour: 0,
        minute: 0,
        second: 0,
        tzOffset: 0,
      }),
    ).toThrow("pattern facet");
  });

  it("rejects hand-built structured years that its parser cannot represent safely", async () => {
    const { schema } = await compileReviewSchema('<xs:element name="root" type="xs:date"/>', {
      datatypes: "structured",
    });
    expect(() => serializeXml(schema, { year: 9007199254740992, month: 1, day: 1 })).toThrow();
    expect(safeParseXml(schema, "<root>9007199254740993-01-01</root>").success).toBe(false);
  });

  it("does not rewrite string union members as QName values", async () => {
    const { schema } = await compileReviewSchema(
      `<xs:simpleType name="U"><xs:union memberTypes="xs:string xs:QName"/></xs:simpleType><xs:element name="root" type="U"/>`,
    );
    const value = parseXml(schema, '<root xmlns:p="urn:codes">p:a</root>');
    expect(serializeXml(schema, value)).toBe("<root>p:a</root>");
  });

  it("keeps a default-namespace QName enumeration valid on round trip", async () => {
    const { schema, xsd } = await compileReviewSchema(
      '<xs:simpleType name="Q"><xs:restriction base="xs:QName"><xs:enumeration value="Thing"/></xs:restriction></xs:simpleType><xs:element name="root" type="Q"/>',
      undefined,
      'xmlns="urn:q" targetNamespace="urn:q"',
    );
    const output = serializeXml(schema, parseXml(schema, '<root xmlns="urn:q">Thing</root>'));
    expect(await validateXml(output, xsd)).toEqual({ valid: true });
    expect(parseXml(schema, output)).toBe("Thing");
  });

  it("allocates safe keys for XML names reserved by the runtime", async () => {
    const { schema, ir } = await compileReviewSchema(
      `<xs:element name="root"><xs:complexType><xs:sequence><xs:element name="__proto__" type="xs:string"/><xs:element name="xsiType" type="xs:string"/></xs:sequence></xs:complexType></xs:element>`,
      undefined,
      'targetNamespace="urn:keys" elementFormDefault="qualified"',
    );
    const value = parseXml(
      schema,
      '<q:root xmlns:q="urn:keys"><q:__proto__>a</q:__proto__><q:xsiType>b</q:xsiType></q:root>',
    );
    expect(Object.values(value as object)).toEqual(["a", "b"]);
    expect(parseXml(schema, serializeXml(schema, value))).toEqual(value);
    expect(ir.diagnostics.filter((d) => d.kind === "naming-collision")).toHaveLength(2);
  });

  it("emits strict TypeScript for optional groups, recursive literal types, and shared union bases", async () => {
    const { generated } = await compileReviewSchema(
      `<xs:simpleType name="S"><xs:restriction base="xs:token"><xs:enumeration value=" a  b "/></xs:restriction></xs:simpleType><xs:simpleType name="F"><xs:restriction base="xs:double"><xs:enumeration value="INF"/></xs:restriction></xs:simpleType><xs:simpleType name="U"><xs:union memberTypes="xs:boolean xs:int"/></xs:simpleType><xs:simpleType name="Common"><xs:restriction base="xs:string"/></xs:simpleType><xs:simpleType name="A"><xs:restriction base="Common"/></xs:simpleType><xs:simpleType name="B"><xs:restriction base="Common"><xs:minLength value="1"/></xs:restriction></xs:simpleType><xs:simpleType name="Shared"><xs:union memberTypes="A B"/></xs:simpleType><xs:complexType name="Record"><xs:sequence minOccurs="0"><xs:element name="a" type="S"/><xs:element name="b" type="F"/><xs:element name="u" type="U" fixed="2"/><xs:element name="shared" type="Shared"/><xs:element name="next" type="Record" minOccurs="0"/></xs:sequence></xs:complexType><xs:element name="root" type="Record"/>`,
    );
    expect(generated.schemas).toContain('"shared"?: string | undefined;');
    const base = path.resolve(".xsd-to-zod-tests");
    fs.mkdirSync(base, { recursive: true });
    const dir = fs.mkdtempSync(path.join(base, "strict-review-"));
    const file = path.join(dir, "schema.ts");
    try {
      fs.writeFileSync(file, generated.schemas);
      expectTscPasses([file]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
