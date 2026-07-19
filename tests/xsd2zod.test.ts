import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { irToZod, parseXsd, parseXml, serializeXml, xmlRegistry } from '../src/index.js';
import { importGeneratedSchemas, withTempDir, withTempDirAsync } from './helpers.js';

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:complexType name="OrderType">
    <xs:sequence>
      <xs:element name="item" type="xs:string" minOccurs="0" maxOccurs="3"/>
      <xs:choice minOccurs="0">
        <xs:element name="sku" type="xs:string"/>
        <xs:element name="ean" type="xs:string"/>
      </xs:choice>
      <xs:element name="approved" type="xs:boolean" minOccurs="0"/>
      <xs:element name="note" type="xs:string" minOccurs="0" nillable="true"/>
    </xs:sequence>
    <xs:attribute name="item" type="xs:string"/>
  </xs:complexType>

  <xs:complexType name="PriceType">
    <xs:simpleContent>
      <xs:extension base="xs:decimal">
        <xs:attribute name="currency" type="xs:string" use="required"/>
      </xs:extension>
    </xs:simpleContent>
  </xs:complexType>

  <xs:element name="order" type="t:OrderType"/>
  <xs:element name="price" type="t:PriceType"/>
</xs:schema>`;

const EXTENSION_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:complexType name="C">
    <xs:sequence>
      <xs:element name="cField" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
  <xs:complexType name="B">
    <xs:complexContent>
      <xs:extension base="t:C">
        <xs:sequence>
          <xs:element name="bField" type="xs:string"/>
        </xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
  <xs:complexType name="A">
    <xs:complexContent>
      <xs:extension base="t:B">
        <xs:sequence>
          <xs:element name="aField" type="xs:string"/>
        </xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
</xs:schema>`;

// Generate code for an inline XSD and import it as a module (the generated
// 'xsd2zod' self-reference resolves via the package dotdir).
const importFromXsd = async (xsd: string): Promise<Record<string, unknown>> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, 'schema.xsd');
    fs.writeFileSync(file, xsd);
    mod = await importGeneratedSchemas(irToZod(parseXsd([file])).schemas);
  });
  return mod;
};

