import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseXsd } from "../src/index.js";
import { withTempDir } from "./helpers.js";

// Regression tests for redefine self-references: a group/attributeGroup/
// simpleType redefined in terms of itself must resolve the self-reference
// against the ORIGINAL definition, not recurse into the override.

const REDEFINED_MODULE = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:attributeGroup name="car">
    <xs:attribute name="attFix" type="xs:int" fixed="37"/>
  </xs:attributeGroup>
  <xs:group name="grp">
    <xs:sequence><xs:element name="orig" type="xs:string"/></xs:sequence>
  </xs:group>
  <xs:simpleType name="yn">
    <xs:restriction base="xs:string"/>
  </xs:simpleType>
</xs:schema>`;

const MAIN = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:redefine schemaLocation="module.xsd">
    <xs:attributeGroup name="car">
      <xs:attributeGroup ref="car"/>
      <xs:attribute name="foo" type="xs:string"/>
    </xs:attributeGroup>
    <xs:group name="grp">
      <xs:sequence>
        <xs:group ref="grp"/>
        <xs:element name="added" type="xs:string"/>
      </xs:sequence>
    </xs:group>
    <xs:simpleType name="yn">
      <xs:restriction base="yn">
        <xs:enumeration value="yes"/>
        <xs:enumeration value="no"/>
      </xs:restriction>
    </xs:simpleType>
  </xs:redefine>
  <xs:element name="doc">
    <xs:complexType>
      <xs:sequence><xs:group ref="grp"/></xs:sequence>
      <xs:attributeGroup ref="car"/>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const parse = (): ReturnType<typeof parseXsd> => {
  let ir: ReturnType<typeof parseXsd> | undefined;
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, "module.xsd"), REDEFINED_MODULE);
    const main = path.join(dir, "main.xsd");
    fs.writeFileSync(main, MAIN);
    ir = parseXsd([main]);
  });
  return ir!;
};

describe("xs:redefine self-references", () => {
  it("attributeGroup self-ref expands the original instead of overflowing the stack", () => {
    const ir = parse();
    const doc = ir.complexTypes[ir.elements["{}doc"]!.typeName]!;
    const attrNames = doc.fields.filter((f) => f.kind === "attribute").map((f) => f.qname);
    expect(attrNames).toContain("{}attFix");
    expect(attrNames).toContain("{}foo");
  });

  it("group self-ref expands the original members", () => {
    const ir = parse();
    const doc = ir.complexTypes[ir.elements["{}doc"]!.typeName]!;
    const elemNames = doc.fields.filter((f) => f.kind === "element").map((f) => f.qname);
    expect(elemNames).toContain("{}orig");
    expect(elemNames).toContain("{}added");
  });

  it("simpleType self-base restriction derives from the preserved original", () => {
    const ir = parse();
    const yn = ir.simpleTypes["{}yn"]!;
    expect(yn.kind).toBe("restriction");
    if (yn.kind !== "restriction") {
      throw new Error("expected restriction");
    }
    expect(yn.baseType).toBe("{}yn-redefined");
    expect(ir.simpleTypes["{}yn-redefined"]).toBeDefined();
  });
});

// XSD 1.1 allows circular attributeGroup definitions (direct self-reference,
// not through xs:redefine). The expansion must break the cycle so fields from
// the non-self-referencing part are still collected.
const ATTGC010 = path.resolve("testdata/upstream/w3c-xsdtests/msData/attributeGroup/attgC010.xsd");

describe("circular attributeGroup self-reference (XSD 1.1)", () => {
  it("does not overflow the stack on a direct attributeGroup self-ref and emits a diagnostic", () => {
    const ir = parseXsd([ATTGC010]);
    expect(ir.diagnostics).toEqual([
      {
        kind: "circular-attribute-group-ref",
        message: 'circular attributeGroup ref "{}test" dropped',
        ref: "{}test",
      },
    ]);
    const testType = ir.complexTypes["{}test"]!;
    const attrNames = testType.fields.filter((f) => f.kind === "attribute").map((f) => f.qname);
    expect(attrNames).toContain("{}foo");
    expect(attrNames).toContain("{}bar");
  });
});

// Circular model groups must also be broken to prevent stack overflow.
const CIRCULAR_GROUP = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="T" type="test"/>
  <xs:complexType name="test">
    <xs:group ref="test"/>
  </xs:complexType>
  <xs:group name="test">
    <xs:sequence>
      <xs:group ref="test"/>
      <xs:element name="foo" type="xs:string"/>
    </xs:sequence>
  </xs:group>
</xs:schema>`;

describe("circular group self-reference (XSD 1.1)", () => {
  it("does not overflow the stack on a direct group self-ref and emits a diagnostic", () => {
    let ir: ReturnType<typeof parseXsd> | undefined;
    withTempDir((dir) => {
      const main = path.join(dir, "main.xsd");
      fs.writeFileSync(main, CIRCULAR_GROUP);
      ir = parseXsd([main]);
    });
    expect(ir!.diagnostics).toEqual([
      {
        kind: "circular-group-ref",
        message: 'circular group ref "{}test" dropped',
        ref: "{}test",
      },
    ]);
    const testType = ir!.complexTypes["{}test"]!;
    const elemNames = testType.fields.filter((f) => f.kind === "element").map((f) => f.qname);
    expect(elemNames).toContain("{}foo");
  });
});
