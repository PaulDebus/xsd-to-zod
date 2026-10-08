import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseXml, safeParseXml, serializeXml } from "../src/index.js";
import { findRootSchema, generateAndImport, withTempDirAsync } from "./helpers.js";

// A maxOccurs=1 element occurs at most once — extra occurrences are a
// duplicate error, unless a wildcard in the same content model claims them:
// a preceding wildcard owns everything but the last occurrence, a following
// one everything but the first.

const schemasFor = async (xsd: string): Promise<Record<string, unknown>> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    mod = await generateAndImport([file]);
  });
  return mod;
};

const rootFor = (mod: Record<string, unknown>, xml: string) => findRootSchema(mod, xml);

const SCALAR = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="e" type="xs:string"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const ANY_BEFORE = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="e" type="xs:string"/>
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:any namespace="##any" processContents="strict"/>
        <xs:element ref="e"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const ANY_AFTER = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="e" type="xs:string"/>
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element ref="e"/>
        <xs:any namespace="##any" processContents="strict"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

// Two wildcards: their constraints ride along in the generated metadata, so
// neither can claim an occurrence of a no-namespace element.
const OTHER_NAMESPACE_WILDCARDS = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:any namespace="urn:a"/>
        <xs:any namespace="urn:b"/>
        <xs:element name="e" type="xs:string"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const UNBOUNDED = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="e" type="xs:string" maxOccurs="unbounded"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

// Same-name element on both sides of a wildcard (the W3C addB135 e3 shape):
// each side keeps one occurrence and the wildcard owns the middle one, so
// three occurrences stay valid.
const ELEMENT_AROUND_WILDCARD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="element1" type="xs:string"/>
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element ref="element1"/>
        <xs:any namespace="##any" processContents="strict"/>
        <xs:element ref="element1"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

// A repeated wildcard behind the element (the W3C addB135 e5 shape): the
// wildcard absorbs several overflow occurrences.
const REPEATED_WILDCARD_AFTER = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="element1" type="xs:string"/>
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element ref="element1"/>
        <xs:any namespace="##any" processContents="strict" maxOccurs="3"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

describe("scalar element occurrences", () => {
  it("accepts one occurrence of a maxOccurs=1 element", async () => {
    const xml = "<root><e>a</e></root>";
    const mod = await schemasFor(SCALAR);
    expect(safeParseXml(rootFor(mod, xml), xml).success).toBe(true);
  });

  it("rejects a duplicate occurrence when no wildcard can claim it", async () => {
    const xml = "<root><e>a</e><e>b</e></root>";
    const mod = await schemasFor(SCALAR);
    const result = safeParseXml(rootFor(mod, xml), xml);
    expect(result.success).toBe(false);
    expect(result.success === false && String(result.error)).toContain("occurs 2 times");
  });

  it("accepts duplicates when a preceding wildcard claims the earlier ones", async () => {
    const xml = "<root><e>a</e><e>b</e></root>";
    const mod = await schemasFor(ANY_BEFORE);
    const root = rootFor(mod, xml);
    const parsed = parseXml(root, xml);
    expect(safeParseXml(root, xml).success).toBe(true);
    expect(parseXml(root, serializeXml(root, parsed))).toEqual(parsed);
  });

  it("accepts duplicates when a following wildcard claims the later ones", async () => {
    const xml = "<root><e>a</e><e>b</e></root>";
    const mod = await schemasFor(ANY_AFTER);
    const root = rootFor(mod, xml);
    const parsed = parseXml(root, xml);
    expect(safeParseXml(root, xml).success).toBe(true);
    expect(parseXml(root, serializeXml(root, parsed))).toEqual(parsed);
  });

  it("rejects duplicates no wildcard's namespace constraint admits", async () => {
    const xml = "<root><e>a</e><e>b</e></root>";
    const mod = await schemasFor(OTHER_NAMESPACE_WILDCARDS);
    expect(safeParseXml(rootFor(mod, xml), xml).success).toBe(false);
  });

  it("accepts repeats of an unbounded element", async () => {
    const xml = "<root><e>a</e><e>b</e></root>";
    const mod = await schemasFor(UNBOUNDED);
    expect(safeParseXml(rootFor(mod, xml), xml).success).toBe(true);
  });

  it("accepts three occurrences split across a wildcard", async () => {
    const xml = "<root><element1>a</element1><element1>b</element1><element1>c</element1></root>";
    const mod = await schemasFor(ELEMENT_AROUND_WILDCARD);
    const root = rootFor(mod, xml);
    const parsed = parseXml(root, xml);
    expect(safeParseXml(root, xml).success).toBe(true);
    expect(parseXml(root, serializeXml(root, parsed))).toEqual(parsed);
  });

  it("accepts several overflows behind a repeated wildcard", async () => {
    const xml = "<root><element1>a</element1><element1>b</element1><element1>c</element1></root>";
    const mod = await schemasFor(REPEATED_WILDCARD_AFTER);
    const root = rootFor(mod, xml);
    const parsed = parseXml(root, xml);
    expect(safeParseXml(root, xml).success).toBe(true);
    expect(parseXml(root, serializeXml(root, parsed))).toEqual(parsed);
  });
});