describe('xsd2zod v1 pipeline', () => {
  it('supports array cardinality, collisions, choice, and nillable handling', async () => {
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, 'schema.xsd');
      fs.writeFileSync(file, XSD);

      const ir = parseXsd([file]);
      const generated = irToZod(ir);
      expect(generated.schemas).toContain('"note": z.string().nullable().optional()');
      expect(generated.schemas).toContain('"approved": z.boolean().optional()');
      // Choice: no __choice marker anymore — branch fields become optional and
      // mutual exclusion is a refine on the object schema (#73).
      expect(generated.schemas).toContain('"sku": z.string().optional()');
      expect(generated.schemas).toContain('"ean": z.string().optional()');
      expect(generated.schemas).toContain('{ message: "choice allows at most one of: sku, ean" }');
      expect(generated.schemas).not.toContain('__choice');

      const orderType = ir.complexTypes['{urn:test}OrderType'];
      expect(orderType).toBeDefined();
      expect(orderType.fields.find((field) => field.qname === '{urn:test}sku')?.minOccurs).toBe(0);
      expect(orderType.fields.find((field) => field.qname === '{}item')?.kind).toBe('attribute');

      const mod = await importGeneratedSchemas(generated.schemas);
      const orderSchema = mod.orderSchema as z.ZodType;
      expect(xmlRegistry.get(orderSchema)?.root).toBe('{urn:test}order');

      const xml = `<order xmlns="urn:test" item="shadow"><item>one</item><sku>A1</sku><approved>1</approved><note xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true"/></order>`;
      const parsed = parseXml(orderSchema, xml) as Record<string, unknown>;

      expect(parsed['@item']).toBe('shadow');
      expect(parsed.item).toEqual(['one']);
      expect(parsed.sku).toBe('A1');
      expect(parsed.approved).toBe(true);
      expect(parsed.note).toBeNull();

      const serialized = serializeXml(orderSchema, parsed);
      expect(serialized).toContain('xsi:nil="true"');
      expect(serialized).toContain('<ns0:sku>A1</ns0:sku>');

      // Both choice branches present: the refine rejects with a ZodError.
      expect(() => parseXml(orderSchema, '<order xmlns="urn:test"><sku>A</sku><ean>B</ean></order>'))
        .toThrow('choice allows at most one of: sku, ean');
    });
  });

  it('does not treat non-xsi nil as xsi:nil and matches root namespace', async () => {
    const mod = await importFromXsd(XSD);
    const orderSchema = mod.orderSchema as z.ZodType;
    const parsed = parseXml(orderSchema, '<order xmlns="urn:test"><note nil="true">kept</note><approved>0</approved></order>') as Record<string, unknown>;
    expect(parsed.note).toBe('kept');
    expect(parsed.approved).toBe(false);

    expect(() => parseXml(orderSchema, '<order xmlns="urn:other"><note>bad</note></order>')).toThrow(
      "Root element '{urn:test}order' not found in XML payload"
    );
  });

  it('supports simpleContent with attributes and text value', async () => {
    const mod = await importFromXsd(XSD);
    const parsed = parseXml(mod.priceSchema as z.ZodType, '<price xmlns="urn:test" currency="USD">42</price>') as Record<string, unknown>;

    expect(parsed._text).toBe(42);
    expect(parsed['@currency']).toBe('USD');
  });

  it('flattens multi-level complex type extension chains', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'schema.xsd');
      fs.writeFileSync(file, EXTENSION_XSD);

      const ir = parseXsd([file]);
      const aFields = ir.complexTypes['{urn:test}A']?.fields.map((field) => field.qname);
      expect(aFields).toEqual(['{urn:test}cField', '{urn:test}bField', '{urn:test}aField']);
    });
  });

  it('inherits base-type fields for anonymous inline complexType extensions (#76)', () => {
    const INLINE_EXT_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:inline-ext" xmlns:t="urn:inline-ext" elementFormDefault="qualified">
  <xs:complexType name="Base">
    <xs:sequence>
      <xs:element name="id" type="xs:string"/>
    </xs:sequence>
    <xs:attribute name="version" type="xs:string"/>
  </xs:complexType>
  <xs:element name="doc">
    <xs:complexType>
      <xs:complexContent>
        <xs:extension base="t:Base">
          <xs:sequence>
            <xs:element name="title" type="xs:string"/>
          </xs:sequence>
        </xs:extension>
      </xs:complexContent>
    </xs:complexType>
  </xs:element>
  <xs:complexType name="Wrapper">
    <xs:sequence>
      <xs:element name="item">
        <xs:complexType>
          <xs:complexContent>
            <xs:extension base="t:Base">
              <xs:sequence>
                <xs:element name="extra" type="xs:string"/>
              </xs:sequence>
            </xs:extension>
          </xs:complexContent>
        </xs:complexType>
      </xs:element>
    </xs:sequence>
  </xs:complexType>
</xs:schema>`;

    withTempDir((dir) => {
      const file = path.join(dir, 'schema.xsd');
      fs.writeFileSync(file, INLINE_EXT_XSD);

      const ir = parseXsd([file]);

      // Top-level element with inline type extending a named base
      const docType = ir.complexTypes['{urn:inline-ext}anonymous_doc_Type'];
      expect(docType).toBeDefined();
      expect(docType.baseType).toBe('{urn:inline-ext}Base');
      expect(docType.fields.map((f) => f.qname)).toEqual([
        '{urn:inline-ext}id',
        '{}version',
        '{urn:inline-ext}title',
      ]);

      // Nested inline type (deferredSyntheticTypes path)
      const wrapper = ir.complexTypes['{urn:inline-ext}Wrapper'];
      const itemField = wrapper.fields.find((f) => f.qname === '{urn:inline-ext}item');
      expect(itemField).toBeDefined();
      const itemType = ir.complexTypes[itemField!.typeName];
      expect(itemType).toBeDefined();
      expect(itemType.baseType).toBe('{urn:inline-ext}Base');
      expect(itemType.fields.map((f) => f.qname)).toEqual([
        '{urn:inline-ext}id',
        '{}version',
        '{urn:inline-ext}extra',
      ]);
    });
  });

  it('resolves cross-file refs regardless of CLI argument order and types attribute refs from global declarations (#77)', () => {
    const DECLARES_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:declares" xmlns:d="urn:declares" elementFormDefault="qualified">
  <xs:element name="shared" type="xs:string"/>
  <xs:attribute name="code" type="xs:int"/>
  <xs:group name="G">
    <xs:sequence>
      <xs:element name="grouped" type="xs:boolean"/>
    </xs:sequence>
  </xs:group>
  <xs:attributeGroup name="AG">
    <xs:attribute name="agAttr" type="xs:boolean"/>
  </xs:attributeGroup>
</xs:schema>`;

    const USES_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:uses" xmlns:d="urn:declares" elementFormDefault="qualified">
  <xs:complexType name="Holder">
    <xs:sequence>
      <xs:element ref="d:shared"/>
      <xs:group ref="d:G"/>
      <xs:element name="own" type="xs:int"/>
    </xs:sequence>
    <xs:attribute ref="d:code"/>
    <xs:attributeGroup ref="d:AG"/>
  </xs:complexType>
  <xs:element name="holder" type="Holder"/>
</xs:schema>`;

    withTempDir((dir) => {
      const declares = path.join(dir, 'declares.xsd');
      const uses = path.join(dir, 'uses.xsd');
      fs.writeFileSync(declares, DECLARES_XSD);
      fs.writeFileSync(uses, USES_XSD);

      // The two files have no import/include edge, so they used to be processed
      // in argument order — refs from the first file were silently dropped.
      for (const order of [[uses, declares], [declares, uses]]) {
        const ir = parseXsd(order);
        expect(ir.unresolvedRefs).toEqual([]);

        const holder = ir.complexTypes['{urn:uses}Holder'];
        expect(holder).toBeDefined();

        const shared = holder.fields.find((f) => f.qname === '{urn:declares}shared');
        expect(shared).toBeDefined();
        expect(shared?.typeName).toBe('{http://www.w3.org/2001/XMLSchema}string');

        const grouped = holder.fields.find((f) => f.qname.endsWith('}grouped'));
        expect(grouped).toBeDefined();
        expect(grouped?.typeName).toBe('{http://www.w3.org/2001/XMLSchema}boolean');

        // Attribute refs resolve their type from the referenced global
        // declaration instead of hardcoded xs:string.
        const code = holder.fields.find((f) => f.qname === '{urn:declares}code');
        expect(code).toBeDefined();
        expect(code?.typeName).toBe('{http://www.w3.org/2001/XMLSchema}int');

        const agAttr = holder.fields.find((f) => f.qname.endsWith('}agAttr'));
        expect(agAttr).toBeDefined();
        expect(agAttr?.kind).toBe('attribute');
      }
    });
  });

  it('reports unresolved references and unknown prefixes instead of silently dropping them (#77)', () => {
    const BROKEN_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:broken" xmlns:b="urn:broken" elementFormDefault="qualified">
  <xs:complexType name="Holder">
    <xs:sequence>
      <xs:element ref="b:missing"/>
      <xs:element name="own" type="xs:int"/>
      <xs:group ref="b:missingGroup"/>
    </xs:sequence>
    <xs:attribute ref="b:missingAttr"/>
    <xs:attributeGroup ref="b:missingAG"/>
    <xs:attribute name="weird" type="zzz:thing"/>
  </xs:complexType>
  <xs:element name="holder" type="b:Holder"/>
</xs:schema>`;

    withTempDir((dir) => {
      const file = path.join(dir, 'schema.xsd');
      fs.writeFileSync(file, BROKEN_XSD);

      const ir = parseXsd([file]);
      const holder = ir.complexTypes['{urn:broken}Holder'];
      // Unresolvable refs are skipped; the resolvable fields remain, and the
      // unresolved attribute ref keeps its xs:string fallback field.
      expect(holder.fields.map((f) => f.qname)).toEqual([
        '{urn:broken}own',
        '{urn:broken}missingAttr',
        '{}weird',
      ]);

      expect(ir.unresolvedRefs).toEqual(
        expect.arrayContaining([
          'unresolved element ref "{urn:broken}missing"',
          'unresolved group ref "{urn:broken}missingGroup"',
          'unresolved attribute ref "{urn:broken}missingAttr"',
          'unresolved attributeGroup ref "{urn:broken}missingAG"',
          'unknown namespace prefix "zzz" in QName "zzz:thing"',
        ])
      );
    });
  });

  it('redefine of xs:group and xs:attributeGroup affects their consumers (#78)', () => {
    const BASE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:redefine-group" xmlns:t="urn:redefine-group" elementFormDefault="qualified">
  <xs:group name="G">
    <xs:sequence>
      <xs:element name="old" type="xs:string"/>
    </xs:sequence>
  </xs:group>
  <xs:attributeGroup name="AG">
    <xs:attribute name="oldAttr" type="xs:string"/>
  </xs:attributeGroup>
</xs:schema>`;

    const REDEFINE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:redefine-group" xmlns:t="urn:redefine-group" elementFormDefault="qualified">
  <xs:redefine schemaLocation="base.xsd">
    <xs:group name="G">
      <xs:sequence>
        <xs:element name="new" type="xs:string"/>
      </xs:sequence>
    </xs:group>
    <xs:attributeGroup name="AG">
      <xs:attribute name="newAttr" type="xs:int"/>
    </xs:attributeGroup>
  </xs:redefine>
  <xs:complexType name="Consumer">
    <xs:sequence>
      <xs:group ref="t:G"/>
    </xs:sequence>
    <xs:attributeGroup ref="t:AG"/>
  </xs:complexType>
  <xs:element name="consumer" type="t:Consumer"/>
</xs:schema>`;

    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'base.xsd'), BASE_XSD);
      fs.writeFileSync(path.join(dir, 'redefine.xsd'), REDEFINE_XSD);

      const ir = parseXsd([path.join(dir, 'redefine.xsd')]);
      const consumer = ir.complexTypes['{urn:redefine-group}Consumer'];
      expect(consumer).toBeDefined();
      expect(consumer.fields.map((f) => f.qname)).toEqual([
        '{urn:redefine-group}new',
        '{}newAttr',
      ]);
      const newAttr = consumer.fields.find((f) => f.qname === '{}newAttr');
      expect(newAttr?.typeName).toBe('{http://www.w3.org/2001/XMLSchema}int');
    });
  });

  it('redefine-by-restriction replaces the original content model', () => {
    const BASE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:redefine-test" xmlns:t="urn:redefine-test" elementFormDefault="qualified">
  <xs:complexType name="AddressType">
    <xs:sequence>
      <xs:element name="name" type="xs:string"/>
      <xs:element name="street" type="xs:string"/>
      <xs:element name="city" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
</xs:schema>`;

    const REDEFINE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:redefine-test" xmlns:t="urn:redefine-test" elementFormDefault="qualified">
  <xs:redefine schemaLocation="base.xsd">
    <xs:complexType name="AddressType">
      <xs:complexContent>
        <xs:restriction base="t:AddressType">
          <xs:sequence>
            <xs:element name="name" type="xs:string"/>
            <xs:element name="city" type="xs:string"/>
          </xs:sequence>
        </xs:restriction>
      </xs:complexContent>
    </xs:complexType>
  </xs:redefine>
</xs:schema>`;

    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'base.xsd'), BASE_XSD);
      fs.writeFileSync(path.join(dir, 'redefine.xsd'), REDEFINE_XSD);

      const ir = parseXsd([path.join(dir, 'redefine.xsd')]);
      const addressType = ir.complexTypes['{urn:redefine-test}AddressType'];
      expect(addressType).toBeDefined();
      const fieldNames = addressType?.fields.map((f) => f.qname);
      expect(fieldNames).toEqual(['{urn:redefine-test}name', '{urn:redefine-test}city']);
      expect(addressType?.baseType).toBeUndefined();
    });
  });

  it('redefine-by-extension appends to the original content model', () => {
    const BASE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:redefine-ext" xmlns:t="urn:redefine-ext" elementFormDefault="qualified">
  <xs:complexType name="AddressType">
    <xs:sequence>
      <xs:element name="name" type="xs:string"/>
      <xs:element name="city" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
</xs:schema>`;

    const REDEFINE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:redefine-ext" xmlns:t="urn:redefine-ext" elementFormDefault="qualified">
  <xs:redefine schemaLocation="base.xsd">
    <xs:complexType name="AddressType">
      <xs:complexContent>
        <xs:extension base="t:AddressType">
          <xs:sequence>
            <xs:element name="country" type="xs:string"/>
          </xs:sequence>
        </xs:extension>
      </xs:complexContent>
    </xs:complexType>
  </xs:redefine>
</xs:schema>`;

    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'base.xsd'), BASE_XSD);
      fs.writeFileSync(path.join(dir, 'redefine.xsd'), REDEFINE_XSD);

      const ir = parseXsd([path.join(dir, 'redefine.xsd')]);
      const addressType = ir.complexTypes['{urn:redefine-ext}AddressType'];
      expect(addressType).toBeDefined();
      const fieldNames = addressType?.fields.map((f) => f.qname);
      expect(fieldNames).toEqual(['{urn:redefine-ext}name', '{urn:redefine-ext}city', '{urn:redefine-ext}country']);
    });
  });

  it('resolves element ref attributes', () => {
    const REF_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:ref-test" xmlns:t="urn:ref-test" elementFormDefault="qualified">
  <xs:element name="shared" type="xs:string"/>
  <xs:complexType name="Container">
    <xs:sequence>
      <xs:element ref="t:shared" minOccurs="0" maxOccurs="unbounded"/>
      <xs:element name="own" type="xs:int"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="container" type="t:Container"/>
</xs:schema>`;

    withTempDir((dir) => {
      const file = path.join(dir, 'schema.xsd');
      fs.writeFileSync(file, REF_XSD);

      const ir = parseXsd([file]);
      const containerType = ir.complexTypes['{urn:ref-test}Container'];
      expect(containerType).toBeDefined();
      const sharedField = containerType?.fields.find((f) => f.qname === '{urn:ref-test}shared');
      expect(sharedField).toBeDefined();
      expect(sharedField?.typeName).toBe('{http://www.w3.org/2001/XMLSchema}string');
      expect(sharedField?.maxOccurs).toBe('unbounded');
    });
  });

  it('parses inline xs:simpleType on elements and attributes into synthetic simple types (#75)', () => {
    const INLINE_SIMPLE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:inline-simple" xmlns:t="urn:inline-simple" elementFormDefault="qualified">
  <xs:element name="age">
    <xs:simpleType>
      <xs:restriction base="xs:integer">
        <xs:minInclusive value="0"/>
        <xs:maxInclusive value="150"/>
      </xs:restriction>
    </xs:simpleType>
  </xs:element>
  <xs:complexType name="Person">
    <xs:sequence>
      <xs:element name="nickname">
        <xs:simpleType>
          <xs:restriction base="xs:string">
            <xs:maxLength value="20"/>
          </xs:restriction>
        </xs:simpleType>
      </xs:element>
    </xs:sequence>
    <xs:attribute name="status">
      <xs:simpleType>
        <xs:restriction base="xs:string">
          <xs:enumeration value="active"/>
          <xs:enumeration value="inactive"/>
        </xs:restriction>
      </xs:simpleType>
    </xs:attribute>
  </xs:complexType>
  <xs:element name="person" type="t:Person"/>
</xs:schema>`;

    withTempDir((dir) => {
      const file = path.join(dir, 'schema.xsd');
      fs.writeFileSync(file, INLINE_SIMPLE_XSD);

      const ir = parseXsd([file]);

      // Top-level element: inline simpleType becomes a named simple type, not xs:string
      const age = ir.elements['{urn:inline-simple}age'];
      expect(age).toBeDefined();
      expect(age.typeName).not.toBe('{http://www.w3.org/2001/XMLSchema}string');
      const ageType = ir.simpleTypes[age.typeName];
      expect(ageType).toBeDefined();
      expect(ageType.baseType).toBe('{http://www.w3.org/2001/XMLSchema}integer');
      expect(ageType.facets).toEqual([
        { kind: 'minInclusive', value: 0 },
        { kind: 'maxInclusive', value: 150 },
      ]);

      // Local element inside a complexType
      const person = ir.complexTypes['{urn:inline-simple}Person'];
      const nickname = person.fields.find((f) => f.qname === '{urn:inline-simple}nickname');
      expect(nickname).toBeDefined();
      const nicknameType = ir.simpleTypes[nickname!.typeName];
      expect(nicknameType).toBeDefined();
      expect(nicknameType.baseType).toBe('{http://www.w3.org/2001/XMLSchema}string');
      expect(nicknameType.facets).toEqual([{ kind: 'maxLength', value: 20 }]);

      // Attribute
      const status = person.fields.find((f) => f.qname === '{}status');
      expect(status).toBeDefined();
      const statusType = ir.simpleTypes[status!.typeName];
      expect(statusType).toBeDefined();
      expect(statusType.facets).toEqual([
        { kind: 'enumeration', value: 'active' },
        { kind: 'enumeration', value: 'inactive' },
      ]);

      // The generated zod code uses the constraints
      const generated = irToZod(ir);
      expect(generated.schemas).toContain('z.number().int().min(0).max(150)');
      expect(generated.schemas).toContain('z.string().max(20)');
      expect(generated.schemas).toContain('z.enum(["active", "inactive"])');
    });
  });

  it('round-trips nested complex types without producing [object Object] (#8)', async () => {
    const NESTED_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:nested-test" xmlns:t="urn:nested-test" elementFormDefault="qualified">
  <xs:complexType name="LineItemType">
    <xs:sequence>
      <xs:element name="productId" type="xs:string"/>
      <xs:element name="quantity" type="xs:integer"/>
    </xs:sequence>
  </xs:complexType>
  <xs:complexType name="OrderType">
    <xs:sequence>
      <xs:element name="orderId" type="xs:string"/>
      <xs:element name="lineItem" type="t:LineItemType" maxOccurs="unbounded"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="order" type="t:OrderType"/>
</xs:schema>`;

    const mod = await importFromXsd(NESTED_XSD);
    const orderSchema = mod.orderSchema as z.ZodType;

    const xml = `<order xmlns="urn:nested-test"><orderId>ORD-001</orderId><lineItem><productId>P-100</productId><quantity>2</quantity></lineItem><lineItem><productId>P-200</productId><quantity>5</quantity></lineItem></order>`;
    const parsed = parseXml(orderSchema, xml) as Record<string, unknown>;

    expect(parsed.orderId).toBe('ORD-001');
    expect(parsed.lineItem).toEqual([
      { productId: 'P-100', quantity: 2 },
      { productId: 'P-200', quantity: 5 }
    ]);

    const serialized = serializeXml(orderSchema, parsed);
    expect(serialized).not.toContain('[object Object]');
    expect(serialized).toContain('<ns0:productId>P-100</ns0:productId>');
    expect(serialized).toContain('<ns0:quantity>5</ns0:quantity>');

    const reparsed = parseXml(orderSchema, serialized);
    expect(reparsed).toEqual(parsed);
  });

  describe('simple type facets (#24)', () => {
    const FACET_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:facets" xmlns:t="urn:facets" elementFormDefault="qualified">
  <xs:simpleType name="CountryCode">
    <xs:restriction base="xs:string">
      <xs:pattern value="[A-Z]{2}"/>
      <xs:length value="2"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="StatusCode">
    <xs:restriction base="xs:string">
      <xs:enumeration value="active"/>
      <xs:enumeration value="inactive"/>
      <xs:enumeration value="pending"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="Quantity">
    <xs:restriction base="xs:integer">
      <xs:minInclusive value="1"/>
      <xs:maxInclusive value="100"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="Price">
    <xs:restriction base="xs:decimal">
      <xs:fractionDigits value="2"/>
      <xs:minInclusive value="0"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="Temperature">
    <xs:restriction base="xs:decimal">
      <xs:minExclusive value="-273.15"/>
      <xs:maxExclusive value="10000"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="ShortCode">
    <xs:restriction base="xs:string">
      <xs:pattern value="[A-Z0-9]{3,8}"/>
      <xs:enumeration value="ADM"/>
      <xs:enumeration value="USR"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="LargeInt">
    <xs:restriction base="xs:integer">
      <xs:totalDigits value="5"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="NameType">
    <xs:restriction base="xs:string">
      <xs:minLength value="2"/>
      <xs:maxLength value="50"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="TokenType">
    <xs:restriction base="xs:string">
      <xs:whiteSpace value="collapse"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:complexType name="FacetContainer">
    <xs:sequence>
      <xs:element name="country" type="t:CountryCode"/>
      <xs:element name="status" type="t:StatusCode"/>
      <xs:element name="qty" type="t:Quantity"/>
      <xs:element name="price" type="t:Price"/>
      <xs:element name="temp" type="t:Temperature"/>
      <xs:element name="code" type="t:ShortCode"/>
      <xs:element name="big" type="t:LargeInt"/>
      <xs:element name="name" type="t:NameType"/>
      <xs:element name="token" type="t:TokenType"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="facets" type="t:FacetContainer"/>
</xs:schema>`;

    const NUM_ENUM_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:numEnum" xmlns:t="urn:numEnum" elementFormDefault="qualified">
  <xs:simpleType name="Priority">
    <xs:restriction base="xs:integer">
      <xs:enumeration value="1"/>
      <xs:enumeration value="2"/>
      <xs:enumeration value="3"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:complexType name="TaskType">
    <xs:sequence>
      <xs:element name="priority" type="t:Priority"/>
      <xs:element name="label" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="task" type="t:TaskType"/>
</xs:schema>`;

    const runFacetTest = (fn: (dir: string, file: string) => void): void => {
      withTempDir((dir) => {
        const file = path.join(dir, 'schema.xsd');
        fs.writeFileSync(file, FACET_XSD);
        fn(dir, file);
      });
    };

    it('stores facets in IR', () => {
      runFacetTest((_dir, file) => {
        const ir = parseXsd([file]);
        const countryCode = ir.simpleTypes['{urn:facets}CountryCode'];
        expect(countryCode).toBeDefined();
        expect(countryCode.facets).toEqual([
          { kind: 'pattern', value: '[A-Z]{2}' },
          { kind: 'length', value: 2 },
        ]);

        const statusCode = ir.simpleTypes['{urn:facets}StatusCode'];
        expect(statusCode.facets).toEqual([
          { kind: 'enumeration', value: 'active' },
          { kind: 'enumeration', value: 'inactive' },
          { kind: 'enumeration', value: 'pending' },
        ]);

        const qty = ir.simpleTypes['{urn:facets}Quantity'];
        expect(qty.facets).toEqual([
          { kind: 'minInclusive', value: 1 },
          { kind: 'maxInclusive', value: 100 },
        ]);

        const nameType = ir.simpleTypes['{urn:facets}NameType'];
        expect(nameType.facets).toEqual([
          { kind: 'minLength', value: 2 },
          { kind: 'maxLength', value: 50 },
        ]);

        const tokenType = ir.simpleTypes['{urn:facets}TokenType'];
        expect(tokenType.facets).toEqual([
          { kind: 'whiteSpace', value: 'collapse' },
        ]);
      });
    });

    it('emits pattern + length for CountryCode', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:facets}CountryCode"] = z.string().regex(new RegExp("[A-Z]{2}")).length(2).register(xmlRegistry, { qname: "{urn:facets}CountryCode" });'
        );
      });
    });

    it('emits z.enum for StatusCode', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:facets}StatusCode"] = z.enum(["active", "inactive", "pending"]).register(xmlRegistry, { qname: "{urn:facets}StatusCode" });'
        );
      });
    });

    it('emits min/max for Quantity', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:facets}Quantity"] = z.number().int().min(1).max(100).register(xmlRegistry, { qname: "{urn:facets}Quantity" });'
        );
      });
    });

    it('emits fractionDigits refine + min for Price', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:facets}Price"] = z.number().refine(xsdFractionDigits(2), { message: "expected at most 2 fraction digits" }).min(0).register(xmlRegistry, { qname: "{urn:facets}Price" });'
        );
      });
    });

    it('imports the digit-check helpers from xsd2zod when digit facets are used', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          "import { xmlRegistry, xsdTotalDigits, xsdFractionDigits } from 'xsd2zod';"
        );
      });
    });

    it('emits gt/lt for Temperature', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:facets}Temperature"] = z.number().gt(-273.15).lt(10000).register(xmlRegistry, { qname: "{urn:facets}Temperature" });'
        );
      });
    });

    it('emits refine for mixed pattern + enumeration', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          "schemas[\"{urn:facets}ShortCode\"] = z.string().regex(new RegExp(\"[A-Z0-9]{3,8}\")).refine((val) => [\"ADM\", \"USR\"].includes(val), { message: 'value is not one of the allowed values' }).register(xmlRegistry, { qname: \"{urn:facets}ShortCode\" });"
        );
      });
    });

    it('emits totalDigits as an xsdTotalDigits refine', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:facets}LargeInt"] = z.number().int().refine(xsdTotalDigits(5), { message: "expected at most 5 total digits" }).register(xmlRegistry, { qname: "{urn:facets}LargeInt" });'
        );
      });
    });

    it('emits minLength/maxLength for NameType', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:facets}NameType"] = z.string().min(2).max(50).register(xmlRegistry, { qname: "{urn:facets}NameType" });'
        );
      });
    });

    it('emits whiteSpace collapse as a z.preprocess wrapper', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:facets}TokenType"] = z.preprocess((v) => typeof v === "string" ? v.replace(/\\s+/g, " ").trim() : v, z.string()).register(xmlRegistry, { qname: "{urn:facets}TokenType" });'
        );
      });
    });

    it('emits z.union of z.literal for numeric enum', () => {
      withTempDir((dir) => {
        const file = path.join(dir, 'num-enum.xsd');
        fs.writeFileSync(file, NUM_ENUM_XSD);
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:numEnum}Priority"] = z.union([z.literal(1), z.literal(2), z.literal(3)]).register(xmlRegistry, { qname: "{urn:numEnum}Priority" });'
        );
      });
    });

    it('coerces fixed/default values to the field type (#66, #68)', async () => {
      const TYPED_DEFAULTS_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:typedDefaults" xmlns:t="urn:typedDefaults" elementFormDefault="qualified">
  <xs:complexType name="Cfg">
    <xs:sequence>
      <xs:element name="ratio" type="xs:decimal" default="1.50" minOccurs="0"/>
      <xs:element name="level" type="xs:int" fixed="3" minOccurs="0"/>
      <xs:element name="enabled" type="xs:boolean" default="1" minOccurs="0"/>
      <xs:element name="note" type="xs:string" default="1.50" minOccurs="0"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="cfg" type="t:Cfg"/>
</xs:schema>`;
      await withTempDirAsync(async (dir) => {
        const file = path.join(dir, 'schema.xsd');
        fs.writeFileSync(file, TYPED_DEFAULTS_XSD);
        const generated = irToZod(parseXsd([file]));
        // fixed → z.literal. Element defaults are NOT zod .default(): XSD
        // applies them to present-but-empty elements, not absent ones, so they
        // live in the field's registry meta as defaultValue (#66).
        expect(generated.schemas).toContain('"ratio": z.number().optional()');
        expect(generated.schemas).toContain('"level": z.literal(3).optional()');
        expect(generated.schemas).toContain('"enabled": z.boolean().optional()');
        expect(generated.schemas).toContain('"note": z.string().optional()');
        expect(generated.schemas).not.toContain('.default(');
        expect(generated.schemas).toContain('"ratio": { kind: "element", qname: "{urn:typedDefaults}ratio", defaultValue: 1.5 }');
        expect(generated.schemas).toContain('"enabled": { kind: "element", qname: "{urn:typedDefaults}enabled", defaultValue: true }');
        // string-typed fields keep the lexical verbatim
        expect(generated.schemas).toContain('"note": { kind: "element", qname: "{urn:typedDefaults}note", defaultValue: "1.50" }');

        const mod = await importGeneratedSchemas(generated.schemas);
        const cfgSchema = mod.cfgSchema as z.ZodType;

        // Absent elements stay absent — the default is not substituted.
        expect(parseXml(cfgSchema, '<cfg xmlns="urn:typedDefaults"/>')).toEqual({});

        // Present-but-empty elements get default/fixed substituted.
        const parsed = parseXml(cfgSchema, '<cfg xmlns="urn:typedDefaults"><ratio/><level/><enabled/><note/></cfg>') as Record<string, unknown>;
        expect(parsed).toEqual({ ratio: 1.5, level: 3, enabled: true, note: '1.50' });

        // The serializer always writes elements — even equal to default/fixed.
        const serialized = serializeXml(cfgSchema, parsed);
        expect(serialized).toContain('<ns0:ratio>1.5</ns0:ratio>');
        expect(serialized).toContain('<ns0:level>3</ns0:level>');
      });
    });

    it('round-trips facet-constrained data', async () => {
      await withTempDirAsync(async (dir) => {
        const file = path.join(dir, 'schema.xsd');
        fs.writeFileSync(file, FACET_XSD);
        const mod = await importGeneratedSchemas(irToZod(parseXsd([file])).schemas);
        const facetsSchema = mod.facetsSchema as z.ZodType;

        const xml = `<facets xmlns="urn:facets"><country>DE</country><status>active</status><qty>42</qty><price>19.99</price><temp>25.5</temp><code>ADM</code><big>12345</big><name>Alice</name><token>hello</token></facets>`;
        const parsed = parseXml(facetsSchema, xml) as Record<string, unknown>;
        expect(parsed.country).toBe('DE');
        expect(parsed.status).toBe('active');
        expect(parsed.qty).toBe(42);
        expect(parsed.price).toBe(19.99);
        expect(parsed.temp).toBe(25.5);
        expect(parsed.code).toBe('ADM');
        expect(parsed.big).toBe(12345);
        expect(parsed.name).toBe('Alice');
        expect(parsed.token).toBe('hello');

        const serialized = serializeXml(facetsSchema, parsed);
        const reparsed = parseXml(facetsSchema, serialized);
        expect(reparsed).toEqual(parsed);

        // whiteSpace: collapse applies via the z.preprocess wrapper (#69).
        const withWhitespace = parseXml(
          facetsSchema,
          xml.replace('<token>hello</token>', '<token>  hello   world </token>')
        ) as Record<string, unknown>;
        expect(withWhitespace.token).toBe('hello world');
      });
    });

    describe('facet rejection', () => {
      let facetsSchema: z.ZodType;

      beforeAll(async () => {
        await withTempDirAsync(async (dir) => {
          const file = path.join(dir, 'schema.xsd');
          fs.writeFileSync(file, FACET_XSD);
          const mod = await importGeneratedSchemas(irToZod(parseXsd([file])).schemas);
          facetsSchema = mod.facetsSchema as z.ZodType;
        });
      });

      const facetXml = (field: string, value: string): string => {
        const values: Record<string, string> = {
          country: 'DE', status: 'active', qty: '42', price: '19.99',
          temp: '25.5', code: 'ADM', big: '12345', name: 'Alice', token: 'hello',
          [field]: value,
        };
        const elements = Object.entries(values).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
        return `<facets xmlns="urn:facets">${elements}</facets>`;
      };

      // Facet violations surface as ZodError from the validating parse — the
      // hand-rolled runtime facet validator is gone.
      it.each([
        ['pattern', 'country', '12', 'must match pattern'],
        ['enumeration', 'status', 'bogus', 'Invalid option: expected one of'],
        ['minInclusive', 'qty', '0', 'Too small: expected number to be >=1'],
        ['fractionDigits', 'price', '19.999', 'expected at most 2 fraction digits'],
        ['totalDigits', 'big', '123456', 'expected at most 5 total digits'],
        ['minLength', 'name', 'A', 'Too small: expected string to have >=2 characters'],
      ])('rejects values violating %s facet', (_facet, field, value, message) => {
        let caught: unknown;
        try {
          parseXml(facetsSchema, facetXml(field, value));
        } catch (e: unknown) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(z.ZodError);
        expect((caught as Error).message).toContain(message);
      });
    });
  });

  it('wraps cyclic complex types in z.lazy so generated module loads without ReferenceError (#31)', async () => {
    const CYCLIC_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:cyclic" xmlns:t="urn:cyclic" elementFormDefault="qualified">
  <xs:complexType name="PersonType">
    <xs:sequence>
      <xs:element name="name" type="xs:string"/>
      <xs:element name="manager" type="t:PersonType" minOccurs="0"/>
    </xs:sequence>
  </xs:complexType>
  <xs:complexType name="TeamType">
    <xs:sequence>
      <xs:element name="lead" type="t:PersonType"/>
      <xs:element name="member" type="t:PersonType" minOccurs="0" maxOccurs="unbounded"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="person" type="t:PersonType"/>
  <xs:element name="team" type="t:TeamType"/>
</xs:schema>`;

    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, 'cyclic.xsd');
      fs.writeFileSync(xsdFile, CYCLIC_XSD);

      const ir = parseXsd([xsdFile]);
      const { schemas } = irToZod(ir);

      expect(schemas).toContain('schemas["{urn:cyclic}PersonType"] = z.lazy(() => z.object({');
      expect(schemas).toContain('schemas["{urn:cyclic}TeamType"] = z.lazy(() => z.object({');
      expect(schemas).toContain('export const personSchema = z.lazy(() => schemas["{urn:cyclic}PersonType"]).register(xmlRegistry, { root: "{urn:cyclic}person" });');
      expect(schemas).toContain('export const teamSchema = z.lazy(() => schemas["{urn:cyclic}TeamType"]).register(xmlRegistry, { root: "{urn:cyclic}team" });');

      const mod = await importGeneratedSchemas(schemas) as {
        personSchema: { parse: (v: unknown) => unknown };
        teamSchema: { parse: (v: unknown) => unknown };
      };
      expect(mod.personSchema).toBeDefined();
      expect(mod.teamSchema).toBeDefined();

      const parsed = mod.personSchema.parse({
        name: 'Alice',
        manager: { name: 'Bob', manager: { name: 'Carol' } }
      });
      expect(parsed).toEqual({
        name: 'Alice',
        manager: { name: 'Bob', manager: { name: 'Carol' } }
      });
    });
  });

  describe('xs:list and xs:union simple types (#29)', () => {
    const LIST_INLINE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:listunion" xmlns:t="urn:listunion" elementFormDefault="qualified">
  <xs:simpleType name="InlineIntList">
    <xs:list>
      <xs:simpleType>
        <xs:restriction base="xs:integer"/>
      </xs:simpleType>
      </xs:list>
  </xs:simpleType>
  <xs:simpleType name="NamedIntList">
    <xs:list itemType="t:BoundedInt"/>
  </xs:simpleType>
  <xs:simpleType name="BoundedInt">
    <xs:restriction base="xs:integer">
      <xs:minInclusive value="1"/>
      <xs:maxInclusive value="10"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:complexType name="ListContainer">
    <xs:sequence>
      <xs:element name="inlineNumbers" type="t:InlineIntList"/>
      <xs:element name="namedNumbers" type="t:NamedIntList"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="listContainer" type="t:ListContainer"/>
</xs:schema>`;

    const UNION_INLINE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:listunion" xmlns:t="urn:listunion" elementFormDefault="qualified">
  <xs:simpleType name="InlineIntOrString">
    <xs:union>
      <xs:simpleType>
        <xs:restriction base="xs:integer"/>
      </xs:simpleType>
      <xs:simpleType>
        <xs:restriction base="xs:string"/>
      </xs:simpleType>
    </xs:union>
  </xs:simpleType>
  <xs:complexType name="UnionContainer">
    <xs:sequence>
      <xs:element name="val" type="t:InlineIntOrString"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="unionContainer" type="t:UnionContainer"/>
</xs:schema>`;

    it('coerces inline list item simpleType to its base XSD primitive (#29)', async () => {
      const mod = await importFromXsd(LIST_INLINE_XSD);
      const parsed = parseXml(
        mod.listContainerSchema as z.ZodType,
        `<listContainer xmlns="urn:listunion"><inlineNumbers>1 2 3</inlineNumbers><namedNumbers>4 5 6</namedNumbers></listContainer>`
      ) as Record<string, unknown>;
      expect(parsed.inlineNumbers).toEqual([1, 2, 3]);
      expect(parsed.namedNumbers).toEqual([4, 5, 6]);
    });

    it('enforces facets from named list item simpleType via the zod checks', async () => {
      const mod = await importFromXsd(LIST_INLINE_XSD);
      expect(() => parseXml(
        mod.listContainerSchema as z.ZodType,
        `<listContainer xmlns="urn:listunion"><inlineNumbers>1 2 3</inlineNumbers><namedNumbers>4 99 6</namedNumbers></listContainer>`
      )).toThrow('Too big: expected number to be <=10');
    });

    it('coerces inline union members and falls through on member mismatch (#29)', async () => {
      const mod = await importFromXsd(UNION_INLINE_XSD);
      const unionContainerSchema = mod.unionContainerSchema as z.ZodType;

      const numericParsed = parseXml(unionContainerSchema, `<unionContainer xmlns="urn:listunion"><val>42</val></unionContainer>`) as Record<string, unknown>;
      expect(numericParsed.val).toBe(42);

      const stringParsed = parseXml(unionContainerSchema, `<unionContainer xmlns="urn:listunion"><val>hello</val></unionContainer>`) as Record<string, unknown>;
      expect(stringParsed.val).toBe('hello');
    });

    it('handles xs:list attributes and xs:union text fields', async () => {
      const ATTR_UNION_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:listunion" xmlns:t="urn:listunion" elementFormDefault="qualified">
  <xs:simpleType name="IntOrString">
    <xs:union memberTypes="xs:int xs:string"/>
  </xs:simpleType>
  <xs:simpleType name="TokenList">
    <xs:list itemType="xs:token"/>
  </xs:simpleType>
  <xs:complexType name="Container">
    <xs:simpleContent>
      <xs:extension base="t:IntOrString">
        <xs:attribute name="tags" type="t:TokenList"/>
      </xs:extension>
    </xs:simpleContent>
  </xs:complexType>
  <xs:element name="container" type="t:Container"/>
</xs:schema>`;
      const mod = await importFromXsd(ATTR_UNION_XSD);
      const containerSchema = mod.containerSchema as z.ZodType;

      const parsed = parseXml(containerSchema, `<container xmlns="urn:listunion" tags="a b c">42</container>`) as Record<string, unknown>;
      expect(parsed._text).toBe(42);
      expect(parsed['@tags']).toEqual(['a', 'b', 'c']);

      const stringParsed = parseXml(containerSchema, `<container xmlns="urn:listunion" tags="x y">hello</container>`) as Record<string, unknown>;
      expect(stringParsed._text).toBe('hello');
      expect(stringParsed['@tags']).toEqual(['x', 'y']);

      const serialized = serializeXml(containerSchema, parsed);
      const reparsed = parseXml(containerSchema, serialized);
      expect(reparsed).toEqual(parsed);
    });

    it('drops orphaned synthetic item/member types when redefine swaps list → union', () => {
      const BASE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:redefine-swap" xmlns:t="urn:redefine-swap" elementFormDefault="qualified">
  <xs:simpleType name="SwapType">
    <xs:list>
      <xs:simpleType>
        <xs:restriction base="xs:integer"/>
      </xs:simpleType>
    </xs:list>
  </xs:simpleType>
</xs:schema>`;
      const REDEFINE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:redefine-swap" xmlns:t="urn:redefine-swap" elementFormDefault="qualified">
  <xs:redefine schemaLocation="base.xsd">
    <xs:simpleType name="SwapType">
      <xs:union>
        <xs:simpleType>
          <xs:restriction base="xs:string"/>
        </xs:simpleType>
      </xs:union>
    </xs:simpleType>
  </xs:redefine>
</xs:schema>`;
      withTempDir((dir) => {
        fs.writeFileSync(path.join(dir, 'base.xsd'), BASE_XSD);
        fs.writeFileSync(path.join(dir, 'redefine.xsd'), REDEFINE_XSD);
        const ir = parseXsd([path.join(dir, 'redefine.xsd')]);

        const orphanItem = Object.keys(ir.simpleTypes).find(name => name.endsWith('}SwapType_itemType'));
        expect(orphanItem).toBeUndefined();

        const swapType = ir.simpleTypes['{urn:redefine-swap}SwapType'];
        expect(swapType).toBeDefined();
        expect(swapType.itemType).toBeUndefined();
        expect(swapType.memberTypes).toBeDefined();
      });
    });
  });

  describe('misc robustness (#79)', () => {
    it('populates targetNamespaces in the returned IR', () => {
      withTempDir((dir) => {
        const file = path.join(dir, 'schema.xsd');
        fs.writeFileSync(file, XSD);

        const ir = parseXsd([file]);
        expect(ir.targetNamespaces).toEqual(['urn:test']);
      });
    });

    it('cuts circular complexContent extensions without duplicating fields', () => {
      const CYCLE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:cycle" xmlns:t="urn:cycle" elementFormDefault="qualified">
  <xs:complexType name="A">
    <xs:complexContent>
      <xs:extension base="t:B">
        <xs:sequence>
          <xs:element name="aField" type="xs:string"/>
        </xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
  <xs:complexType name="B">
    <xs:complexContent>
      <xs:extension base="t:A">
        <xs:sequence>
          <xs:element name="bField" type="xs:string"/>
        </xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
</xs:schema>`;

      withTempDir((dir) => {
        const file = path.join(dir, 'schema.xsd');
        fs.writeFileSync(file, CYCLE_XSD);

        const ir = parseXsd([file]);
        expect(ir.complexTypes['{urn:cycle}A'].fields.map((f) => f.qname))
          .toEqual(['{urn:cycle}bField', '{urn:cycle}aField']);
        expect(ir.complexTypes['{urn:cycle}B'].fields.map((f) => f.qname))
          .toEqual(['{urn:cycle}aField', '{urn:cycle}bField']);
      });
    });

    it('does not alias IrField objects across simpleContent derivations', () => {
      const ALIAS_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:alias" xmlns:t="urn:alias">
  <xs:complexType name="Base">
    <xs:simpleContent>
      <xs:extension base="xs:string">
        <xs:attribute name="a" type="xs:string"/>
      </xs:extension>
    </xs:simpleContent>
  </xs:complexType>
  <xs:complexType name="Derived">
    <xs:simpleContent>
      <xs:extension base="t:Base"/>
    </xs:simpleContent>
  </xs:complexType>
</xs:schema>`;

      withTempDir((dir) => {
        const file = path.join(dir, 'schema.xsd');
        fs.writeFileSync(file, ALIAS_XSD);

        const ir = parseXsd([file]);
        const baseAttr = ir.complexTypes['{urn:alias}Base'].fields.find((f) => f.qname === '{}a');
        const derivedAttr = ir.complexTypes['{urn:alias}Derived'].fields.find((f) => f.qname === '{}a');
        expect(derivedAttr).toBeDefined();
        expect(derivedAttr).toEqual(baseAttr);
        expect(derivedAttr).not.toBe(baseAttr);
      });
    });

    it('rejects invalid minOccurs/maxOccurs values instead of producing NaN', () => {
      const BAD_MIN_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:occurs" xmlns:t="urn:occurs">
  <xs:complexType name="C">
    <xs:sequence>
      <xs:element name="a" type="xs:string" minOccurs="many"/>
    </xs:sequence>
  </xs:complexType>
</xs:schema>`;
      const BAD_MAX_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:occurs" xmlns:t="urn:occurs">
  <xs:complexType name="C">
    <xs:sequence>
      <xs:element name="a" type="xs:string" maxOccurs="lots"/>
    </xs:sequence>
  </xs:complexType>
</xs:schema>`;

      withTempDir((dir) => {
        const minFile = path.join(dir, 'min.xsd');
        const maxFile = path.join(dir, 'max.xsd');
        fs.writeFileSync(minFile, BAD_MIN_XSD);
        fs.writeFileSync(maxFile, BAD_MAX_XSD);

        expect(() => parseXsd([minFile])).toThrow('Invalid minOccurs value "many"');
        expect(() => parseXsd([maxFile])).toThrow('Invalid maxOccurs value "lots"');
      });
    });
  });
});
