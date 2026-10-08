import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { parseXml, safeParseXml } from "../src/index.js";
import { generateAndImport, withTempDirAsync } from "./helpers.js";

// xs:element block / xs:complexType block / xs:schema blockDefault: the
// effective block set forbids xsi:type derivations by the blocked method
// (extension/restriction) and substitution-group replacements
// ("substitution", plus members whose type derives by a blocked method).

// block on the element declaration: xsi:type by restriction is blocked,
// extension stays allowed.
const ELEMENT_BLOCK_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element ref="item" maxOccurs="unbounded"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
  <xs:element name="item" type="Base" block="restriction"/>
  <xs:complexType name="Base">
    <xs:sequence><xs:element name="a" type="xs:string" minOccurs="0"/></xs:sequence>
  </xs:complexType>
  <xs:complexType name="Restricted">
    <xs:complexContent>
      <xs:restriction base="Base">
        <xs:sequence><xs:element name="a" type="xs:string" minOccurs="0"/></xs:sequence>
      </xs:restriction>
    </xs:complexContent>
  </xs:complexType>
  <xs:complexType name="Extended">
    <xs:complexContent>
      <xs:extension base="Base">
        <xs:sequence><xs:element name="b" type="xs:string" minOccurs="0"/></xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
</xs:schema>`;

// block on the TYPE applies whatever element declares it; a multi-step chain
// is blocked when any step uses the blocked method.
const TYPE_BLOCK_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="item" type="Base" maxOccurs="unbounded"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
  <xs:complexType name="Base" block="extension">
    <xs:sequence><xs:element name="a" type="xs:string" minOccurs="0"/></xs:sequence>
  </xs:complexType>
  <xs:complexType name="Restricted">
    <xs:complexContent>
      <xs:restriction base="Base">
        <xs:sequence><xs:element name="a" type="xs:string" minOccurs="0"/></xs:sequence>
      </xs:restriction>
    </xs:complexContent>
  </xs:complexType>
  <xs:complexType name="ExtendedRestricted">
    <xs:complexContent>
      <xs:extension base="Restricted"/>
    </xs:complexContent>
  </xs:complexType>
</xs:schema>`;

// blockDefault supplies the block of every declaration in the file that does
// not set its own; a simple-type xsi:type is checked the same way.
const BLOCK_DEFAULT_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" blockDefault="#all">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element ref="num" maxOccurs="unbounded"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
  <xs:element name="num" type="xs:int"/>
  <xs:simpleType name="smallInt">
    <xs:restriction base="xs:int">
      <xs:maxInclusive value="10"/>
    </xs:restriction>
  </xs:simpleType>
</xs:schema>`;

// A union member type is validly derived from the union (the union step
// itself is never blocked), but a restriction of a member hits
// block="restriction".
const UNION_MEMBER_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element ref="v" maxOccurs="unbounded"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
  <xs:element name="v" type="AorB" block="restriction"/>
  <xs:simpleType name="A">
    <xs:restriction base="xs:int"/>
  </xs:simpleType>
  <xs:simpleType name="B">
    <xs:restriction base="xs:string"/>
  </xs:simpleType>
  <xs:simpleType name="SmallA">
    <xs:restriction base="A">
      <xs:maxInclusive value="10"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="AorB">
    <xs:union memberTypes="A B"/>
  </xs:simpleType>
</xs:schema>`;

// Substitution groups: block="substitution" rejects member replacements;
// block="restriction" rejects members whose type restricts the head's type.
const SUBST_BLOCK_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element ref="head" maxOccurs="unbounded"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
  <xs:element name="head" type="xs:string" block="substitution"/>
  <xs:element name="member" type="xs:string" substitutionGroup="head"/>
</xs:schema>`;

const SUBST_TYPE_BLOCK_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element ref="head" maxOccurs="unbounded"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
  <xs:element name="head" type="xs:string" block="restriction"/>
  <xs:simpleType name="restrictedString">
    <xs:restriction base="xs:string"/>
  </xs:simpleType>
  <xs:element name="member" type="restrictedString" substitutionGroup="head"/>
</xs:schema>`;

