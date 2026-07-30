import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseXsd, safeParseXml } from "../src/index.js";
import { generateAndImport, withTempDirAsync } from "./helpers.js";

// Regression tests for the circular simple-type fix (#138): a union whose
// memberTypes reference the union itself, or a restriction/list whose
// derivation closes a cycle, is invalid XSD. The edge closing each cycle is
// dropped with a diagnostic, so the generated module neither crashes at load
// nor recurses without end at parse time.

const MUTUAL_UNION_XSD = `<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <xsd:simpleType name="st">
    <xsd:union memberTypes="xsd:int xsd:string st2"/>
  </xsd:simpleType>
  <xsd:simpleType name="st2">
    <xsd:union memberTypes="st"/>
  </xsd:simpleType>
  <xsd:element name="root" type="st"/>
</xsd:schema>`;

const SELF_LOOP_XSD = `<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <xsd:simpleType name="st">
    <xsd:union memberTypes="st"/>
  </xsd:simpleType>
  <xsd:element name="root" type="st"/>
</xsd:schema>`;

const LIST_CYCLE_XSD = `<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <xsd:simpleType name="st">
    <xsd:union memberTypes="xsd:int lst"/>
  </xsd:simpleType>
  <xsd:simpleType name="lst">
    <xsd:list itemType="st"/>
  </xsd:simpleType>
  <xsd:element name="root" type="st"/>
</xsd:schema>`;

const RESTRICTION_CYCLE_XSD = `<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <xsd:simpleType name="st">
    <xsd:union memberTypes="xsd:int r"/>
  </xsd:simpleType>
  <xsd:simpleType name="r">
    <xsd:restriction base="st"/>
  </xsd:simpleType>
  <xsd:element name="root" type="st"/>
</xsd:schema>`;

const writeSchema = (dir: string, xsd: string): string => {
  const file = path.join(dir, "schema.xsd");
  fs.writeFileSync(file, xsd);
  return file;
};

describe("circular simple-type references (#138)", () => {
  it("drops the circular union member with a diagnostic", async () => {
    await withTempDirAsync(async (dir) => {
      const ir = parseXsd([writeSchema(dir, MUTUAL_UNION_XSD)]);
      expect(ir.unresolvedRefs).toEqual([
        'circular union member "{}st" dropped from union "{}st2"',
      ]);
      const st2 = ir.simpleTypes["{}st2"];
      expect(st2?.kind === "union" && st2.memberTypes).toEqual([]);
      // Non-circular members are kept.
      const st = ir.simpleTypes["{}st"];
      expect(st?.kind === "union" && st.memberTypes).toHaveLength(3);
    });
  });

  it("generated module loads and validates through the remaining members", async () => {
    await withTempDirAsync(async (dir) => {
      const mod = await generateAndImport([writeSchema(dir, MUTUAL_UNION_XSD)]);
      const root = mod["rootSchema"] as import("zod").z.ZodType;
      expect(root).toBeDefined();
      expect(safeParseXml(root, "<root>5</root>").success).toBe(true);
      expect(safeParseXml(root, "<root>abcdefab</root>").success).toBe(true);
      // A value matching no member must reject — not overflow the stack.
      expect(safeParseXml(root, "<root><child/></root>").success).toBe(false);
    });
  });

  it("pure self-loop union empties the member list with a diagnostic", async () => {
    await withTempDirAsync(async (dir) => {
      const file = writeSchema(dir, SELF_LOOP_XSD);
      const ir = parseXsd([file]);
      expect(ir.unresolvedRefs).toEqual(['circular union member "{}st" dropped from union "{}st"']);
      // The emptied union rejects every value, but the module still loads.
      const mod = await generateAndImport([file]);
      const root = mod["rootSchema"] as import("zod").z.ZodType;
      expect(safeParseXml(root, "<root>5</root>").success).toBe(false);
      expect(safeParseXml(root, "<root>abcdefab</root>").success).toBe(false);
    });
  });

  it("drops a list whose item type closes a cycle", async () => {
    await withTempDirAsync(async (dir) => {
      const file = writeSchema(dir, LIST_CYCLE_XSD);
      const ir = parseXsd([file]);
      expect(ir.unresolvedRefs).toEqual([
        'circular list "{}lst" dropped (derives from itself through "{}st")',
      ]);
      expect(ir.simpleTypes["{}lst"]).toBeUndefined();
      const st = ir.simpleTypes["{}st"];
      expect(st?.kind === "union" && st.memberTypes).toEqual([
        "{http://www.w3.org/2001/XMLSchema}int",
      ]);
      const mod = await generateAndImport([file]);
      const root = mod["rootSchema"] as import("zod").z.ZodType;
      expect(safeParseXml(root, "<root>5</root>").success).toBe(true);
    });
  });

  it("drops a restriction whose base closes a cycle", async () => {
    await withTempDirAsync(async (dir) => {
      const file = writeSchema(dir, RESTRICTION_CYCLE_XSD);
      const ir = parseXsd([file]);
      expect(ir.unresolvedRefs).toEqual([
        'circular restriction "{}r" dropped (derives from itself through "{}st")',
      ]);
      expect(ir.simpleTypes["{}r"]).toBeUndefined();
      const mod = await generateAndImport([file]);
      const root = mod["rootSchema"] as import("zod").z.ZodType;
      expect(safeParseXml(root, "<root>5</root>").success).toBe(true);
    });
  });
});
