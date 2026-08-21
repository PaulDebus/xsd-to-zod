import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { irToZod, parseXml, parseXsd, serializeXml } from "../src/index.js";
import { generateAndImport, withTempDirAsync } from "./helpers.js";

// xsi:type / derived-type polymorphism: a slot whose declared complex type is
// abstract or has known derived types is emitted as a discriminated union over
// the base and derived variants, keyed on a synthetic xsiType property holding
// the type's Clark qname. The parser reads xsi:type into that discriminant;
// the serializer turns it back into the xsi:type attribute.

const ZOO_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="http://example.com/zoo" xmlns:tns="http://example.com/zoo" elementFormDefault="qualified">
  <xs:element name="pet" type="tns:Animal"/>
  <xs:complexType name="Animal">
    <xs:sequence>
      <xs:element name="name" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
  <xs:complexType name="Dog">
    <xs:complexContent>
      <xs:extension base="tns:Animal">
        <xs:sequence>
          <xs:element name="breed" type="xs:string"/>
        </xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
</xs:schema>`;

// Repeated polymorphic slot plus a mid-chain derivation (Poodle extends Dog).
const KENNEL_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="http://example.com/zoo" xmlns:tns="http://example.com/zoo" elementFormDefault="qualified">
  <xs:element name="kennel" type="tns:Kennel"/>
  <xs:complexType name="Kennel">
    <xs:sequence>
      <xs:element name="pet" type="tns:Animal" maxOccurs="unbounded"/>
    </xs:sequence>
  </xs:complexType>
  <xs:complexType name="Animal">
    <xs:sequence>
      <xs:element name="name" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
  <xs:complexType name="Dog">
    <xs:complexContent>
      <xs:extension base="tns:Animal">
        <xs:sequence>
          <xs:element name="breed" type="xs:string"/>
        </xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
  <xs:complexType name="Poodle">
    <xs:complexContent>
      <xs:extension base="tns:Dog">
        <xs:sequence>
          <xs:element name="toy" type="xs:string"/>
        </xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
</xs:schema>`;

const ABSTRACT_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="http://example.com/shapes" xmlns:tns="http://example.com/shapes" elementFormDefault="qualified">
  <xs:element name="shape" type="tns:Shape"/>
  <xs:complexType name="Shape" abstract="true">
    <xs:sequence>
      <xs:element name="label" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
  <xs:complexType name="Circle">
    <xs:complexContent>
      <xs:extension base="tns:Shape">
        <xs:sequence>
          <xs:element name="radius" type="xs:int"/>
        </xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
