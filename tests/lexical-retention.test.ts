import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { parseXml, safeParseXml, serializeXml } from "../src/index.js";
import { generateAndImport, withTempDirAsync } from "./helpers.js";

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="RecordType">
    <xs:sequence>
      <xs:element name="amount" type="xs:decimal"/>
      <xs:element name="count" type="xs:integer"/>
      <xs:element name="ref" type="xs:QName"/>
    </xs:sequence>
    <xs:attribute name="code" type="xs:integer"/>
  </xs:complexType>
  <xs:element name="record" type="RecordType"/>
</xs:schema>`;

const XML =
  '<record xmlns:a="urn:alpha" code="007"><amount>1.50</amount><count>001</count><ref>a:foo</ref></record>';

const load = async (): Promise<z.ZodType> => {
  let schema: z.ZodType | undefined;
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, XSD);
    const mod = await generateAndImport([file]);
    schema = mod["recordSchema"] as z.ZodType;
  });
  if (schema === undefined) {
    throw new Error("no record schema generated");
  }
  return schema;
};

describe("lexical retention", () => {
  it("derives canonical lexicals from values by default", async () => {
    const schema = await load();
    const parsed = parseXml(schema, XML);
    expect(parsed).toEqual({ amount: 1.5, count: 1, ref: "a:foo", "@code": 7 });
    const serialized = serializeXml(schema, parsed);
    expect(serialized).toContain("<amount>1.5</amount>");
    expect(serialized).toContain("<count>1</count>");
    expect(serialized).toContain('code="7"');
    // QName-valued content keeps its prefix binding even without retention.
    expect(serialized).toContain('xmlns:a="urn:alpha"');
    expect(serialized).toContain("<ref>a:foo</ref>");
    expect(parseXml(schema, serialized)).toEqual(parsed);
  });

  it("re-emits the original lexicals when retainLexicals is on", async () => {
    const schema = await load();
    const parsed = parseXml(schema, XML, { retainLexicals: true });
    expect(parsed).toEqual({ amount: 1.5, count: 1, ref: "a:foo", "@code": 7 });
    const serialized = serializeXml(schema, parsed);
    expect(serialized).toContain("<amount>1.50</amount>");
    expect(serialized).toContain("<count>001</count>");
    expect(serialized).toContain('code="007"');
  });

  it("accepts the option through safeParseXml", async () => {
    const schema = await load();
    const result = safeParseXml(schema, XML, { retainLexicals: true });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(serializeXml(schema, result.data)).toContain("<count>001</count>");
  });

  it("retains lexicals on the validate:false fast path", async () => {
    const schema = await load();
    const parsed = parseXml(schema, XML, { validate: false, retainLexicals: true });
    const serialized = serializeXml(schema, parsed as z.input<typeof schema>);
    expect(serialized).toContain("<count>001</count>");
  });

  it("ignores retained lexicals that no longer denote the value", async () => {
    const schema = await load();
    const parsed = parseXml(schema, XML, { retainLexicals: true }) as Record<string, unknown>;
    parsed["count"] = 2;
    // The mutated value no longer matches the retained lexical "001".
    expect(serializeXml(schema, parsed)).toContain("<count>2</count>");
  });

  it("keeps facet-constrained lexicals without opting in", async () => {
    // A pattern facet is lexical-space: canonical re-serialization of the
    // float64 value cannot satisfy `\d{5}\.\d{13}`, so the parse-time lexical
    // is retained even when retainLexicals is off.
    const FACET_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:simpleType name="Patterned">
    <xs:restriction base="xs:decimal">
      <xs:pattern value="\\d{5}\\.\\d{13}"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:element name="value" type="Patterned"/>
</xs:schema>`;
    let schema: z.ZodType | undefined;
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "pattern.xsd");
      fs.writeFileSync(file, FACET_XSD);
      schema = (await generateAndImport([file]))["valueSchema"] as z.ZodType;
    });
    if (schema === undefined) {
      throw new Error("no value schema generated");
    }
    const xml = "<value>67535.5493283257017</value>";
    const parsed = parseXml(schema, xml);
    const serialized = serializeXml(schema, parsed);
    expect(serialized).toContain("<value>67535.5493283257017</value>");
    expect(parseXml(schema, serialized)).toBe(parsed);
  });

  it("serializes large and small decimals without exponent notation", async () => {
    // JS String() yields "9.876543210987655e+27" / "1e-7", which are not valid
    // xs:decimal lexicals; canonical output expands them.
    const DECIMAL_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="value" type="xs:decimal"/>
</xs:schema>`;
    let schema: z.ZodType | undefined;
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "decimal.xsd");
      fs.writeFileSync(file, DECIMAL_XSD);
      schema = (await generateAndImport([file]))["valueSchema"] as z.ZodType;
    });
    if (schema === undefined) {
      throw new Error("no value schema generated");
    }
    expect(serializeXml(schema, 1e-7)).toBe("<value>0.0000001</value>");
    expect(serializeXml(schema, 9.876543210987655e27)).toBe(
      "<value>9876543210987655000000000000</value>",
    );
  });
});
