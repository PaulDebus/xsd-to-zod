import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseXsd } from "../src/index.js";
import type { ComplexTypeDef, IrField, QName } from "../src/types.js";
import { asRestriction } from "./helpers.js";

// Reproductions for the three parseXsd robustness gaps tracked in #94.
const FIXTURES = path.resolve("testdata/regressions/issue-94");
const XSD_NS = "http://www.w3.org/2001/XMLSchema";

const localName = (field: IrField): string => field.qname.split("}").pop() ?? field.qname;

describe("issue #94: circular simpleContent bases", () => {
  it("chain-walk terminates on redefine of circular simpleContent types", async () => {
    const ir = await parseXsd([path.join(FIXTURES, "cycle-redefine.xsd")]);
    const typeA = ir.complexTypes["{urn:cycle}A" as QName]!;
    expect(typeA).toBeDefined();
    const attrs = new Set(typeA.fields.filter((f) => f.kind === "attribute").map(localName));
    expect(attrs).toEqual(new Set(["a1", "b1", "a2"]));
    expect(typeA.fields.some((f) => f.kind === "text")).toBe(true);
  });
});

describe("issue #94: cross-file group/attributeGroup refs", () => {
  let ir!: Awaited<ReturnType<typeof parseXsd>>;
  let main!: ComplexTypeDef;
  beforeAll(async () => {
    ir = await parseXsd([path.join(FIXTURES, "group-main.xsd")]);
    main = ir.complexTypes["{urn:main}Main" as QName]!;
  });

  it("member type QNames resolve with the defining file’s nsMap", async () => {
    const amount = main.fields.find((f) => f.kind === "element" && localName(f) === "amount");
    expect(amount?.typeName).toBe(`{urn:types}Money`);
    const currency = main.fields.find((f) => f.kind === "attribute" && localName(f) === "currency");
    expect(currency?.typeName).toBe(`{urn:types}Currency`);
  });

  it("inlined group elements use the defining schema’s namespace context", async () => {
    const amount = main.fields.find((f) => f.kind === "element" && localName(f) === "amount");
    expect(amount?.qname).toBe("{urn:defs}amount");
  });
});

describe("issue #94: unprefixed type refs vs default xmlns", () => {
  let ir!: Awaited<ReturnType<typeof parseXsd>>;
  let main!: ComplexTypeDef;
  beforeAll(async () => {
    ir = await parseXsd([path.join(FIXTURES, "default-ns.xsd")]);
    main = ir.complexTypes["{urn:dns}Main" as QName]!;
  });

  it("unprefixed local element type resolves to the declared default namespace", async () => {
    const qty = main.fields.find((f) => localName(f) === "qty");
    expect(qty?.typeName).toBe(`{${XSD_NS}}int`);
  });

  it("unprefixed top-level element type resolves to the declared default namespace", async () => {
    expect(ir.elements["{urn:dns}title" as QName]?.typeName).toBe(`{${XSD_NS}}string`);
  });

  it("unprefixed inline simpleType restriction base resolves to the declared default namespace", async () => {
    const code = main.fields.find((f) => localName(f) === "code");
    expect(code).toBeDefined();
    const synthetic = ir.simpleTypes[code!.typeName];
    expect(synthetic).toBeDefined();
    expect(asRestriction(synthetic!).baseType).toBe(`{${XSD_NS}}int`);
  });
});
