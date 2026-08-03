import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { parseXml } from "../src/index.js";
import { generateAndImport, withTempDirAsync } from "./helpers.js";

// Nested choice groups: an inner choice is only reachable through its
// enclosing outer branch, so its check is gated on that branch being
// selected — and the outer branch is only complete when the inner choice is.

const schemaFor = async (xsd: string): Promise<z.ZodType> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    mod = await generateAndImport([file]);
  });
  return Object.values(mod)[0] as z.ZodType;
};

const NESTED_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="T">
    <xs:choice>
      <xs:sequence>
        <xs:element name="x1" type="xs:string"/>
        <xs:element name="x2" type="xs:string"/>
      </xs:sequence>
      <xs:choice>
        <xs:element name="y1" type="xs:string"/>
        <xs:element name="y2" type="xs:string"/>
      </xs:choice>
    </xs:choice>
  </xs:complexType>
  <xs:element name="t" type="T"/>
</xs:schema>`;

describe("nested choice groups", () => {
  it("does not enforce the inner choice when the sibling branch is selected", async () => {
    const schema = await schemaFor(NESTED_XSD);
    expect(parseXml(schema, "<t><x1>a</x1><x2>b</x2></t>")).toEqual({ x1: "a", x2: "b" });
  });

  it("enforces the inner choice when its branch is selected", async () => {
    const schema = await schemaFor(NESTED_XSD);
    expect(parseXml(schema, "<t><y1>a</y1></t>")).toEqual({ y1: "a" });
    expect(() => parseXml(schema, "<t><y1>a</y1><y2>b</y2></t>")).toThrow(/choice/);
  });

  it("rejects a partial outer branch and mixed branches", async () => {
    const schema = await schemaFor(NESTED_XSD);
    expect(() => parseXml(schema, "<t><x1>a</x1></t>")).toThrow(/choice/);
    expect(() => parseXml(schema, "<t><x1>a</x1><x2>b</x2><y1>c</y1></t>")).toThrow(/choice/);
  });

  it("an absent optional inner choice does not count its outer branch as complete", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="T">
    <xs:choice minOccurs="0">
      <xs:sequence>
        <xs:element name="x1" type="xs:string"/>
        <xs:element name="x2" type="xs:string"/>
      </xs:sequence>
      <xs:choice>
        <xs:element name="y1" type="xs:string"/>
        <xs:element name="y2" type="xs:string"/>
      </xs:choice>
    </xs:choice>
  </xs:complexType>
  <xs:element name="t" type="T"/>
</xs:schema>`);
    expect(parseXml(schema, "<t><x1>a</x1><x2>b</x2></t>")).toEqual({ x1: "a", x2: "b" });
    expect(parseXml(schema, "<t/>")).toEqual({});
  });

  it("a complete wider branch absorbs an overlapping narrower one", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="T">
    <xs:choice>
      <xs:sequence>
        <xs:element name="e1" type="xs:string"/>
        <xs:element name="e2" type="xs:string"/>
      </xs:sequence>
      <xs:element name="e2" type="xs:string"/>
    </xs:choice>
  </xs:complexType>
  <xs:element name="t" type="T"/>
</xs:schema>`);
    expect(parseXml(schema, "<t><e1>a</e1><e2>b</e2></t>")).toEqual({ e1: "a", e2: "b" });
  });

  it("a choice with a wildcard branch is satisfiable through it", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
  xmlns:n="urn:other" elementFormDefault="qualified">
  <xs:complexType name="T">
    <xs:choice>
      <xs:element name="s1" type="xs:string"/>
      <xs:any namespace="urn:other" processContents="skip"/>
    </xs:choice>
  </xs:complexType>
  <xs:element name="t" type="T"/>
</xs:schema>`);
    expect(parseXml(schema, '<t xmlns:n="urn:other"><n:foo/></t>')).toEqual({
      "{urn:other}foo": "",
    });
  });
});
