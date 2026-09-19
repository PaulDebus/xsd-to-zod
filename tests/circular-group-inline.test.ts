import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseXsd } from "../src/index.js";
import { generateAndImport } from "./helpers.js";

// Regression: circular group refs whose cycle passes through an element's
// inline complexType (particlesZ010) or through an xs:extension inside one
// (addB077) used to escape the expansion-stack cycle guard — each deferred
// inline type re-expanded the group and minted a fresh synthetic type, so
// parseXsd recursed until the heap gave out. Inline types are now memoized
// by node, which both terminates the expansion and yields the correct
// recursive IR.

const PARTICLES_Z010 = path.resolve(
  "testdata/upstream/w3c-xsdtests/msData/particles/particlesZ010.xsd",
);
const ADD_B077 = path.resolve("testdata/upstream/w3c-xsdtests/msData/additional/addB077.xsd");

describe("circular group ref through an inline type", () => {
  it("group ref inside the inline type of its own element (particlesZ010)", async () => {
    const ir = await parseXsd([PARTICLES_Z010]);
    expect(ir.diagnostics).toEqual([]);
    const list = ir.complexTypes["{}a_ul_Type"]!;
    const ul = list.fields.find((f) => f.kind === "element" && f.qname === "{}ul");
    expect(ul).toMatchObject({ typeName: "{}a_ul_Type" });
    expect(list.fields.some((f) => f.kind === "element" && f.qname === "{}li")).toBe(true);
  });

  it("group ref inside an xs:extension of an inline type (addB077)", async () => {
    const ir = await parseXsd([ADD_B077]);
    expect(ir.diagnostics).toEqual([]);
    const ext = ir.complexTypes["{}anonymous_elem_Type_x_Type"]!;
    expect(ext.baseType).toBe("{}complexType");
    const x = ext.fields.find((f) => f.kind === "element" && f.qname === "{}x");
    expect(x).toMatchObject({ typeName: "{}anonymous_elem_Type_x_Type" });
  });

  it("codegen handles the self-recursive synthetic types", async () => {
    const mod = await generateAndImport([ADD_B077]);
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });
});
