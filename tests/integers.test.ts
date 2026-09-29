import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { irToZod, parseXml, parseXsd } from "../src/index.js";
import { generateAndImport, importGeneratedSchemas, withTempDirAsync } from "./helpers.js";

// Integer-mapping acceptance, shaped on the ISO 23387 data templates whose
// MajorVersion/MinorVersion are xs:nonNegativeInteger: the parsed data must
// be plain JSON-serializable numbers by default.

const ISO_SHAPED_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:iso-shaped" xmlns:t="urn:iso-shaped" elementFormDefault="qualified">
  <xs:complexType name="TemplateType">
    <xs:sequence>
      <xs:element name="MajorVersion" type="xs:nonNegativeInteger"/>
      <xs:element name="MinorVersion" type="xs:nonNegativeInteger"/>
      <xs:element name="Name" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="Template" type="t:TemplateType"/>
</xs:schema>`;

const ANNEX_F_SHAPED_XML = `<Template xmlns="urn:iso-shaped"><MajorVersion>1</MajorVersion><MinorVersion>0</MinorVersion><Name>Pipe</Name></Template>`;

describe("integer mapping (default: number)", () => {
  it("emits z.number().int() and a number TS type for xs:nonNegativeInteger", async () => {
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, ISO_SHAPED_XSD);
      const { schemas } = irToZod(await parseXsd([file]));
      expect(schemas).toContain('"MajorVersion": z.number().int().min(0)');
      expect(schemas).toContain('"MinorVersion": z.number().int().min(0)');
      expect(schemas).toContain('"MajorVersion": number;');
      expect(schemas).not.toContain("bigint");
    });
  });

  it("parses version fields as numbers; JSON.stringify works on the result", async () => {
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, ISO_SHAPED_XSD);
      const mod = await generateAndImport([file]);
      const templateSchema = mod["TemplateSchema"] as z.ZodType;
      const parsed = parseXml(templateSchema, ANNEX_F_SHAPED_XML) as Record<string, unknown>;
      expect(parsed).toEqual({ MajorVersion: 1, MinorVersion: 0, Name: "Pipe" });
      expect(JSON.stringify(parsed)).toBe('{"MajorVersion":1,"MinorVersion":0,"Name":"Pipe"}');
    });
  });
});

describe("integer mapping (opt-in: bigint)", () => {
  it("restores z.bigint() output and bigint TS types", async () => {
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, ISO_SHAPED_XSD);
      const { schemas } = irToZod(await parseXsd([file]), { integers: "bigint" });
      expect(schemas).toContain('"MajorVersion": z.bigint().min(0n)');
      expect(schemas).toContain('"MajorVersion": bigint;');
    });
  });

  it("parses version fields as bigint", async () => {
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, ISO_SHAPED_XSD);
      const mod = await importGeneratedSchemas(
        irToZod(await parseXsd([file]), { integers: "bigint" }).schemas,
      );
      const templateSchema = mod["TemplateSchema"] as z.ZodType;
      const parsed = parseXml(templateSchema, ANNEX_F_SHAPED_XML) as Record<string, unknown>;
      expect(parsed).toEqual({ MajorVersion: 1n, MinorVersion: 0n, Name: "Pipe" });
    });
  });
});