</xs:schema>`;

const moduleFor = async (xsd: string): Promise<Record<string, unknown>> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    mod = await generateAndImport([file]);
  });
  return mod;
};

const XSI = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
const DOG_XML = `<pet xmlns="http://example.com/zoo" xmlns:zoo="http://example.com/zoo" ${XSI} xsi:type="zoo:Dog"><name>Rex</name><breed>Collie</breed></pet>`;
const PLAIN_XML = `<pet xmlns="http://example.com/zoo"><name>Fido</name></pet>`;

describe("xsi:type polymorphism — codegen", () => {
  it("emits a discriminated union over the base and derived variants", async () => {
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, ZOO_XSD);
      const { schemas } = irToZod(parseXsd([file]));

      // One union over base + derived, discriminating on xsiType.
      expect(schemas).toContain(
        'z.discriminatedUnion("xsiType", [AnimalVariantSchema, DogVariantSchema]',
      );
      // Discriminant literals are the types' Clark qnames: optional on the
      // base variant, defaulted on the derived variant.
      expect(schemas).toContain(
        '"xsiType": z.literal("{http://example.com/zoo}Animal").optional()',
      );
      expect(schemas).toContain(
        '"xsiType": z.literal("{http://example.com/zoo}Dog").default("{http://example.com/zoo}Dog")',
      );
      // The root element wraps the union.
      expect(schemas).toContain("export const petSchema = z.lazy(() => AnimalVariantsSchema)");
    });
  });

  it("leaves schema sets without derivation byte-identical (no xsiType emission)", async () => {
    await withTempDirAsync(async (dir) => {
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:plain" elementFormDefault="qualified">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence><xs:element name="item" type="xs:string"/></xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, xsd);
      const { schemas } = irToZod(parseXsd([file]));
      expect(schemas).not.toContain("xsiType");
      expect(schemas).not.toContain("discriminatedUnion");
    });
  });
});

describe("xsi:type polymorphism — parse", () => {
  it("parses an xsi:type instance as the derived type, retaining derived fields", async () => {
    const mod = await moduleFor(ZOO_XSD);
    const petSchema = mod["petSchema"] as z.ZodType;
    expect(parseXml(petSchema, DOG_XML)).toEqual({
      name: "Rex",
      breed: "Collie",
      xsiType: "{http://example.com/zoo}Dog",
    });
  });

  it("parses a plain instance exactly as before (no discriminant)", async () => {
    const mod = await moduleFor(ZOO_XSD);
    const petSchema = mod["petSchema"] as z.ZodType;
    expect(parseXml(petSchema, PLAIN_XML)).toEqual({ name: "Fido" });
  });

  it("falls back to declared-type parsing for an unknown xsi:type", async () => {
    const mod = await moduleFor(ZOO_XSD);
    const petSchema = mod["petSchema"] as z.ZodType;
    const xml = `<pet xmlns="http://example.com/zoo" xmlns:zoo="http://example.com/zoo" ${XSI} xsi:type="zoo:Cat"><name>Tom</name><lives>9</lives></pet>`;
    expect(parseXml(petSchema, xml)).toEqual({ name: "Tom" });
  });

  // An unprefixed xsi:type value resolves through the default namespace; with
  // none in scope that is the empty namespace (Clark `{}local`), not "absent".
  it("resolves an unprefixed xsi:type value with no default namespace to the empty namespace", async () => {
    const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root" type="foo"/>
  <xs:complexType abstract="true" name="foo"/>
  <xs:complexType name="fixedType">
    <xs:complexContent>
      <xs:restriction base="foo"/>
    </xs:complexContent>
  </xs:complexType>
</xs:schema>`;
    const mod = await moduleFor(xsd);
    const rootSchema = mod["rootSchema"] as z.ZodType;
    const parsed = parseXml(rootSchema, `<root ${XSI} xsi:type="fixedType"/>`);
    expect(parsed).toEqual({ xsiType: "{}fixedType" });
    expect(serializeXml(rootSchema, parsed)).toContain('xsi:type="fixedType"');
  });

  it("dispatches per occurrence in repeated slots", async () => {
    const mod = await moduleFor(KENNEL_XSD);
    const kennelSchema = mod["kennelSchema"] as z.ZodType;
    const xml = `<kennel xmlns="http://example.com/zoo" xmlns:zoo="http://example.com/zoo" ${XSI}>
      <pet><name>Fido</name></pet>
      <pet xsi:type="zoo:Dog"><name>Rex</name><breed>Collie</breed></pet>
      <pet xsi:type="zoo:Poodle"><name>Bella</name><breed>Poodle</breed><toy>ball</toy></pet>
    </kennel>`;
    expect(parseXml(kennelSchema, xml)).toEqual({
      pet: [
        { name: "Fido" },
        { name: "Rex", breed: "Collie", xsiType: "{http://example.com/zoo}Dog" },
        {
          name: "Bella",
          breed: "Poodle",
          toy: "ball",
          xsiType: "{http://example.com/zoo}Poodle",
        },
      ],
    });
  });

  // The parser yields an empty element as a bare string; a polymorphic slot
  // must still read it as an (empty) object of the declared type.
  it("parses an empty element at a polymorphic slot as the declared type", async () => {
    const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" elementFormDefault="qualified" xmlns:t="urn:e">
  <xs:complexType name="One">
    <xs:sequence><xs:element name="item" minOccurs="0"/></xs:sequence>
  </xs:complexType>
  <xs:complexType name="Two">
    <xs:complexContent>
      <xs:restriction base="One">
        <xs:sequence><xs:element name="item" minOccurs="0" maxOccurs="0"/></xs:sequence>
      </xs:restriction>
    </xs:complexContent>
  </xs:complexType>
  <xs:element name="doc">
    <xs:complexType>
      <xs:sequence><xs:element name="e" type="Two"/></xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;
    const mod = await moduleFor(xsd);
    const docSchema = mod["docSchema"] as z.ZodType;
    expect(parseXml(docSchema, "<doc><e /></doc>")).toEqual({ e: {} });
  });

  it("parses xsi:type at a slot whose declared type is abstract", async () => {
    const mod = await moduleFor(ABSTRACT_XSD);
    const shapeSchema = mod["shapeSchema"] as z.ZodType;
    const xml = `<shape xmlns="http://example.com/shapes" xmlns:s="http://example.com/shapes" ${XSI} xsi:type="s:Circle"><label>Sun</label><radius>5</radius></shape>`;
    expect(parseXml(shapeSchema, xml)).toEqual({
      label: "Sun",
      radius: 5,
      xsiType: "{http://example.com/shapes}Circle",
    });
    // The abstract base itself remains parseable in this lenient tier.
    expect(
      parseXml(shapeSchema, '<shape xmlns="http://example.com/shapes"><label>x</label></shape>'),
    ).toEqual({ label: "x" });
  });
});

