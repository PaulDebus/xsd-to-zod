import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseXsd } from "../src/parseXsd.js";
import { parseXml, safeParseXml, serializeXml } from "../src/runtime.js";
import { findRootSchema, generateAndImport, onlyRootSchema, withTempDirAsync } from "./helpers.js";

// Identity constraints (xs:key / xs:keyref / xs:unique): enforced by the zod
// tier from 1.0, on by default, surfaced as ZodError issues.

const schemaFor = async (xsd: string, xml?: string): Promise<z.ZodType> => {
  let schema: z.ZodType | undefined;
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    const mod = await generateAndImport([file]);
    schema = xml === undefined ? onlyRootSchema(mod) : findRootSchema(mod, xml);
  });
  if (schema === undefined) {
    throw new Error("schema generation produced no root");
  }
  return schema;
};

const expectFailure = (result: { success: boolean; error?: unknown }): string => {
  expect(result.success).toBe(false);
  if (result.success) {
    return "";
  }
  return result.error instanceof z.ZodError
    ? result.error.issues.map((issue) => issue.message).join("\n")
    : String(result.error);
};

const UNIQUE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="catalog">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="item" maxOccurs="unbounded">
          <xs:complexType>
            <xs:attribute name="id" type="xs:int"/>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
    <xs:unique name="itemUnique">
      <xs:selector xpath="item"/>
      <xs:field xpath="@id"/>
    </xs:unique>
  </xs:element>
