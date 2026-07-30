import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { irToZod, parseXsd } from "../src/index.js";
import { generateAndImport, withTempDir, withTempDirAsync } from "./helpers.js";

describe("circular union self-reference (#138)", () => {
  it("emits loadable code for mutually recursive union types", () => {
    withTempDir((dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(
        file,
        `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:circ" xmlns:t="urn:circ">
  <xs:simpleType name="st">
    <xs:union memberTypes="xs:int xs:string t:st2"/>
  </xs:simpleType>
  <xs:simpleType name="st2">
    <xs:union memberTypes="t:st"/>
  </xs:simpleType>
  <xs:element name="root" type="t:st"/>
</xs:schema>`,
      );
      const ir = parseXsd([file]);
      const generated = irToZod(ir);
      // Both cyclic types are flattened to their non-cyclic member set.
      expect(generated.schemas).toContain(
        'const st2Schema = z.union([z.number().int().min(-2147483648).max(2147483647), z.string()]).register(xmlRegistry, { qname: "{urn:circ}st2" });',
      );
      expect(generated.schemas).toContain(
        'const stSchema = z.union([z.number().int().min(-2147483648).max(2147483647), z.string()]).register(xmlRegistry, { qname: "{urn:circ}st" });',
      );
    });
  });

  it("round-trips valid values for a cyclic union", async () => {
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(
        file,
        `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:circ" xmlns:t="urn:circ" elementFormDefault="qualified">
  <xs:simpleType name="st">
    <xs:union memberTypes="xs:int xs:string t:st2"/>
  </xs:simpleType>
  <xs:simpleType name="st2">
    <xs:union memberTypes="t:st"/>
  </xs:simpleType>
  <xs:element name="root" type="t:st"/>
</xs:schema>`,
      );
      const mod = await generateAndImport([file]);
      const rootSchema = mod["rootSchema"] as z.ZodType;

      const { parseXml, safeParseXml } = await import("../src/index.js");

      const parsedInt = parseXml(rootSchema, '<root xmlns="urn:circ">42</root>');
      expect(parsedInt).toBe(42);

      const parsedString = parseXml(rootSchema, '<root xmlns="urn:circ">hello</root>');
      expect(parsedString).toBe("hello");

      const safeInvalid = safeParseXml(rootSchema, '<root xmlns="urn:circ"><nested/></root>');
      expect(safeInvalid.success).toBe(false);
    });
  });

  it("emits z.never() for a pure self-loop union", () => {
    withTempDir((dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(
        file,
        `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:simpleType name="st">
    <xs:union memberTypes="st"/>
  </xs:simpleType>
</xs:schema>`,
      );
      const ir = parseXsd([file]);
      const generated = irToZod(ir);
      expect(generated.schemas).toContain(
        'const stSchema = z.never().register(xmlRegistry, { qname: "{}st" });',
      );
    });
  });
});