describe("xsi:type polymorphism — serialize", () => {
  it("round-trips an xsi:type instance", async () => {
    const mod = await moduleFor(ZOO_XSD);
    const petSchema = mod["petSchema"] as z.ZodType;
    const parsed = parseXml(petSchema, DOG_XML);
    const serialized = serializeXml(petSchema, parsed);
    expect(serialized).toContain('xsi:type="ns0:Dog"');
    expect(serialized).toContain('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
    expect(serialized).toContain("<ns0:breed>Collie</ns0:breed>");
    // The synthetic discriminant never leaks as element or attribute content.
    expect(serialized).not.toContain("xsiType");
    expect(parseXml(petSchema, serialized)).toEqual(parsed);
  });

  it("serializes a plain instance exactly as before (no xsi:type)", async () => {
    const mod = await moduleFor(ZOO_XSD);
    const petSchema = mod["petSchema"] as z.ZodType;
    const parsed = parseXml(petSchema, PLAIN_XML);
    const serialized = serializeXml(petSchema, parsed);
    expect(serialized).not.toContain("xsi:type");
    expect(parseXml(petSchema, serialized)).toEqual({ name: "Fido" });
  });

  it("serializes a hand-built derived value with the xsi:type attribute", async () => {
    const mod = await moduleFor(ZOO_XSD);
    const petSchema = mod["petSchema"] as z.ZodType;
    const value = {
      name: "Rex",
      breed: "Collie",
      xsiType: "{http://example.com/zoo}Dog",
    };
    const serialized = serializeXml(petSchema, value);
    expect(serialized).toContain('xsi:type="ns0:Dog"');
    expect(parseXml(petSchema, serialized)).toEqual(value);
  });

  it("omits the xsi:type attribute when the discriminant matches the declared type", async () => {
    const mod = await moduleFor(ZOO_XSD);
    const petSchema = mod["petSchema"] as z.ZodType;
    const serialized = serializeXml(petSchema, {
      name: "Fido",
      xsiType: "{http://example.com/zoo}Animal",
    });
    expect(serialized).not.toContain("xsi:type");
    expect(parseXml(petSchema, serialized)).toEqual({ name: "Fido" });
  });

  it("round-trips mixed occurrences in a repeated slot in document order", async () => {
    const mod = await moduleFor(KENNEL_XSD);
    const kennelSchema = mod["kennelSchema"] as z.ZodType;
    const xml = `<kennel xmlns="http://example.com/zoo" xmlns:zoo="http://example.com/zoo" ${XSI}>
      <pet xsi:type="zoo:Poodle"><name>Bella</name><breed>Poodle</breed><toy>ball</toy></pet>
      <pet><name>Fido</name></pet>
      <pet xsi:type="zoo:Dog"><name>Rex</name><breed>Collie</breed></pet>
    </kennel>`;
    const parsed = parseXml(kennelSchema, xml);
    const serialized = serializeXml(kennelSchema, parsed);
    expect(parseXml(kennelSchema, serialized)).toEqual(parsed);
    // Occurrence order (Poodle, plain, Dog) is preserved.
    expect(serialized.indexOf("Bella")).toBeLessThan(serialized.indexOf("Fido"));
    expect(serialized.indexOf("Fido")).toBeLessThan(serialized.indexOf("Rex"));
  });
});

describe("xsi:type polymorphism — unknown xsi:type capture (open world)", () => {
  // xsi:type names a QName outside the generated union (Cat is not in the
  // zoo schema set). The occurrence parses with the declared variant; the
  // original xsi:type, the extra child elements and the undeclared attributes
  // are captured in an opaque side channel (never in the typed value) and
  // re-attached on serialize.
  const CAT_XML = `<pet xmlns="http://example.com/zoo" xmlns:zoo="http://example.com/zoo" ${XSI} xsi:type="zoo:Cat" lives="9"><color>tabby</color><name>Tom</name><toy kind="ball">yarn</toy></pet>`;

  it("parses with the declared variant; extras stay out of the typed value", async () => {
    const mod = await moduleFor(ZOO_XSD);
    const petSchema = mod["petSchema"] as z.ZodType;
    expect(parseXml(petSchema, CAT_XML)).toEqual({ name: "Tom" });
  });

  it("re-serializes losslessly: xsi:type, undeclared attributes and extras in document order", async () => {
    const mod = await moduleFor(ZOO_XSD);
    const petSchema = mod["petSchema"] as z.ZodType;
    const serialized = serializeXml(petSchema, parseXml(petSchema, CAT_XML));
    expect(serialized).toContain('xsi:type="ns0:Cat"');
    expect(serialized).toContain('lives="9"');
    // Extras keep their positions relative to the declared content: <color>
    // before <name>, <toy> after — and the extra's own attribute survives.
    expect(serialized.indexOf(">tabby<")).toBeLessThan(serialized.indexOf(">Tom<"));
    expect(serialized.indexOf(">Tom<")).toBeLessThan(serialized.indexOf('kind="ball"'));
    // Byte-stable under a second round-trip.
    expect(serializeXml(petSchema, parseXml(petSchema, serialized))).toBe(serialized);
  });

  it("round-trips unknown-xsi:type occurrences in repeated slots", async () => {
    const mod = await moduleFor(KENNEL_XSD);
    const kennelSchema = mod["kennelSchema"] as z.ZodType;
    const xml = `<kennel xmlns="http://example.com/zoo" xmlns:zoo="http://example.com/zoo" ${XSI}>
      <pet xsi:type="zoo:Cat"><name>Tom</name><lives>9</lives></pet>
      <pet><name>Fido</name></pet>
      <pet xsi:type="zoo:Dog"><name>Rex</name><breed>Collie</breed></pet>
    </kennel>`;
    const parsed = parseXml(kennelSchema, xml);
    expect(parsed).toEqual({
      pet: [
        { name: "Tom" },
        { name: "Fido" },
        { name: "Rex", breed: "Collie", xsiType: "{http://example.com/zoo}Dog" },
      ],
    });
    const serialized = serializeXml(kennelSchema, parsed);
    expect(serialized).toContain('xsi:type="ns0:Cat"');
    expect(serialized).toContain("<ns0:lives>9</ns0:lives>");
    expect(serializeXml(kennelSchema, parseXml(kennelSchema, serialized))).toBe(serialized);
  });

  it("survives mutation: extras append after the declared content, xsi:type is kept", async () => {
    const mod = await moduleFor(ZOO_XSD);
    const petSchema = mod["petSchema"] as z.ZodType;
    const parsed = parseXml(petSchema, CAT_XML) as Record<string, unknown>;
    // Mutate the parsed value so the recorded order no longer matches.
    parsed["name"] = "Changed";
    delete parsed["name"];
    const serialized = serializeXml(petSchema, parsed as never);
    expect(serialized).toContain('xsi:type="ns0:Cat"');
    expect(serialized).toContain(">tabby<");
    expect(serialized).toContain('kind="ball"');
  });

  it("keeps only the xsi:type when the declared variant has a wildcard (extras ride the open shape)", async () => {
    const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:w" xmlns:t="urn:w" elementFormDefault="qualified">
  <xs:element name="box" type="t:Box"/>
  <xs:complexType name="Box">
    <xs:sequence>
      <xs:element name="label" type="xs:string"/>
      <xs:any minOccurs="0" maxOccurs="unbounded"/>
    </xs:sequence>
  </xs:complexType>
  <xs:complexType name="Crate">
    <xs:complexContent>
      <xs:extension base="t:Box">
        <xs:sequence><xs:element name="weight" type="xs:int"/></xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
</xs:schema>`;
    const mod = await moduleFor(xsd);
    const boxSchema = mod["boxSchema"] as z.ZodType;
    const xml = `<box xmlns="urn:w" xmlns:t="urn:w" ${XSI} xsi:type="t:Chest"><label>L</label><weight>3</weight></box>`;
    const parsed = parseXml(boxSchema, xml);
    // The wildcard sweep captured the extra element into the typed open shape.
    expect(parsed).toEqual({ label: "L", "{urn:w}weight": "3" });
    const serialized = serializeXml(boxSchema, parsed);
    expect(serialized).toContain('xsi:type="ns0:Chest"');
    expect(serialized).toContain("<ns0:weight>3</ns0:weight>");
    expect(serializeXml(boxSchema, parseXml(boxSchema, serialized))).toBe(serialized);
  });
});

describe("substitution groups × xsi:type", () => {
  // A substitution-group head whose type also has derived types. The slot
  // keeps tag-based member dispatch (the substitution union); the xsi:type
  // discriminated union is emitted only where no substitution members exist —
  // here: at the head's root element. The two mechanisms are not combined at
  // a substitution slot: the element tag decides.
  const SUBST_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:sgx" xmlns:t="urn:sgx" elementFormDefault="qualified">
  <xs:complexType name="PublicationType">
    <xs:sequence><xs:element name="Title" type="xs:string"/></xs:sequence>
  </xs:complexType>
  <xs:complexType name="BookType">
    <xs:complexContent>
      <xs:extension base="t:PublicationType">
        <xs:sequence><xs:element name="Author" type="xs:string"/></xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
  <xs:element name="Publication" type="t:PublicationType"/>
  <xs:element name="Book" substitutionGroup="t:Publication" type="t:BookType"/>
  <xs:element name="Library">
    <xs:complexType>
      <xs:sequence><xs:element ref="t:Publication" maxOccurs="unbounded"/></xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;
  const LIBRARY_OPEN = `<Library xmlns="urn:sgx" xmlns:t="urn:sgx" ${XSI}>`;

  it("member-element substitution still dispatches on the tag", async () => {
    const mod = await moduleFor(SUBST_XSD);
    const librarySchema = mod["LibrarySchema"] as z.ZodType;
    const xml = `${LIBRARY_OPEN}<Book><Title>T</Title><Author>A</Author></Book><Publication><Title>P</Title></Publication></Library>`;
    const parsed = parseXml(librarySchema, xml);
    expect(parsed).toEqual({ Publication: [{ Title: "T", Author: "A" }, { Title: "P" }] });
    const serialized = serializeXml(librarySchema, parsed);
    expect(serialized).toContain("<ns0:Book>");
    expect(parseXml(librarySchema, serialized)).toEqual(parsed);
  });

  it("dispatches the xsi:type union at the head's root element", async () => {
    const mod = await moduleFor(SUBST_XSD);
    const publicationSchema = mod["PublicationSchema"] as z.ZodType;
    const xml = `<Publication xmlns="urn:sgx" xmlns:t="urn:sgx" ${XSI} xsi:type="t:BookType"><Title>T</Title><Author>A</Author></Publication>`;
    const parsed = parseXml(publicationSchema, xml);
    expect(parsed).toEqual({ Title: "T", Author: "A", xsiType: "{urn:sgx}BookType" });
    const serialized = serializeXml(publicationSchema, parsed);
    expect(serialized).toContain('xsi:type="ns0:BookType"');
    expect(parseXml(publicationSchema, serialized)).toEqual(parsed);
  });

  it("at a substitution slot the tag wins over xsi:type (pinned: xsi:type is ignored there)", async () => {
    const mod = await moduleFor(SUBST_XSD);
    const librarySchema = mod["LibrarySchema"] as z.ZodType;
    // Head tag carrying xsi:type naming the derived type: the substitution
    // union matches the head tag, so the occurrence is read with the head's
    // declared type and xsi:type is dropped — the mechanisms are deliberately
    // not combined, so this round-trip is lossy by design.
    const xml = `${LIBRARY_OPEN}<Publication xsi:type="t:BookType"><Title>T</Title><Author>A</Author></Publication></Library>`;
    const parsed = parseXml(librarySchema, xml);
    expect(parsed).toEqual({ Publication: [{ Title: "T" }] });
    const serialized = serializeXml(librarySchema, parsed);
    expect(serialized).not.toContain("xsi:type");
    expect(serialized).toContain("<ns0:Publication>");
  });

  it("a member element carrying xsi:type dispatches on the member and parses per the member's type", async () => {
    const mod = await moduleFor(SUBST_XSD);
    const librarySchema = mod["LibrarySchema"] as z.ZodType;
    // xsi:type matches the member's own declared type: content is read per
    // BookType and the attribute is omitted on re-serialization (same rule as
    // xsi:type matching a declared type at a polymorphic slot).
    const xml = `${LIBRARY_OPEN}<Book xsi:type="t:BookType"><Title>T</Title><Author>A</Author></Book></Library>`;
    const parsed = parseXml(librarySchema, xml);
    expect(parsed).toEqual({ Publication: [{ Title: "T", Author: "A" }] });
    const serialized = serializeXml(librarySchema, parsed);
    expect(serialized).toContain("<ns0:Book>");
    expect(serialized).not.toContain("xsi:type");
    expect(parseXml(librarySchema, serialized)).toEqual(parsed);
  });
});
