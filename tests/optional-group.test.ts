import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { XsdIr } from "../src/index.js";
import { irToZod, parseXml, parseXsd, serializeXml } from "../src/index.js";
import { generateAndImport, onlyRootSchema, withTempDirAsync } from "./helpers.js";

// Optional group particles are optional as a unit: an occurrence contributes
// all of its required members or none of it, so a partial match must fail
// even though every member is individually optional in the generated schema.

const schemaFor = async (xsd: string, opts?: Parameters<typeof irToZod>[1]): Promise<z.ZodType> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    mod = await generateAndImport([file], opts);
  });
  return onlyRootSchema(mod);
};

const withXsd = async <T>(xsd: string, fn: (file: string) => Promise<T>): Promise<T> => {
  let out!: T;
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    out = await fn(file);
  });
  return out;
};

const irFor = async (xsd: string): Promise<XsdIr> => withXsd(xsd, async (file) => parseXsd([file]));

const codeFor = async (xsd: string, opts?: Parameters<typeof irToZod>[1]): Promise<string> =>
  withXsd(xsd, async (file) => irToZod(await parseXsd([file]), opts).schemas);

// Two optional groups sharing one required element: every member of a group
// that shows up needs the group's other members too.
const SHARED_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="T">
    <xs:sequence>
      <xs:group ref="g1" minOccurs="0"/>
      <xs:group ref="g2" minOccurs="0"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="t" type="T"/>
  <xs:group name="g1">
    <xs:sequence>
      <xs:element name="r1" type="xs:string"/>
      <xs:element name="r2" type="xs:string"/>
    </xs:sequence>
  </xs:group>
  <xs:group name="g2">
    <xs:sequence>
      <xs:element name="r2" type="xs:string"/>
      <xs:element name="r3" type="xs:string"/>
    </xs:sequence>
  </xs:group>
</xs:schema>`;

// Each optional group contributes alternatives: one per branch of the
// required choice inside g2.
const ALTERNATIVES_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="T">
    <xs:sequence>
      <xs:group ref="g1" minOccurs="0"/>
      <xs:group ref="g2" minOccurs="0"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="t" type="T"/>
  <xs:group name="g1">
    <xs:sequence>
      <xs:element name="x1" type="xs:string"/>
      <xs:element name="x2" type="xs:string"/>
    </xs:sequence>
  </xs:group>
  <xs:group name="g2">
    <xs:choice>
      <xs:element name="y1" type="xs:string"/>
      <xs:element name="y2" type="xs:string"/>
    </xs:choice>
  </xs:group>
</xs:schema>`;

// An element whose qname is declared both inside and outside the group: the
// occurrence cannot be attributed to one or the other, so it explains itself.
const EXEMPT_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="T">
    <xs:sequence>
      <xs:element name="a" type="xs:string" minOccurs="0"/>
      <xs:group ref="g" minOccurs="0"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="t" type="T"/>
  <xs:group name="g">
    <xs:sequence>
      <xs:element name="a" type="xs:string"/>
      <xs:element name="b" type="xs:string"/>
    </xs:sequence>
  </xs:group>
</xs:schema>`;

const NEVER_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="T">
    <xs:sequence>
      <xs:group ref="g" minOccurs="0" maxOccurs="0"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="t" type="T"/>
  <xs:group name="g">
    <xs:sequence>
      <xs:element name="a" type="xs:string"/>
    </xs:sequence>
  </xs:group>
</xs:schema>`;

describe("optional groups as a unit", () => {
  it("accepts an absent group and a complete one, including overlapping groups", async () => {
    const schema = await schemaFor(SHARED_XSD);
    expect(parseXml(schema, "<t/>")).toEqual({});
    // r2 is declared in both groups, so its merged field carries up to two
    // occurrences and parses into an array.
    expect(parseXml(schema, "<t><r1>a</r1><r2>b</r2></t>")).toEqual({ r1: "a", r2: ["b"] });
    expect(parseXml(schema, "<t><r2>b</r2><r3>c</r3></t>")).toEqual({ r2: ["b"], r3: "c" });
    expect(parseXml(schema, "<t><r1>a</r1><r2>b</r2><r3>c</r3></t>")).toEqual({
      r1: "a",
      r2: ["b"],
      r3: "c",
    });
  });

  it("rejects a partial group, whatever the missing member is", async () => {
    const schema = await schemaFor(SHARED_XSD);
    for (const xml of [
      "<t><r1>a</r1></t>",
      "<t><r3>c</r3></t>",
      "<t><r2>b</r2></t>",
      "<t><r1>a</r1><r3>c</r3></t>",
    ]) {
      expect(() => parseXml(schema, xml)).toThrow(/optional model group/);
    }
  });

  it("round-trips every accepted document", async () => {
    const schema = await schemaFor(SHARED_XSD);
    for (const xml of [
      "<t></t>",
      "<t><r1>a</r1><r2>b</r2></t>",
      "<t><r2>b</r2><r3>c</r3></t>",
      "<t><r1>a</r1><r2>b</r2><r3>c</r3></t>",
    ]) {
      expect(serializeXml(schema, parseXml(schema, xml))).toBe(xml);
    }
  });

  it("collects one alternative per required choice branch", async () => {
    const ir = await irFor(ALTERNATIVES_XSD);
    const type = ir.complexTypes["{}T"];
    expect(type?.optionalUnits).toEqual({
      u0: {
        members: ["{}x1", "{}x2"],
        alternatives: [["{}x1", "{}x2"]],
      },
      u1: {
        members: ["{}y1", "{}y2"],
        alternatives: [["{}y1"], ["{}y2"]],
      },
    });
  });

  it("accepts any complete branch and rejects a partial one", async () => {
    const schema = await schemaFor(ALTERNATIVES_XSD);
    expect(parseXml(schema, "<t/>")).toEqual({});
    expect(parseXml(schema, "<t><x1>a</x1><x2>b</x2></t>")).toEqual({ x1: "a", x2: "b" });
    expect(parseXml(schema, "<t><y1>a</y1></t>")).toEqual({ y1: "a" });
    expect(parseXml(schema, "<t><y2>b</y2></t>")).toEqual({ y2: "b" });
    expect(() => parseXml(schema, "<t><x1>a</x1></t>")).toThrow(/optional model group/);
    expect(() => parseXml(schema, "<t><y1>a</y1><y2>b</y2></t>")).toThrow();
  });

  it("lets a member declared outside the group explain itself", async () => {
    const schema = await schemaFor(EXEMPT_XSD);
    expect(parseXml(schema, "<t/>")).toEqual({});
    expect(parseXml(schema, "<t><a>x</a></t>")).toEqual({ a: ["x"] });
    expect(parseXml(schema, "<t><a>x</a><b>y</b></t>")).toEqual({ a: ["x"], b: "y" });
    expect(() => parseXml(schema, "<t><b>y</b></t>")).toThrow(/optional model group/);
  });

  it("keeps a group that can never occur out of the document", async () => {
    const schema = await schemaFor(NEVER_XSD);
    expect(parseXml(schema, "<t/>")).toEqual({});
    expect(() => parseXml(schema, "<t><a>x</a></t>")).toThrow(/optional model group/);
  });

  it("emits type annotations only for TypeScript output", async () => {
    expect(await codeFor(SHARED_XSD)).toContain("const present = (k: string): boolean =>");
    const js = await codeFor(SHARED_XSD, { js: true });
    expect(js).toContain("const present = (k) =>");
    expect(js).not.toMatch(/present = \(k: string\)/);
    expect(js).not.toMatch(/seen = \(q: string\)/);
  });
});