// The head TYPE's block blocks substitution members too, even when the head
// element declares no block of its own.
const SUBST_HEAD_TYPE_BLOCK_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element ref="head" maxOccurs="unbounded"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
  <xs:element name="head" type="Base"/>
  <xs:complexType name="Base" block="restriction">
    <xs:sequence><xs:element name="a" type="xs:string" minOccurs="0"/></xs:sequence>
  </xs:complexType>
  <xs:complexType name="Restricted">
    <xs:complexContent>
      <xs:restriction base="Base">
        <xs:sequence><xs:element name="a" type="xs:string" minOccurs="0"/></xs:sequence>
      </xs:restriction>
    </xs:complexContent>
  </xs:complexType>
  <xs:element name="member" type="Restricted" substitutionGroup="head"/>
</xs:schema>`;

const load = async (xsd: string): Promise<z.ZodType> => {
  let schema: z.ZodType | undefined;
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    const mod = await generateAndImport([file]);
    schema = mod["rootSchema"] as z.ZodType;
  });
  if (schema === undefined) {
    throw new Error("no root schema generated");
  }
  return schema;
};

describe("block / blockDefault enforcement", () => {
  it("element block=restriction rejects a restricted xsi:type, allows extension", async () => {
    const schema = await load(ELEMENT_BLOCK_XSD);
    expect(
      safeParseXml(
        schema,
        '<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><item xsi:type="Restricted"/></root>',
      ).success,
    ).toBe(false);
    expect(() =>
      parseXml(
        schema,
        '<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><item xsi:type="Restricted"/></root>',
      ),
    ).toThrow(/derives by restriction, blocked/);
    expect(
      safeParseXml(
        schema,
        '<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><item xsi:type="Extended"/></root>',
      ).success,
    ).toBe(true);
    expect(parseXml(schema, "<root><item/></root>")).toEqual({ item: [{}] });
  });

  it("type block=extension applies to every element of that type, across derivation chains", async () => {
    const schema = await load(TYPE_BLOCK_XSD);
    // ExtendedRestricted derives extension-of-restriction: the chain uses
    // extension, which Base blocks.
    expect(() =>
      parseXml(
        schema,
        '<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><item xsi:type="ExtendedRestricted"/></root>',
      ),
    ).toThrow(/derives by extension, blocked/);
    // A pure restriction chain stays allowed; the xsiType discriminant is
    // recorded for the derived variant.
    expect(
      parseXml(
        schema,
        '<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><item xsi:type="Restricted"/></root>',
      ),
    ).toEqual({ item: [{ xsiType: "{}Restricted" }] });
  });

  it("blockDefault=#all blocks simple-type xsi:type derivations", async () => {
    const schema = await load(BLOCK_DEFAULT_XSD);
    expect(() =>
      parseXml(
        schema,
        '<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><num xsi:type="smallInt">5</num></root>',
      ),
    ).toThrow(/derives by restriction, blocked/);
    expect(parseXml(schema, "<root><num>5</num></root>")).toEqual({ num: [5] });
  });

  it("an xsi:type that is not derived from the declared type is rejected when the module knows it", async () => {
    const schema = await load(BLOCK_DEFAULT_XSD);
    expect(() =>
      parseXml(
        schema,
        '<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema"><num xsi:type="xs:string">x</num></root>',
      ),
    ).toThrow(/is not derived from the declared type/);
  });

  it("a union member type is a valid xsi:type for the union; a restricted member hits block=restriction", async () => {
    const schema = await load(UNION_MEMBER_XSD);
    expect(
      parseXml(
        schema,
        '<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><v xsi:type="A">5</v></root>',
      ),
    ).toEqual({ v: [5] });
    expect(() =>
      parseXml(
        schema,
        '<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><v xsi:type="SmallA">5</v></root>',
      ),
    ).toThrow(/derives by restriction, blocked/);
  });

  it("block=substitution rejects substitution-group members", async () => {
    const schema = await load(SUBST_BLOCK_XSD);
    expect(parseXml(schema, "<root><head>a</head></root>")).toEqual({ head: ["a"] });
    expect(() => parseXml(schema, "<root><member>a</member></root>")).toThrow(
      /substitutes for .* which its block forbids/,
    );
  });

  it("block=restriction on the head rejects members with restricted types", async () => {
    const schema = await load(SUBST_TYPE_BLOCK_XSD);
    expect(parseXml(schema, "<root><head>a</head></root>")).toEqual({ head: ["a"] });
    expect(() => parseXml(schema, "<root><member>a</member></root>")).toThrow(
      /derives by restriction/,
    );
  });

  it("the head type's block rejects substitution members even without an element block", async () => {
    const schema = await load(SUBST_HEAD_TYPE_BLOCK_XSD);
    expect(() => parseXml(schema, "<root><member/></root>")).toThrow(/derives by restriction/);
  });
});
