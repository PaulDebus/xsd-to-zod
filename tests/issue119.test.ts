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
