import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { IrToZodOptions } from "../src/irToZod.js";
import { irToZod } from "../src/irToZod.js";
import { parseXsd } from "../src/parseXsd.js";
import { decodeXmlEntities, parseXml, safeParseXml, serializeXml } from "../src/runtime.js";
import { validateXml } from "../src/validate.js";
import { xmlRegistry } from "../src/xmlMeta.js";
import { findRootSchemas, importGeneratedSchemas, onlyRootSchema } from "./helpers.js";

const compile = async (body: string, opts?: IrToZodOptions, attrs = "") => {
  const xsd = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" ${attrs}>${body}</xs:schema>`;
  const ir = await parseXsd(["schema.xsd"], {
    resolveSchema: async () => ({ content: xsd, url: "https://example.com/schema.xsd" }),
  });
  const mod = await importGeneratedSchemas(irToZod(ir, opts).schemas);
  const schema =
    findRootSchemas(mod).find((root) => root.rootQName === "{}root")?.schema ?? onlyRootSchema(mod);
  return { schema, xsd };
};

describe("runtime value preservation", () => {
  it("fails cyclic wrapper-only schemas instead of walking forever", () => {
    let root: z.ZodType;
    const other = z.lazy(() => root);
    root = z.lazy(() => other).register(xmlRegistry, { root: "{}root" });
    const result = safeParseXml(root, "<root>value</root>");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(String(result.error)).toContain("Cyclic XML schema wrappers");
    }
  });
  it("returns transform failures through the safe parsing result", () => {
    const failure = new Error("conversion failed");
    const schema = z
      .string()
      .transform(() => {
        throw failure;
      })
      .register(xmlRegistry, { root: "{}root" });
    expect(safeParseXml(schema, "<root>value</root>")).toEqual({ success: false, error: failure });
  });
  it("decodes entities in one pass without recursively decoding escaped references", () => {
    expect(decodeXmlEntities("&amp;lt;&#38;lt;&lt;")).toBe("&lt;&lt;<");
  });
  it.each([
    ["a<![CDATA[b]]>c", "abc"],
    ["<![CDATA[a]]>b<![CDATA[c]]>", "abc"],
    ["a<![CDATA[&amp;<x>]]>&amp;b", "a&amp;<x>&b"],
  ])("keeps text and CDATA in source order: %s", async (content, expected) => {
    const { schema } = await compile('<xs:element name="root" type="xs:string"/>');
    const value = parseXml(schema, `<root>${content}</root>`);
    expect(value).toBe(expected);
    expect(parseXml(schema, serializeXml(schema, value))).toBe(expected);
  });

  it("escapes namespace declaration attribute values", async () => {
    const { schema, xsd } = await compile(
      '<xs:element name="root" type="xs:string"/>',
      undefined,
      'targetNamespace="urn:a?x=1&amp;y=2"',
    );
    const value = parseXml(schema, '<root xmlns="urn:a?x=1&amp;y=2">x</root>');
    const xml = serializeXml(schema, value);
    expect(xml).toContain("urn:a?x=1&amp;y=2");
    expect(await validateXml(xml, xsd)).toEqual({ valid: true });
  });

  it("supports namespace prefixes that match object prototype properties", async () => {
    const { schema, xsd } = await compile(
      '<xs:element name="root" type="xs:QName"/>',
      undefined,
      'targetNamespace="urn:root"',
    );
    const input =
      '<__proto__:root xmlns:__proto__="urn:root" xmlns:constructor="urn:codes">constructor:a</__proto__:root>';
    const output = serializeXml(schema, parseXml(schema, input));
    expect(await validateXml(output, xsd)).toEqual({ valid: true });
    expect(output).toContain('xmlns:constructor="urn:codes"');
  });

  it("preserves default namespace QName values and simple-content bindings", async () => {
    const { schema, xsd } = await compile(
      `<xs:element name="root"><xs:complexType><xs:simpleContent>
        <xs:extension base="xs:QName"/>
      </xs:simpleContent></xs:complexType></xs:element>`,
      undefined,
      'targetNamespace="urn:q"',
    );
    for (const xml of [
      '<root xmlns="urn:q">Thing</root>',
      '<root xmlns="urn:q" xmlns:p="urn:codes">p:Thing</root>',
    ]) {
      const output = serializeXml(schema, parseXml(schema, xml));
      expect(await validateXml(output, xsd)).toEqual({ valid: true });
      expect(output).toContain(xml.includes("p:Thing") ? "urn:codes" : "urn:q");
    }
  });

  it("retains QName attribute bindings on nil elements", async () => {
    const { schema, xsd } = await compile(`<xs:element name="root"><xs:complexType><xs:sequence>
      <xs:element name="row" nillable="true"><xs:complexType><xs:attribute name="id" type="xs:QName"/></xs:complexType></xs:element>
    </xs:sequence></xs:complexType></xs:element>`);
    const input =
      '<root xmlns:p="urn:codes" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><row id="p:a" xsi:nil="true"/></root>';
    const output = serializeXml(schema, parseXml(schema, input));
    expect(output).toContain('xmlns:p="urn:codes"');
    expect(await validateXml(output, xsd)).toEqual({ valid: true });
  });

  it("reserves xsi for nil markers when QName values use that prefix differently", async () => {
    const { schema, xsd } = await compile(`<xs:element name="root"><xs:complexType><xs:sequence>
      <xs:element name="code" type="xs:QName"/>
      <xs:element name="empty" type="xs:string" nillable="true"/>
    </xs:sequence></xs:complexType></xs:element>`);
    const input =
      '<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><code xmlns:xsi="urn:codes">xsi:a</code><empty xsi:nil="true"/></root>';
    const output = serializeXml(schema, parseXml(schema, input));
    expect(await validateXml(output, xsd)).toEqual({ valid: true });
  });

  it("keeps each wildcard occurrence's own xsi:type", async () => {
    const { schema, xsd } = await compile(`<xs:element name="root"><xs:complexType><xs:sequence>
      <xs:any processContents="lax" minOccurs="0" maxOccurs="unbounded"/>
    </xs:sequence></xs:complexType><xs:unique name="ids"><xs:selector xpath="uid"/><xs:field xpath="."/></xs:unique></xs:element>`);
    const input =
      '<root xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><uid xsi:type="xs:boolean">1</uid><uid xsi:type="xs:decimal">1</uid></root>';
    const output = serializeXml(schema, parseXml(schema, input));
    expect(output).toContain(':boolean"');
    expect(output).toContain(':decimal"');
    expect(await validateXml(output, xsd)).toEqual({ valid: true });
    expect(safeParseXml(schema, output).success).toBe(true);
  });

  it("exposes substitution members in document order", async () => {
    const { schema } = await compile(`<xs:element name="head" type="xs:string" abstract="true"/>
      <xs:element name="a" substitutionGroup="head" type="xs:string"/>
      <xs:element name="b" substitutionGroup="head" type="xs:string"/>
      <xs:element name="root"><xs:complexType><xs:sequence><xs:element ref="head" maxOccurs="unbounded"/></xs:sequence></xs:complexType></xs:element>`);
    expect(parseXml(schema, "<root><a>first</a><b>second</b><a>third</a></root>")).toEqual({
      head: ["first", "second", "third"],
    });
  });

  it("retains pattern-constrained lexicals in ergonomic repeated choices", async () => {
    const { schema, xsd } = await compile(
      `<xs:element name="root"><xs:complexType><xs:choice maxOccurs="unbounded">
      <xs:element name="a"><xs:simpleType><xs:restriction base="xs:int"><xs:pattern value="0[0-9]+"/></xs:restriction></xs:simpleType></xs:element>
      <xs:element name="b" type="xs:string"/>
    </xs:choice></xs:complexType></xs:element>`,
      { ergonomic: true },
    );
    const output = serializeXml(schema, parseXml(schema, "<root><a>01</a><b>x</b></root>"));
    expect(output).toContain("<a>01</a>");
    expect(await validateXml(output, xsd)).toEqual({ valid: true });
  });

  it("enforces wildcard namespaces and shared occurrence capacity", async () => {
    const { schema } = await compile(`<xs:element name="root"><xs:complexType><xs:sequence>
      <xs:element name="known" type="xs:string"/>
      <xs:any namespace="urn:allowed" processContents="lax" minOccurs="0" maxOccurs="1"/>
    </xs:sequence></xs:complexType></xs:element>`);
    expect(
      safeParseXml(schema, '<root xmlns:a="urn:allowed"><known>k</known><a:x/></root>').success,
    ).toBe(true);
    expect(
      safeParseXml(schema, '<root xmlns:a="urn:allowed"><known>k</known><a:x/><a:y/></root>')
        .success,
    ).toBe(false);
    expect(
      safeParseXml(schema, '<root xmlns:b="urn:wrong"><known>k</known><b:x/></root>').success,
    ).toBe(false);
  });

  it("keeps primitive QName root provenance across documents and rejects ambiguity", async () => {
    const { schema } = await compile('<xs:element name="root" type="xs:QName"/>');
    const first = parseXml(schema, '<root xmlns:p="urn:first">p:foo</root>');
    parseXml(schema, '<root xmlns:p="urn:second">p:bar</root>');
    expect(serializeXml(schema, first)).toContain('xmlns:p="urn:first"');
    parseXml(schema, '<root xmlns:p="urn:second">p:foo</root>');
    expect(() => serializeXml(schema, first)).toThrow("Ambiguous QName");
    expect(serializeXml(schema, first, { rootNamespaces: { p: "urn:first" } })).toContain(
      'xmlns:p="urn:first"',
    );
  });

  it("requires explicit context after bounded primitive QName history expires", async () => {
    const { schema } = await compile('<xs:element name="root" type="xs:QName"/>');
    const first = parseXml(schema, '<root xmlns:p="urn:first">p:first</root>');
    for (let i = 0; i < 256; i++) {
      parseXml(schema, `<root xmlns:p="urn:other">p:v${i}</root>`);
    }
    parseXml(schema, '<root xmlns:p="urn:other">p:first</root>');
    expect(() => serializeXml(schema, first)).toThrow("namespace context");
    expect(serializeXml(schema, first, { rootNamespaces: { p: "urn:first" } })).toContain(
      'xmlns:p="urn:first"',
    );
  });
});