</xs:schema>`;

describe("identity constraints", () => {
  it("enforces xs:unique over attribute fields", async () => {
    const schema = await schemaFor(UNIQUE_XSD);
    expect(safeParseXml(schema, `<catalog><item id="1"/><item id="2"/></catalog>`).success).toBe(
      true,
    );
    const dup = safeParseXml(schema, `<catalog><item id="1"/><item id="1"/></catalog>`);
    expect(expectFailure(dup)).toContain('xs:unique "itemUnique"');
  });

  it("compares key values in the value space (1 equals 01 for xs:int)", async () => {
    const schema = await schemaFor(UNIQUE_XSD);
    const dup = safeParseXml(schema, `<catalog><item id="1"/><item id="01"/></catalog>`);
    expect(expectFailure(dup)).toContain("duplicate key value");
  });

  it("enforces xs:key field presence and uniqueness", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="catalog">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="item" maxOccurs="unbounded">
          <xs:complexType>
            <xs:attribute name="id" type="xs:string"/>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
    <xs:key name="itemKey">
      <xs:selector xpath="item"/>
      <xs:field xpath="@id"/>
    </xs:key>
  </xs:element>
</xs:schema>`);
    expect(safeParseXml(schema, `<catalog><item id="a"/><item id="b"/></catalog>`).success).toBe(
      true,
    );
    expect(
      expectFailure(safeParseXml(schema, `<catalog><item id="a"/><item/></catalog>`)),
    ).toContain('xs:key "itemKey"');
    expect(
      expectFailure(safeParseXml(schema, `<catalog><item id="a"/><item id="a"/></catalog>`)),
    ).toContain("duplicate key value");
  });

  it("scopes constraints per occurrence of the declaring element", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="library">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="shelf" maxOccurs="unbounded">
          <xs:complexType>
            <xs:sequence>
              <xs:element name="book" maxOccurs="unbounded">
                <xs:complexType>
                  <xs:attribute name="id" type="xs:string"/>
                </xs:complexType>
              </xs:element>
            </xs:sequence>
          </xs:complexType>
          <xs:unique name="bookUnique">
            <xs:selector xpath="book"/>
            <xs:field xpath="@id"/>
          </xs:unique>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`);
    // Same key value in two different shelf scopes: fine.
    expect(
      safeParseXml(
        schema,
        `<library><shelf><book id="a"/></shelf><shelf><book id="a"/></shelf></library>`,
      ).success,
    ).toBe(true);
    const dup = safeParseXml(
      schema,
      `<library><shelf><book id="a"/><book id="a"/></shelf></library>`,
    );
    expect(expectFailure(dup)).toContain('xs:unique "bookUnique"');
  });

  it("enforces xs:keyref against the referenced key's table", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="catalog">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="item" maxOccurs="unbounded">
          <xs:complexType>
            <xs:attribute name="id" type="xs:string"/>
          </xs:complexType>
        </xs:element>
        <xs:element name="order" maxOccurs="unbounded" minOccurs="0">
          <xs:complexType>
            <xs:attribute name="ref" type="xs:string"/>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
    <xs:key name="itemKey">
      <xs:selector xpath="item"/>
      <xs:field xpath="@id"/>
    </xs:key>
    <xs:keyref name="orderRef" refer="itemKey">
      <xs:selector xpath="order"/>
      <xs:field xpath="@ref"/>
    </xs:keyref>
  </xs:element>
</xs:schema>`);
    expect(safeParseXml(schema, `<catalog><item id="a"/><order ref="a"/></catalog>`).success).toBe(
      true,
    );
    const dangling = safeParseXml(schema, `<catalog><item id="a"/><order ref="b"/></catalog>`);
    expect(expectFailure(dangling)).toContain('xs:keyref "orderRef"');
    // A keyref node with an absent field is skipped, not rejected.
    expect(safeParseXml(schema, `<catalog><item id="a"/><order/></catalog>`).success).toBe(true);
  });

  it("supports descendant (.//) selectors and element field steps", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="group" maxOccurs="unbounded">
          <xs:complexType>
            <xs:sequence>
              <xs:element name="member" maxOccurs="unbounded">
                <xs:complexType>
                  <xs:sequence>
                    <xs:element name="id" type="xs:string"/>
                  </xs:sequence>
                </xs:complexType>
              </xs:element>
            </xs:sequence>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
    <xs:unique name="memberUnique">
      <xs:selector xpath=".//member"/>
      <xs:field xpath="id"/>
    </xs:unique>
  </xs:element>
</xs:schema>`);
    expect(
      safeParseXml(
        schema,
        `<root><group><member><id>a</id></member></group><group><member><id>b</id></member></group></root>`,
      ).success,
    ).toBe(true);
    const dup = safeParseXml(
      schema,
      `<root><group><member><id>a</id></member></group><group><member><id>a</id></member></group></root>`,
    );
    expect(expectFailure(dup)).toContain("duplicate key value");
  });

  it("resolves prefixed xpath steps against the schema's namespaces", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="catalog">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="item" maxOccurs="unbounded">
          <xs:complexType>
            <xs:attribute name="id" type="xs:string"/>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
    <xs:unique name="itemUnique">
      <xs:selector xpath="t:item"/>
      <xs:field xpath="@id"/>
    </xs:unique>
  </xs:element>
</xs:schema>`);
    const dup = safeParseXml(
      schema,
      `<t:catalog xmlns:t="urn:test"><t:item id="a"/><t:item id="a"/></t:catalog>`,
    );
    expect(expectFailure(dup)).toContain("duplicate key value");
  });

  it("resolves key fields through xsi:type derived variants", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="http://example.com/zoo" xmlns:tns="http://example.com/zoo" elementFormDefault="qualified">
  <xs:element name="kennel">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="pet" type="tns:Animal" maxOccurs="unbounded"/>
      </xs:sequence>
    </xs:complexType>
    <xs:key name="tagKey">
      <xs:selector xpath="tns:pet"/>
      <xs:field xpath="@tag"/>
    </xs:key>
  </xs:element>
  <xs:complexType name="Animal">
    <xs:sequence>
      <xs:element name="name" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
  <xs:complexType name="Dog">
    <xs:complexContent>
      <xs:extension base="tns:Animal">
        <xs:attribute name="tag" type="xs:string"/>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
</xs:schema>`);
    const open = `<kennel xmlns="http://example.com/zoo" xmlns:tns="http://example.com/zoo" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`;
    // The tag field exists only on the derived variant: finding it proves the
    // identity pass dispatched through the xsi:type discriminant.
    expect(
      safeParseXml(
        schema,
        `${open}<pet xsi:type="tns:Dog" tag="a"><name>Rex</name></pet><pet xsi:type="tns:Dog" tag="b"><name>Fido</name></pet></kennel>`,
      ).success,
    ).toBe(true);
    const dup = safeParseXml(
      schema,
      `${open}<pet xsi:type="tns:Dog" tag="a"><name>Rex</name></pet><pet xsi:type="tns:Dog" tag="a"><name>Fido</name></pet></kennel>`,
    );
    expect(expectFailure(dup)).toContain("duplicate key value");
  });

  it("treats nil field values as absent (key reports, unique skips)", async () => {
    const xsd = (constraint: string): string => `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="catalog">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="item" maxOccurs="unbounded">
          <xs:complexType>
            <xs:sequence>
              <xs:element name="code" type="xs:string" nillable="true"/>
            </xs:sequence>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
    ${constraint}
  </xs:element>
</xs:schema>`;
    const nilDoc = `<catalog><item><code>x</code></item><item><code xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true"/></item></catalog>`;
    const keySchema = await schemaFor(
      xsd(`<xs:key name="codeKey"><xs:selector xpath="item"/><xs:field xpath="code"/></xs:key>`),
    );
    expect(expectFailure(safeParseXml(keySchema, nilDoc))).toContain('xs:key "codeKey"');
    const uniqueSchema = await schemaFor(
      xsd(
        `<xs:unique name="codeUnique"><xs:selector xpath="item"/><xs:field xpath="code"/></xs:unique>`,
      ),
    );
    // A nil node contributes no tuple, so uniqueness has nothing to compare.
    expect(safeParseXml(uniqueSchema, nilDoc).success).toBe(true);
  });

  it("compares QName-typed keys by resolved namespace, not prefix", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="catalog">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="item" maxOccurs="unbounded">
          <xs:complexType>
            <xs:attribute name="ref" type="xs:QName"/>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
    <xs:unique name="refUnique">
      <xs:selector xpath="t:item"/>
      <xs:field xpath="@ref"/>
    </xs:unique>
  </xs:element>
</xs:schema>`);
    const open = `<t:catalog xmlns:t="urn:test" xmlns:p="urn:codes" xmlns:q="urn:codes">`;
    // p:widget and q:widget name the same QName under different prefixes.
    const dup = safeParseXml(
      schema,
      `${open}<t:item ref="p:widget"/><t:item ref="q:widget"/></t:catalog>`,
    );
    expect(expectFailure(dup)).toContain("duplicate key value");
    expect(
      safeParseXml(schema, `${open}<t:item ref="p:widget"/><t:item ref="p:gadget"/></t:catalog>`)
        .success,
    ).toBe(true);
  });

  it("round-trips constrained documents through serializeXml", async () => {
    const schema = await schemaFor(UNIQUE_XSD);
    const xml = `<catalog><item id="1"/><item id="2"/></catalog>`;
    const parsed = parseXml(schema, xml);
    // Serialization needs no identity index: it is parse-time only.
    const reserialized = serializeXml(schema, parsed);
    expect(safeParseXml(schema, reserialized).success).toBe(true);
    expect(parseXml(schema, reserialized)).toEqual(parsed);
  });

  it("skips the identity pass on the validate:false fast path", async () => {
    const schema = await schemaFor(UNIQUE_XSD);
    const dup = `<catalog><item id="1"/><item id="1"/></catalog>`;
    expect(safeParseXml(schema, dup).success).toBe(false);
    expect(safeParseXml(schema, dup, { validate: false }).success).toBe(true);
  });

  it("opts out of identity checks alone via identityConstraints:false", async () => {
    const schema = await schemaFor(UNIQUE_XSD);
    const dup = `<catalog><item id="1"/><item id="1"/></catalog>`;
    expect(safeParseXml(schema, dup, { identityConstraints: false }).success).toBe(true);
    // Structural validation still runs under the opt-out.
    expect(safeParseXml(schema, `<other/>`, { identityConstraints: false }).success).toBe(false);
  });

  it("surfaces violations from parseXml as a thrown ZodError", async () => {
    const schema = await schemaFor(UNIQUE_XSD);
    expect(() => parseXml(schema, `<catalog><item id="1"/><item id="1"/></catalog>`)).toThrow(
      /duplicate key value/,
    );
  });

  it("parses constraints into the IR instead of counting them as dropped", async () => {
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, UNIQUE_XSD);
      const ir = await parseXsd([file]);
      expect(ir.unenforcedConstructs.dropped).toEqual({});
      const root = ir.elements["{}catalog"];
      expect(root?.identityConstraints).toEqual([
        {
          kind: "unique",
          name: "{}itemUnique",
          selector: [{ descendant: false, steps: [{ axis: "child", qname: "{}item" }] }],
          fields: [[{ descendant: false, steps: [{ axis: "attribute", qname: "{}id" }] }]],
        },
      ]);
    });
  });

  it("drops constraints with xpaths outside the restricted subset, with a diagnostic", async () => {
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(
        file,
        `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="catalog">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="item" maxOccurs="unbounded" type="xs:string"/>
      </xs:sequence>
    </xs:complexType>
    <xs:key name="bad">
      <xs:selector xpath="item[1]"/>
      <xs:field xpath="."/>
    </xs:key>
    <xs:keyref name="dangling" refer="noSuchKey">
      <xs:selector xpath="item"/>
      <xs:field xpath="."/>
    </xs:keyref>
  </xs:element>
</xs:schema>`,
      );
      const ir = await parseXsd([file]);
      expect(ir.unenforcedConstructs.dropped).toEqual({ "xs:key": 1, "xs:keyref": 1 });
      expect(ir.diagnostics.map((d) => d.kind)).toEqual(
        expect.arrayContaining(["unsupported-identity-xpath", "unresolved-identity-ref"]),
      );
      // Dropped constraints never reach the IR.
      const root = ir.elements["{}catalog"];
      expect(root?.identityConstraints).toBeUndefined();
    });
  });

  it("enforces constraints inherited through a ref to a global element", async () => {
    const xml = `<book><chapter><section n="1"/><section n="1"/></chapter></book>`;
    const schema = await schemaFor(
      `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="chapter">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="section" maxOccurs="unbounded">
          <xs:complexType>
            <xs:attribute name="n" type="xs:int"/>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
    <xs:unique name="sectionUnique">
      <xs:selector xpath="section"/>
      <xs:field xpath="@n"/>
    </xs:unique>
  </xs:element>
  <xs:element name="book">
    <xs:complexType>
      <xs:sequence>
        <xs:element ref="chapter" maxOccurs="unbounded"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`,
      xml,
    );
    const dup = safeParseXml(
      schema,
      `<book><chapter><section n="1"/><section n="1"/></chapter></book>`,
    );
    expect(expectFailure(dup)).toContain("duplicate key value");
    expect(
      safeParseXml(
        schema,
        `<book><chapter><section n="1"/></chapter><chapter><section n="1"/></chapter></book>`,
      ).success,
    ).toBe(true);
  });

  it("compares open-content keys per their xsi:type datatype, not their lexical", async () => {
    const schema = await schemaFor(
      `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element ref="uid" maxOccurs="unbounded"/>
      </xs:sequence>
    </xs:complexType>
    <xs:unique name="uuid">
      <xs:selector xpath=".//uid"/>
      <xs:field xpath="."/>
    </xs:unique>
  </xs:element>
  <xs:element name="uid" type="xs:anyType"/>
</xs:schema>`,
      `<root><uid>1</uid></root>`,
    );
    const decl = `xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`;
    // Equal lexicals, different primitive types: not equal in the value space.
    expect(
      safeParseXml(
        schema,
        `<root ${decl}><uid xsi:type="xs:boolean">1</uid><uid xsi:type="xs:decimal">1</uid></root>`,
      ).success,
    ).toBe(true);
    // Same datatype, equal values: a genuine duplicate.
    const dup = safeParseXml(
      schema,
      `<root ${decl}><uid xsi:type="xs:string">1</uid><uid xsi:type="xs:string">1</uid></root>`,
    );
    expect(expectFailure(dup)).toContain('xs:unique "uuid"');
    // Same datatype, different lexicals, same value: still a duplicate.
    const lexDup = safeParseXml(
      schema,
      `<root ${decl}><uid xsi:type="xs:decimal">3.0</uid><uid xsi:type="xs:decimal">3.00</uid></root>`,
    );
    expect(expectFailure(lexDup)).toContain('xs:unique "uuid"');
  });

  it("compares xs:anySimpleType keys per their xsi:type datatype", async () => {
    const schema = await schemaFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence maxOccurs="unbounded">
        <xs:element name="number" type="xs:anySimpleType"/>
      </xs:sequence>
    </xs:complexType>
    <xs:unique name="uniq">
      <xs:selector xpath="./number"/>
      <xs:field xpath="."/>
    </xs:unique>
  </xs:element>
</xs:schema>`);
    const decl = `xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`;
    expect(
      safeParseXml(
        schema,
        `<root ${decl}><number xsi:type="xs:string">3.0</number><number xsi:type="xs:decimal">3.0</number></root>`,
      ).success,
    ).toBe(true);
    const dup = safeParseXml(
      schema,
      `<root ${decl}><number xsi:type="xs:decimal">3.0</number><number xsi:type="xs:decimal">3.0</number></root>`,
    );
    expect(expectFailure(dup)).toContain("duplicate key value");
    // Same datatype, different lexicals, same value: still a duplicate.
    const lexDup = safeParseXml(
      schema,
      `<root ${decl}><number xsi:type="xs:decimal">3.0</number><number xsi:type="xs:decimal">3.00</number></root>`,
    );
    expect(expectFailure(lexDup)).toContain("duplicate key value");
    // Round-trip: the serializer re-emits xsi:type so re-parse keeps the types.
    const parsed = parseXml(
      schema,
      `<root ${decl}><number xsi:type="xs:decimal">3.0</number></root>`,
    );
    const reserialized = serializeXml(schema, parsed);
    expect(reserialized).toContain("xsi:type");
    expect(safeParseXml(schema, reserialized).success).toBe(true);
  });

  it("evaluates attribute key fields of nil elements", async () => {
    const schema = await schemaFor(
      `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:choice maxOccurs="unbounded">
        <xs:element ref="row" maxOccurs="unbounded"/>
      </xs:choice>
    </xs:complexType>
    <xs:key name="rowKey">
      <xs:selector xpath=".//row"/>
      <xs:field xpath="@id"/>
    </xs:key>
  </xs:element>
  <xs:element name="row" nillable="true">
    <xs:complexType>
      <xs:simpleContent>
        <xs:extension base="xs:string">
          <xs:attribute name="id" type="xs:string"/>
        </xs:extension>
      </xs:simpleContent>
    </xs:complexType>
  </xs:element>
</xs:schema>`,
      `<root><row id="1"/></root>`,
    );
    const xsi = `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`;
    // xsi:nil empties the content, not the attributes: the key fields exist.
    expect(
      safeParseXml(
        schema,
        `<root ${xsi}><row id="1" xsi:nil="true"/><row id="2" xsi:nil="true"/></root>`,
      ).success,
    ).toBe(true);
    const dup = safeParseXml(
      schema,
      `<root ${xsi}><row id="1" xsi:nil="true"/><row id="1" xsi:nil="true"/></root>`,
    );
    expect(expectFailure(dup)).toContain("duplicate key value");
    // Round-trip: the serializer re-emits the nil attributes next to xsi:nil.
    const parsed = parseXml(schema, `<root ${xsi}><row id="1" xsi:nil="true"/></root>`);
    const reserialized = serializeXml(schema, parsed);
    expect(reserialized).toContain('id="1"');
    expect(reserialized).toContain("xsi:nil");
    expect(safeParseXml(schema, reserialized).success).toBe(true);
  });

  it("compares typed attribute key fields of nil elements in value space", async () => {
    const schema = await schemaFor(
      `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:choice maxOccurs="unbounded">
        <xs:element ref="row" maxOccurs="unbounded"/>
      </xs:choice>
    </xs:complexType>
    <xs:key name="rowKey">
      <xs:selector xpath=".//row"/>
      <xs:field xpath="@id"/>
    </xs:key>
  </xs:element>
  <xs:element name="row" nillable="true">
    <xs:complexType>
      <xs:simpleContent>
        <xs:extension base="xs:string">
          <xs:attribute name="id" type="xs:int"/>
        </xs:extension>
      </xs:simpleContent>
    </xs:complexType>
  </xs:element>
</xs:schema>`,
      `<root><row id="1"/></root>`,
    );
    const xsi = `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`;
    expect(
      safeParseXml(
        schema,
        `<root ${xsi}><row id="1" xsi:nil="true"/><row id="2" xsi:nil="true"/></root>`,
      ).success,
    ).toBe(true);
    // Same value, different lexicals: still a duplicate.
    const dup = safeParseXml(
      schema,
      `<root ${xsi}><row id="01" xsi:nil="true"/><row id="1" xsi:nil="true"/></root>`,
    );
    expect(expectFailure(dup)).toContain("duplicate key value");
  });
});
