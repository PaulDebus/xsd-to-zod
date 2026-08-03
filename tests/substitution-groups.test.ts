import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { parseXml, parseXsd, serializeXml } from "../src/index.js";
import { generateAndImport, withTempDirAsync } from "./helpers.js";

// Substitution groups: a member element is accepted wherever its head is
// expected, read with the member's own type, and serialized back under the
// member's tag.

const moduleFor = async (
  xsds: Record<string, string>,
): Promise<Record<string, unknown>> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const files: string[] = [];
    for (const [name, content] of Object.entries(xsds)) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, content);
      files.push(file);
    }
    mod = await generateAndImport(files);
  });
  return mod;
};

const rootsByLocalName = (mod: Record<string, unknown>): Map<string, z.ZodType> => {
  const roots = new Map<string, z.ZodType>();
  for (const [key, value] of Object.entries(mod)) {
    if (key.endsWith("Schema") && value !== null && typeof value === "object" && "_zod" in value) {
      roots.set(key, value as z.ZodType);
    }
  }
  return roots;
};

const SIMPLE_HEAD_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:sg" xmlns:t="urn:sg" elementFormDefault="qualified">
  <xs:simpleType name="headType">
    <xs:restriction base="xs:string"><xs:maxLength value="4"/></xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="memberType">
    <xs:restriction base="t:headType"><xs:maxLength value="2"/></xs:restriction>
  </xs:simpleType>
  <xs:element name="head" type="t:headType"/>
  <xs:element name="member" type="t:memberType" substitutionGroup="t:head"/>
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element ref="t:head" maxOccurs="unbounded"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

describe("substitution groups — parse", () => {
  it("records the head qname on the member element declaration", async () => {
    let ir: ReturnType<typeof parseXsd> | undefined;
    await withTempDirAsync((dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, SIMPLE_HEAD_XSD);
      ir = parseXsd([file]);
    });
    expect(ir?.elements["{urn:sg}member"]?.substitutionGroup).toBe("{urn:sg}head");
    expect(ir?.elements["{urn:sg}head"]?.substitutionGroup).toBeUndefined();
  });
});

describe("substitution groups — round-trip", () => {
  it("accepts a member in place of the head and re-emits the member tag", async () => {
    const mod = await moduleFor({ "schema.xsd": SIMPLE_HEAD_XSD });
    const rootSchema = rootsByLocalName(mod).get("rootSchema") as z.ZodType;
    const data = parseXml(
      rootSchema,
      `<root xmlns="urn:sg"><head>abcd</head><member>ab</member></root>`,
    );
    expect(data).toEqual({ head: ["abcd", "ab"] });
    const serialized = serializeXml(rootSchema, data);
    expect(serialized).toContain(":head>");
    expect(serialized).toContain(":member>");
    expect(parseXml(rootSchema, serialized)).toEqual(data);
  });

  it("keeps member-only content of an extension member", async () => {
    const mod = await moduleFor({
      "schema.xsd": `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:pub" xmlns:t="urn:pub" elementFormDefault="qualified">
  <xs:complexType name="PublicationType">
    <xs:sequence><xs:element name="Title" type="xs:string"/></xs:sequence>
  </xs:complexType>
  <xs:complexType name="BookType">
    <xs:complexContent>
      <xs:extension base="t:PublicationType">
        <xs:sequence><xs:element name="Author" type="xs:string" maxOccurs="unbounded"/></xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
  <xs:element name="Publication" abstract="true" type="t:PublicationType"/>
  <xs:element name="Book" type="t:BookType" substitutionGroup="t:Publication"/>
  <xs:element name="BookStore">
    <xs:complexType>
      <xs:sequence><xs:element ref="t:Publication" maxOccurs="unbounded"/></xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`,
    });
    const rootSchema = rootsByLocalName(mod).get("BookStoreSchema") as z.ZodType;
    const xml = `<BookStore xmlns="urn:pub"><Book><Title>T</Title><Author>A</Author></Book></BookStore>`;
    const data = parseXml(rootSchema, xml);
    expect(data).toEqual({ Publication: [{ Title: "T", Author: ["A"] }] });
    const serialized = serializeXml(rootSchema, data);
    expect(serialized).toContain(":Book>");
    expect(serialized).toContain(":Author>");
    expect(parseXml(rootSchema, serialized)).toEqual(data);
  });

  it("matches mixed members of one repeated head field, preserving order", async () => {
    const mod = await moduleFor({
      "schema.xsd": `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:c" xmlns:t="urn:c" elementFormDefault="qualified">
  <xs:element name="comment" type="xs:string" abstract="true"/>
  <xs:element name="shipComment" type="xs:normalizedString" substitutionGroup="t:comment"/>
  <xs:element name="customerComment" type="xs:normalizedString" substitutionGroup="t:comment"/>
  <xs:element name="item">
    <xs:complexType>
      <xs:sequence><xs:element ref="t:comment" maxOccurs="2"/></xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`,
    });
    const rootSchema = rootsByLocalName(mod).get("itemSchema") as z.ZodType;
    const xml = `<item xmlns="urn:c"><shipComment>a</shipComment><customerComment>b</customerComment></item>`;
    const data = parseXml(rootSchema, xml);
    expect(data).toEqual({ comment: ["a", "b"] });
    const serialized = serializeXml(rootSchema, data);
    expect(serialized.indexOf("shipComment")).toBeLessThan(serialized.indexOf("customerComment"));
    expect(parseXml(rootSchema, serialized)).toEqual(data);
  });

  it("parses a substituted document root with the member's own root schema", async () => {
    const mod = await moduleFor({ "schema.xsd": SIMPLE_HEAD_XSD });
    const memberSchema = rootsByLocalName(mod).get("memberSchema") as z.ZodType;
    const data = parseXml(memberSchema, `<member xmlns="urn:sg">ab</member>`);
    expect(data).toBe("ab");
    expect(serializeXml(memberSchema, data)).toContain(":member");
  });

  it("accepts a member from a different namespace than the head", async () => {
    const mod = await moduleFor({
      "head.xsd": `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:head" xmlns:t="urn:head" elementFormDefault="qualified">
  <xs:import namespace="urn:other" schemaLocation="other.xsd"/>
  <xs:element name="first" type="xs:string"/>
  <xs:element name="doc">
    <xs:complexType>
      <xs:sequence><xs:element ref="t:first"/></xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`,
      "other.xsd": `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:other" xmlns:o="urn:other" xmlns:h="urn:head" elementFormDefault="qualified">
  <xs:import namespace="urn:head" schemaLocation="head.xsd"/>
  <xs:element name="salutation" type="xs:normalizedString" substitutionGroup="h:first"/>
</xs:schema>`,
    });
    const rootSchema = rootsByLocalName(mod).get("docSchema") as z.ZodType;
    const xml = `<doc xmlns="urn:head" xmlns:o="urn:other"><o:salutation>Mrs.</o:salutation></doc>`;
    const data = parseXml(rootSchema, xml);
    expect(data).toEqual({ first: "Mrs." });
    const serialized = serializeXml(rootSchema, data);
    expect(serialized).toContain("salutation");
    expect(serialized).toContain("urn:other");
    expect(parseXml(rootSchema, serialized)).toEqual(data);
  });
});
