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

// A single constrained wildcard must gate the duplicate exemption just like
// several do: it cannot claim an occurrence of a no-namespace element.
const SINGLE_OTHER_NAMESPACE_WILDCARD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:any namespace="urn:a"/>
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

// A wildcard on both sides of the element (the W3C addB135 e4 shape): each
// wildcard claims one of the two overflow occurrences.
const WILDCARDS_AROUND_ELEMENT = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="element1" type="xs:string"/>
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:any namespace="##any" processContents="strict"/>
        <xs:element ref="element1"/>
        <xs:any namespace="##any" processContents="strict"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

// A wildcard with maxOccurs=2 behind the element (the W3C addB135 e6 shape):
// together with the element's one occurrence it covers three.
const TWO_OCCURRENCE_WILDCARD_AFTER = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="element1" type="xs:string"/>
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element ref="element1"/>
        <xs:any namespace="##any" processContents="strict" maxOccurs="2"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

// One bounded wildcard between two distinct scalar fields: both fields can
// overflow onto it, but its maxOccurs is a capacity of the content model — a
// single wildcard occurrence can claim one element in total, not one per field.
const WILDCARD_BETWEEN_TWO_FIELDS = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="e" type="xs:string"/>
  <xs:element name="f" type="xs:string"/>
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:any namespace="##any" processContents="strict"/>
        <xs:element ref="e"/>
        <xs:element ref="f"/>
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

  it("rejects duplicates a single constrained wildcard cannot admit", async () => {
    const xml = "<root><e>a</e><e>b</e></root>";
    const mod = await schemasFor(SINGLE_OTHER_NAMESPACE_WILDCARD);
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

  it("rejects overflow beyond a preceding wildcard's maxOccurs", async () => {
    const xml = "<root><e>a</e><e>b</e><e>c</e></root>";
    const mod = await schemasFor(ANY_BEFORE);
    const result = safeParseXml(rootFor(mod, xml), xml);
    expect(result.success).toBe(false);
    expect(result.success === false && String(result.error)).toContain("occurs 3 times");
  });

  it("rejects overflow beyond the capacity of split same-name particles", async () => {
    const xml =
      "<root><element1>a</element1><element1>b</element1><element1>c</element1><element1>d</element1></root>";
    const mod = await schemasFor(ELEMENT_AROUND_WILDCARD);
    expect(safeParseXml(rootFor(mod, xml), xml).success).toBe(false);
  });

  it("rejects overflow beyond a repeated wildcard's maxOccurs", async () => {
    const xml =
      "<root><element1>a</element1><element1>b</element1><element1>c</element1><element1>d</element1><element1>e</element1></root>";
    const mod = await schemasFor(REPEATED_WILDCARD_AFTER);
    expect(safeParseXml(rootFor(mod, xml), xml).success).toBe(false);
  });

  it("accepts occurrences split across wildcards on both sides", async () => {
    const xml = "<root><element1>a</element1><element1>b</element1><element1>c</element1></root>";
    const mod = await schemasFor(WILDCARDS_AROUND_ELEMENT);
    const root = rootFor(mod, xml);
    const parsed = parseXml(root, xml);
    expect(safeParseXml(root, xml).success).toBe(true);
    expect(parseXml(root, serializeXml(root, parsed))).toEqual(parsed);
  });

  it("rejects overflow beyond wildcards on both sides", async () => {
    const xml =
      "<root><element1>a</element1><element1>b</element1><element1>c</element1><element1>d</element1></root>";
    const mod = await schemasFor(WILDCARDS_AROUND_ELEMENT);
    expect(safeParseXml(rootFor(mod, xml), xml).success).toBe(false);
  });

  it("accepts three occurrences behind a maxOccurs=2 wildcard", async () => {
    const xml = "<root><element1>a</element1><element1>b</element1><element1>c</element1></root>";
    const mod = await schemasFor(TWO_OCCURRENCE_WILDCARD_AFTER);
    const root = rootFor(mod, xml);
    const parsed = parseXml(root, xml);
    expect(safeParseXml(root, xml).success).toBe(true);
    expect(parseXml(root, serializeXml(root, parsed))).toEqual(parsed);
  });

  it("accepts one overflow claimed by a wildcard shared by two fields", async () => {
    const xml = "<root><e>a</e><e>b</e><f>c</f></root>";
    const mod = await schemasFor(WILDCARD_BETWEEN_TWO_FIELDS);
    const root = rootFor(mod, xml);
    const parsed = parseXml(root, xml);
    expect(safeParseXml(root, xml).success).toBe(true);
    expect(parseXml(root, serializeXml(root, parsed))).toEqual(parsed);
  });

  it("rejects two fields both overflowing onto one bounded wildcard", async () => {
    const xml = "<root><e>a</e><e>b</e><f>c</f><f>d</f></root>";
    const mod = await schemasFor(WILDCARD_BETWEEN_TWO_FIELDS);
    const result = safeParseXml(rootFor(mod, xml), xml);
    expect(result.success).toBe(false);
    expect(result.success === false && String(result.error)).toContain("occurs 2 times");
  });

  it("rejects overflow beyond a maxOccurs=2 wildcard", async () => {
    const xml =
      "<root><element1>a</element1><element1>b</element1><element1>c</element1><element1>d</element1></root>";
    const mod = await schemasFor(TWO_OCCURRENCE_WILDCARD_AFTER);
    expect(safeParseXml(rootFor(mod, xml), xml).success).toBe(false);
  });
});
