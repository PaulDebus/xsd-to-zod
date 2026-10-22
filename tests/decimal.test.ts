import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { irToZod, parseXml, parseXsd, serializeXml } from "../src/index.js";
import { generateAndImport, withTempDirAsync } from "./helpers.js";

const DECIMAL_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:decimal" xmlns:d="urn:decimal" elementFormDefault="qualified">
  <xs:simpleType name="Money">
    <xs:restriction base="xs:decimal">
      <xs:minInclusive value="0"/>
      <xs:maxInclusive value="999999999999999999.99"/>
      <xs:totalDigits value="20"/>
      <xs:fractionDigits value="2"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="EnumMoney">
    <xs:restriction base="xs:decimal">
      <xs:enumeration value="1.50"/>
      <xs:enumeration value="2"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="DecimalList">
    <xs:list itemType="xs:decimal"/>
  </xs:simpleType>
  <xs:complexType name="RootType">
    <xs:sequence>
      <xs:element name="amount" type="d:Money"/>
      <xs:element name="plain" type="xs:decimal"/>
      <xs:element name="enum" type="d:EnumMoney"/>
      <xs:element name="values" type="d:DecimalList"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="root" type="d:RootType"/>
</xs:schema>`;

const FIXED_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:fixed-decimal" xmlns:d="urn:fixed-decimal" elementFormDefault="qualified">
  <xs:complexType name="RootType">
    <xs:sequence>
      <xs:element name="v" type="xs:decimal" fixed="1.50"/>
    </xs:sequence>
    <xs:attribute name="a" type="xs:decimal" fixed="2.500"/>
  </xs:complexType>
  <xs:element name="root" type="d:RootType"/>
</xs:schema>`;

const writeXsd = async (xsd: string, run: (file: string) => Promise<void>): Promise<void> =>
  withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    await run(file);
  });

describe("xs:decimal mapping (default: number)", () => {
  it("keeps the float64 mapping and number TS type", async () => {
    await writeXsd(DECIMAL_XSD, async (file) => {
      const { schemas } = irToZod(await parseXsd([file]));
      expect(schemas).toContain('"amount": number;');
      expect(schemas).toContain('"plain": z.number()');
      expect(schemas).not.toContain("xsdDecimalLexical");
    });
  });

  it("parses decimals as numbers", async () => {
    await writeXsd(DECIMAL_XSD, async (file) => {
      const mod = await generateAndImport([file]);
      const parsed = parseXml(
        mod["rootSchema"] as z.ZodType,
        '<root xmlns="urn:decimal"><amount>1.25</amount><plain>2.50</plain><enum>1.5</enum><values>1 2.5</values></root>',
      ) as Record<string, unknown>;
      expect(parsed).toEqual({ amount: 1.25, plain: 2.5, enum: 1.5, values: [1, 2.5] });
    });
  });
});

describe("xs:decimal mapping (opt-in: string)", () => {
  it("emits an exact lexical string schema and TS type", async () => {
    await writeXsd(DECIMAL_XSD, async (file) => {
      const { schemas } = irToZod(await parseXsd([file]), { decimal: "string" });
      expect(schemas).toContain('"amount": string;');
      expect(schemas).toContain('"plain": string;');
      expect(schemas).toContain('"enum": "1.5" | "2";');
      expect(schemas).toContain("xsdDecimalLexical");
      expect(schemas).toContain("z.string().trim().refine(xsdDecimalLexical");
      expect(schemas).toContain('"totalDigits":20');
    });
  });

  it("round-trips decimals beyond float64 precision exactly", async () => {
    await writeXsd(DECIMAL_XSD, async (file) => {
      const mod = await generateAndImport([file], { decimal: "string" });
      const schema = mod["rootSchema"] as z.ZodType;
      const xml =
        '<root xmlns="urn:decimal"><amount>123456789012345678.90</amount><plain>001.2300</plain><enum>1.50</enum><values>1.2300 9007199254740993.01</values></root>';
      const parsed = parseXml(schema, xml) as Record<string, unknown>;
      expect(parsed).toEqual({
        amount: "123456789012345678.9",
        plain: "1.23",
        enum: "1.5",
        values: ["1.23", "9007199254740993.01"],
      });
      // Facet-bearing fields re-emit their original lexical; plain fields use
      // the canonical exact form. Neither ever rounds.
      const serialized = serializeXml(schema, parsed);
      expect(serialized).toContain("<ns0:amount>123456789012345678.90</ns0:amount>");
      expect(serialized).toContain("<ns0:plain>1.23</ns0:plain>");
      expect(serialized).toContain("<ns0:enum>1.50</ns0:enum>");
    });
  });

  it("enforces order, fraction, total and enumeration facets on the exact lexical", async () => {
    await writeXsd(DECIMAL_XSD, async (file) => {
      const mod = await generateAndImport([file], { decimal: "string" });
      const schema = mod["rootSchema"] as z.ZodType;
      const doc = (amount: string, enumValue = "2") =>
        `<root xmlns="urn:decimal"><amount>${amount}</amount><plain>1</plain><enum>${enumValue}</enum><values>1</values></root>`;

      expect(() => parseXml(schema, doc("999999999999999999.99"))).not.toThrow();
      expect(() => parseXml(schema, doc("-0.01"))).toThrow(/out of range/);
      expect(() => parseXml(schema, doc("1.001"))).toThrow(/too many fraction digits/);
      expect(() => parseXml(schema, doc("1234567890123456789.01"))).toThrow(
        /too many total digits/,
      );
      expect(() => parseXml(schema, doc("1", "1.5"))).not.toThrow();
      expect(() => parseXml(schema, doc("1", "3"))).toThrow(/not one of the allowed values/);
      expect(() => parseXml(schema, doc("1e3"))).toThrow();
    });
  });

  it("compares fixed values in value space", async () => {
    await writeXsd(FIXED_XSD, async (file) => {
      const mod = await generateAndImport([file], { decimal: "string" });
      const schema = mod["rootSchema"] as z.ZodType;
      const parsed = parseXml(schema, '<root xmlns="urn:fixed-decimal"><v>1.5</v></root>') as {
        v: string;
        "@a": string;
      };
      expect(parsed).toEqual({ v: "1.5", "@a": "2.5" });
      expect(serializeXml(schema, parsed)).toContain("<ns0:v>1.50</ns0:v>");
      expect(() => parseXml(schema, '<root xmlns="urn:fixed-decimal"><v>2</v></root>')).toThrow(
        /does not match the fixed value/,
      );
      expect(() =>
        parseXml(schema, '<root xmlns="urn:fixed-decimal" a="3"><v>1.5</v></root>'),
      ).toThrow(/does not match the fixed value/);
    });
  });
});
