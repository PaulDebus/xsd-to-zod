import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRootHelpers, irToZod, parseXsd } from '../src/index.js';
import type { RuntimeMetadata } from '../src/types.js';

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

const extractRuntimeMetadata = (metadataCode: string): RuntimeMetadata => {
  const match = metadataCode.match(/runtimeMetadata = ([\s\S]+) as const;/);
  if (!match) {
    throw new Error('runtime metadata not found');
  }
  return JSON.parse(match[1]) as RuntimeMetadata;
};

const withTempDir = (fn: (dir: string) => void): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsd2zod-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe('xsd2zod v1 pipeline', () => {
  it('supports array cardinality, collisions, choice, and nillable handling', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'schema.xsd');
      fs.writeFileSync(file, XSD);

      const ir = parseXsd([file]);
      const generated = irToZod(ir);
      expect(generated.schemas).toContain('z.union([z.discriminatedUnion');
      expect(generated.schemas).toContain('"note": z.string().nullable().optional()');
      expect(generated.schemas).toContain('"approved": z.boolean().optional()');
      const runtimeMetadata = extractRuntimeMetadata(generated.metadata);

      const orderType = ir.complexTypes['{urn:test}OrderType'];
      expect(orderType).toBeDefined();
      expect(orderType.fields.find((field) => field.qname === '{urn:test}sku')?.minOccurs).toBe(0);
      expect(orderType.fields.find((field) => field.qname === '{}item')?.kind).toBe('attribute');

      const orderMeta = runtimeMetadata.roots.find((root) => root.rootElement.endsWith('}order'));
      expect(orderMeta).toBeDefined();

      const { parseXml, serializeXml } = createRootHelpers<Record<string, unknown>>(orderMeta!, runtimeMetadata.types);

      const xml = `<order xmlns="urn:test" item="shadow"><item>one</item><sku>A1</sku><approved>1</approved><note xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true"/></order>`;
      const parsed = parseXml(xml);

      expect(parsed['@item']).toBe('shadow');
      expect(parsed.item).toEqual(['one']);
      expect(parsed.__choice).toBe('sku');
      expect(parsed.approved).toBe(true);
      expect(parsed.note).toBeNull();

      const serialized = serializeXml(parsed);
      expect(serialized).toContain('xsi:nil="true"');
      expect(serialized).toContain('<ns0:sku>A1</ns0:sku>');
    });
  });

  it('does not treat non-xsi nil as xsi:nil and matches root namespace', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'schema.xsd');
      fs.writeFileSync(file, XSD);

      const ir = parseXsd([file]);
      const generated = irToZod(ir);
      const runtimeMetadata = extractRuntimeMetadata(generated.metadata);
      const orderMeta = runtimeMetadata.roots.find((root) => root.rootElement.endsWith('}order'));
      expect(orderMeta).toBeDefined();

      const { parseXml } = createRootHelpers<Record<string, unknown>>(orderMeta!, runtimeMetadata.types);
      const parsed = parseXml('<order xmlns="urn:test"><note nil="true">kept</note><approved>0</approved></order>');
      expect(parsed.note).toBe('kept');
      expect(parsed.approved).toBe(false);

      expect(() => parseXml('<order xmlns="urn:other"><note>bad</note></order>')).toThrow(
        "Root element '{urn:test}order' not found in XML payload"
      );
    });
  });

  it('supports simpleContent with attributes and text value', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'schema.xsd');
      fs.writeFileSync(file, XSD);

      const ir = parseXsd([file]);
      const generated = irToZod(ir);
      const runtimeMetadata = extractRuntimeMetadata(generated.metadata);

      const priceMeta = runtimeMetadata.roots.find((root) => root.rootElement.endsWith('}price'));
      expect(priceMeta).toBeDefined();

      const { parseXml } = createRootHelpers<Record<string, unknown>>(priceMeta!, runtimeMetadata.types);
      const parsed = parseXml('<price xmlns="urn:test" currency="USD">42</price>');

      expect(parsed._text).toBe(42);
      expect(parsed['@currency']).toBe('USD');
    });
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

  it('round-trips nested complex types without producing [object Object] (#8)', () => {
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

    withTempDir((dir) => {
      const file = path.join(dir, 'schema.xsd');
      fs.writeFileSync(file, NESTED_XSD);

      const ir = parseXsd([file]);
      const generated = irToZod(ir);
      const runtimeMetadata = extractRuntimeMetadata(generated.metadata);

      const orderMeta = runtimeMetadata.roots.find((root) => root.rootElement.endsWith('}order'));
      expect(orderMeta).toBeDefined();

      const { parseXml, serializeXml } = createRootHelpers<Record<string, unknown>>(orderMeta!, runtimeMetadata.types);

      const xml = `<order xmlns="urn:nested-test"><orderId>ORD-001</orderId><lineItem><productId>P-100</productId><quantity>2</quantity></lineItem><lineItem><productId>P-200</productId><quantity>5</quantity></lineItem></order>`;
      const parsed = parseXml(xml);

      expect(parsed.orderId).toBe('ORD-001');
      expect(parsed.lineItem).toEqual([
        { productId: 'P-100', quantity: 2 },
        { productId: 'P-200', quantity: 5 }
      ]);

      const serialized = serializeXml(parsed);
      expect(serialized).not.toContain('[object Object]');
      expect(serialized).toContain('<ns0:productId>P-100</ns0:productId>');
      expect(serialized).toContain('<ns0:quantity>5</ns0:quantity>');

      const reparsed = parseXml(serialized);
      expect(reparsed).toEqual(parsed);
    });
  });
});
