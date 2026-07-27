import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { parseXml } from "../src/index.js";
import { generateAndImport, withTempDirAsync } from "./helpers.js";

// Regression test for choice-group id collisions across a derivation: an
// extension's xs:choice is a separate group appended after the base content,
// not extra branches of the base's choice.

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:ch" xmlns:t="urn:ch" elementFormDefault="qualified">
  <xs:complexType name="Base">
    <xs:choice>
      <xs:element name="a" type="xs:string"/>
      <xs:element name="b" type="xs:string"/>
    </xs:choice>
  </xs:complexType>
  <xs:complexType name="Derived">
    <xs:complexContent>
      <xs:extension base="t:Base">
        <xs:choice>
          <xs:element name="c" type="xs:string"/>
        </xs:choice>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
  <xs:element name="root" type="t:Derived"/>
</xs:schema>`;

describe("choice groups across extension (#121)", () => {
  it("accepts one branch from the base choice plus one from the extension choice", async () => {
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, XSD);
      const mod = await generateAndImport([file]);
      const schema = Object.values(mod)[0] as z.ZodType;

      const valid = parseXml(schema, '<root xmlns="urn:ch"><b>1</b><c>2</c></root>');
      expect(valid).toEqual({ b: "1", c: "2" });

      // Two branches of the same (base) choice are still rejected.
      expect(() =>
        parseXml(schema, '<root xmlns="urn:ch"><a>1</a><b>2</b><c>3</c></root>'),
      ).toThrow(/choice/);
    });
  });
});
