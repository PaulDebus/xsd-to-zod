import { describe, expect, it } from "vitest";
import { parseXml, safeParseXml } from "../src/runtime.js";
import { validateXml } from "../src/validate.js";
import { compileReviewSchema } from "./reviewHelpers.js";

const unique = (selector: string, field: string, kind = "unique") =>
  `<xs:${kind} name="values"><xs:selector xpath="${selector}"/><xs:field xpath="${field}"/></xs:${kind}>`;

describe("identity value-space and XPath semantics", () => {
  it("resolves known wildcard declarations when comparing typed keys and references", async () => {
    const { schema, xsd } = await compileReviewSchema(
      `<xs:element name="key"><xs:complexType><xs:attribute name="id" type="xs:string"/></xs:complexType></xs:element><xs:element name="root"><xs:complexType><xs:sequence><xs:element name="keys"><xs:complexType><xs:sequence><xs:any processContents="lax" maxOccurs="unbounded"/></xs:sequence></xs:complexType></xs:element><xs:element name="ref" type="xs:string"/></xs:sequence></xs:complexType><xs:key name="ids"><xs:selector xpath="keys/key"/><xs:field xpath="@id"/></xs:key><xs:keyref name="refs" refer="ids"><xs:selector xpath="ref"/><xs:field xpath="."/></xs:keyref></xs:element>`,
    );
    const xml = '<root><keys><key id="a"/></keys><ref>a</ref></root>';
    expect(await validateXml(xml, xsd)).toEqual({ valid: true });
    expect(safeParseXml(schema, xml).success).toBe(true);
  });

  it("uses the head's declared schema for unsubstituted occurrences", async () => {
    const { schema, xsd } = await compileReviewSchema(
      `<xs:complexType name="UID"><xs:attribute name="val" type="xs:string"/></xs:complexType><xs:element name="uid" type="UID"/><xs:element name="member" type="UID" substitutionGroup="uid"/><xs:element name="root"><xs:complexType><xs:sequence><xs:element ref="uid" maxOccurs="unbounded"/><xs:element name="key" type="UID" maxOccurs="unbounded"/></xs:sequence></xs:complexType><xs:key name="ids"><xs:selector xpath="key"/><xs:field xpath="@val"/></xs:key><xs:keyref name="refs" refer="ids"><xs:selector xpath="uid|member"/><xs:field xpath="@val"/></xs:keyref></xs:element>`,
    );
    const xml = '<root><uid val="a"/><member val="b"/><key val="a"/><key val="b"/></root>';
    expect(await validateXml(xml, xsd)).toEqual({ valid: true });
    expect(safeParseXml(schema, xml).success).toBe(true);
  });
  it.each(["element", "attribute"])(
    "treats list-valued %s fields as one simple value",
    async (kind) => {
      const field =
        kind === "element"
          ? '<xs:sequence><xs:element name="id" type="L"/></xs:sequence>'
          : '<xs:attribute name="id" type="L"/>';
      const { schema, xsd } = await compileReviewSchema(
        `<xs:simpleType name="L"><xs:list itemType="xs:int"/></xs:simpleType><xs:element name="root"><xs:complexType><xs:sequence><xs:element name="row" maxOccurs="unbounded"><xs:complexType>${field}</xs:complexType></xs:element></xs:sequence></xs:complexType>${unique("row", kind === "element" ? "id" : "@id", "key")}</xs:element>`,
      );
      const rows = (second: string) =>
        kind === "element"
          ? `<root><row><id>1 2</id></row><row><id>${second}</id></row></root>`
          : `<root><row id="1 2"/><row id="${second}"/></root>`;
      expect(await validateXml(rows("3 4"), xsd)).toEqual({ valid: true });
      expect(safeParseXml(schema, rows("3 4")).success).toBe(true);
      expect(safeParseXml(schema, rows("01 2")).success).toBe(false);
    },
  );

  it.each(["number", "string"] as const)(
    "compares decimal-family values independently of %s output mode",
    async (decimal) => {
      const { schema, xsd } = await compileReviewSchema(
        `<xs:element name="root"><xs:complexType><xs:sequence><xs:element name="a" type="xs:int"/><xs:element name="b" type="xs:decimal"/></xs:sequence></xs:complexType>${unique("a|b", ".")}</xs:element>`,
        { decimal },
      );
      const xml = "<root><a>1</a><b>1.00</b></root>";
      expect((await validateXml(xml, xsd)).valid).toBe(false);
      expect(safeParseXml(schema, xml).success).toBe(false);
    },
  );

  it("distinguishes decimal and double primitive families", async () => {
    const { schema, xsd } = await compileReviewSchema(
      `<xs:element name="root"><xs:complexType><xs:sequence><xs:element name="a" type="xs:int"/><xs:element name="b" type="xs:double"/></xs:sequence></xs:complexType>${unique("a|b", ".")}</xs:element>`,
    );
    const xml = "<root><a>1</a><b>1</b></root>";
    expect(await validateXml(xml, xsd)).toEqual({ valid: true });
    expect(safeParseXml(schema, xml).success).toBe(true);
  });

  it.each(["string", "structured"] as const)(
    "compares temporal values rather than %s representations",
    async (datatypes) => {
      const { schema, xsd } = await compileReviewSchema(
        `<xs:element name="root"><xs:complexType><xs:sequence><xs:element name="row" type="xs:dateTime" maxOccurs="unbounded"/></xs:sequence></xs:complexType>${unique("row", ".")}</xs:element>`,
        { datatypes },
      );
      const xml =
        "<root><row>2001-01-01T00:00:00Z</row><row>2000-12-31T19:00:00-05:00</row></root>";
      expect((await validateXml(xml, xsd)).valid).toBe(false);
      expect(safeParseXml(schema, xml).success).toBe(false);
      expect(
        safeParseXml(
          schema,
          "<root><row>2001-01-01T00:00:00Z</row><row>2002-01-01T00:00:00Z</row></root>",
        ).success,
      ).toBe(true);
    },
  );

  it("resolves descendant attribute and descendant-self paths", async () => {
    const attrs = await compileReviewSchema(
      `<xs:element name="root"><xs:complexType><xs:sequence><xs:element name="row"><xs:complexType><xs:sequence><xs:element name="child"><xs:complexType><xs:attribute name="id" type="xs:int"/></xs:complexType></xs:element></xs:sequence></xs:complexType></xs:element></xs:sequence></xs:complexType>${unique("row", ".//@id", "key")}</xs:element>`,
    );
    expect(safeParseXml(attrs.schema, '<root><row><child id="1"/></row></root>').success).toBe(
      true,
    );
    const self = await compileReviewSchema(
      `<xs:element name="root"><xs:complexType><xs:sequence><xs:element name="row" maxOccurs="unbounded"><xs:complexType><xs:attribute name="id" type="xs:int"/></xs:complexType></xs:element></xs:sequence><xs:attribute name="id" type="xs:int"/></xs:complexType>${unique(".//.", "@id")}</xs:element>`,
    );
    expect(safeParseXml(self.schema, '<root id="1"><row id="1"/></root>').success).toBe(false);
  });

  it("compares unprefixed QName values using their default namespace", async () => {
    const { schema, xsd } = await compileReviewSchema(
      `<xs:element name="root"><xs:complexType><xs:sequence><xs:element name="row" maxOccurs="unbounded"><xs:complexType><xs:attribute name="id" type="xs:QName"/></xs:complexType></xs:element></xs:sequence></xs:complexType>${unique("q:row", "@id")}</xs:element>`,
      undefined,
      'xmlns:q="urn:codes" targetNamespace="urn:codes" elementFormDefault="qualified"',
    );
    const xml =
      '<q:root xmlns:q="urn:codes" xmlns="urn:codes"><q:row id="foo"/><q:row id="q:foo"/></q:root>';
    expect((await validateXml(xml, xsd)).valid).toBe(false);
    expect(safeParseXml(schema, xml).success).toBe(false);
  });

  it("keeps distinct exact decimal keys even when number output rounds them together", async () => {
    const { schema } = await compileReviewSchema(
      `<xs:element name="root"><xs:complexType><xs:sequence><xs:element name="row" type="xs:decimal" maxOccurs="unbounded"/></xs:sequence></xs:complexType>${unique("row", ".")}</xs:element>`,
    );
    expect(() =>
      parseXml(schema, "<root><row>9007199254740992</row><row>9007199254740993</row></root>"),
    ).not.toThrow();
  });
});
