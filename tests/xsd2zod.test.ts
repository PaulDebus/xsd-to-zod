import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
          'schemas["{urn:facets}CountryCode"] = z.string().regex(new RegExp("[A-Z]{2}")).length(2);'
        );
      });
    });

    it('emits z.enum for StatusCode', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:facets}StatusCode"] = z.enum(["active", "inactive", "pending"]);'
        );
      });
    });

    it('emits min/max for Quantity', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:facets}Quantity"] = z.number().int().min(1).max(100);'
        );
      });
    });

    it('emits multipleOf + min for Price', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:facets}Price"] = z.number().multipleOf(0.01).min(0);'
        );
      });
    });

    it('emits gt/lt for Temperature', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:facets}Temperature"] = z.number().gt(-273.15).lt(10000);'
        );
      });
    });

    it('emits refine for mixed pattern + enumeration', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:facets}ShortCode"] = z.string().regex(new RegExp("[A-Z0-9]{3,8}")).refine((val) => ["ADM", "USR"].includes(val));'
        );
      });
    });

    it('emits totalDigits as min/max bounds', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:facets}LargeInt"] = z.number().int().min(-99999).max(99999);'
        );
      });
    });

    it('emits minLength/maxLength for NameType', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:facets}NameType"] = z.string().min(2).max(50);'
        );
      });
    });

    it('ignores whiteSpace facet (no Zod equivalent)', () => {
      runFacetTest((_dir, file) => {
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:facets}TokenType"] = z.string();'
        );
      });
    });

    it('emits z.union of z.literal for numeric enum', () => {
      withTempDir((dir) => {
        const file = path.join(dir, 'num-enum.xsd');
        fs.writeFileSync(file, NUM_ENUM_XSD);
        const generated = irToZod(parseXsd([file]));
        expect(generated.schemas).toContain(
          'schemas["{urn:numEnum}Priority"] = z.union([z.literal(1), z.literal(2), z.literal(3)]);'
        );
      });
    });

    it('round-trips facet-constrained data', () => {
      runFacetTest((_dir, file) => {
        const ir = parseXsd([file]);
        const generated = irToZod(ir);
        const runtimeMetadata = extractRuntimeMetadata(generated.metadata);

        const rootMeta = runtimeMetadata.roots.find(r => r.rootElement.endsWith('}facets'));
        expect(rootMeta).toBeDefined();

        const { parseXml, serializeXml } = createRootHelpers<Record<string, unknown>>(rootMeta!, runtimeMetadata.types);

        const xml = `<facets xmlns="urn:facets"><country>DE</country><status>active</status><qty>42</qty><price>19.99</price><temp>25.5</temp><code>ADM</code><big>12345</big><name>Alice</name><token>hello</token></facets>`;
        const parsed = parseXml(xml);
        expect(parsed.country).toEqual({ _text: 'DE' });
        expect(parsed.status).toEqual({ _text: 'active' });
        expect(parsed.qty).toEqual({ _text: 42 });
        expect(parsed.price).toEqual({ _text: 19.99 });
        expect(parsed.temp).toEqual({ _text: 25.5 });
        expect(parsed.code).toEqual({ _text: 'ADM' });
        expect(parsed.big).toEqual({ _text: 12345 });
        expect(parsed.name).toEqual({ _text: 'Alice' });
        expect(parsed.token).toEqual({ _text: 'hello' });

        const serialized = serializeXml(parsed);
        const reparsed = parseXml(serialized);
        expect(reparsed).toEqual(parsed);
      });
    });

    it('rejects values violating pattern facet', () => {
      runFacetTest((_dir, file) => {
        const ir = parseXsd([file]);
        const generated = irToZod(ir);
        const runtimeMetadata = extractRuntimeMetadata(generated.metadata);
        const rootMeta = runtimeMetadata.roots.find(r => r.rootElement.endsWith('}facets'))!;
        const { parseXml } = createRootHelpers(rootMeta, runtimeMetadata.types);
        expect(() => parseXml(`<facets xmlns="urn:facets"><country>12</country><status>active</status><qty>42</qty><price>19.99</price><temp>25.5</temp><code>ADM</code><big>12345</big><name>Alice</name><token>hello</token></facets>`)).toThrow('does not match pattern');
      });
    });

    it('rejects values violating enumeration facet', () => {
      runFacetTest((_dir, file) => {
        const ir = parseXsd([file]);
        const generated = irToZod(ir);
        const runtimeMetadata = extractRuntimeMetadata(generated.metadata);
        const rootMeta = runtimeMetadata.roots.find(r => r.rootElement.endsWith('}facets'))!;
        const { parseXml } = createRootHelpers(rootMeta, runtimeMetadata.types);
        expect(() => parseXml(`<facets xmlns="urn:facets"><country>DE</country><status>bogus</status><qty>42</qty><price>19.99</price><temp>25.5</temp><code>ADM</code><big>12345</big><name>Alice</name><token>hello</token></facets>`)).toThrow('not one of the allowed values');
      });
    });

    it('rejects values violating minInclusive/maxInclusive facet', () => {
      runFacetTest((_dir, file) => {
        const ir = parseXsd([file]);
        const generated = irToZod(ir);
        const runtimeMetadata = extractRuntimeMetadata(generated.metadata);
        const rootMeta = runtimeMetadata.roots.find(r => r.rootElement.endsWith('}facets'))!;
        const { parseXml } = createRootHelpers(rootMeta, runtimeMetadata.types);
        expect(() => parseXml(`<facets xmlns="urn:facets"><country>DE</country><status>active</status><qty>0</qty><price>19.99</price><temp>25.5</temp><code>ADM</code><big>12345</big><name>Alice</name><token>hello</token></facets>`)).toThrow('less than minimum');
      });
    });

    it('rejects values violating fractionDigits facet', () => {
      runFacetTest((_dir, file) => {
        const ir = parseXsd([file]);
        const generated = irToZod(ir);
        const runtimeMetadata = extractRuntimeMetadata(generated.metadata);
        const rootMeta = runtimeMetadata.roots.find(r => r.rootElement.endsWith('}facets'))!;
        const { parseXml } = createRootHelpers(rootMeta, runtimeMetadata.types);
        expect(() => parseXml(`<facets xmlns="urn:facets"><country>DE</country><status>active</status><qty>42</qty><price>19.999</price><temp>25.5</temp><code>ADM</code><big>12345</big><name>Alice</name><token>hello</token></facets>`)).toThrow('more than');
      });
    });

    it('rejects values violating totalDigits facet', () => {
      runFacetTest((_dir, file) => {
        const ir = parseXsd([file]);
        const generated = irToZod(ir);
        const runtimeMetadata = extractRuntimeMetadata(generated.metadata);
        const rootMeta = runtimeMetadata.roots.find(r => r.rootElement.endsWith('}facets'))!;
        const { parseXml } = createRootHelpers(rootMeta, runtimeMetadata.types);
        expect(() => parseXml(`<facets xmlns="urn:facets"><country>DE</country><status>active</status><qty>42</qty><price>19.99</price><temp>25.5</temp><code>ADM</code><big>123456</big><name>Alice</name><token>hello</token></facets>`)).toThrow('more than');
      });
    });

    it('rejects values violating minLength/maxLength facet', () => {
      runFacetTest((_dir, file) => {
        const ir = parseXsd([file]);
        const generated = irToZod(ir);
        const runtimeMetadata = extractRuntimeMetadata(generated.metadata);
        const rootMeta = runtimeMetadata.roots.find(r => r.rootElement.endsWith('}facets'))!;
        const { parseXml } = createRootHelpers(rootMeta, runtimeMetadata.types);
        expect(() => parseXml(`<facets xmlns="urn:facets"><country>DE</country><status>active</status><qty>42</qty><price>19.99</price><temp>25.5</temp><code>ADM</code><big>12345</big><name>A</name><token>hello</token></facets>`)).toThrow('shorter than minimum length');
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

    const xsdFile = path.join(os.tmpdir(), `cyclic-${Date.now()}.xsd`);
    fs.writeFileSync(xsdFile, CYCLIC_XSD);

    const zodFile = path.join(process.cwd(), `.cyclic-${Date.now()}.zod.ts`);
    try {
      const ir = parseXsd([xsdFile]);
      const { schemas } = irToZod(ir);

      expect(schemas).toContain('schemas["{urn:cyclic}PersonType"] = z.lazy(() => z.object({');
      expect(schemas).toContain('schemas["{urn:cyclic}TeamType"] = z.lazy(() => z.object({');
      expect(schemas).toContain('export const personSchema = schemas["{urn:cyclic}PersonType"];');
      expect(schemas).toContain('export const teamSchema = schemas["{urn:cyclic}TeamType"];');

      fs.writeFileSync(zodFile, schemas);

      const mod = await import(`${pathToFileURL(zodFile).href}?t=${Date.now()}`) as {
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
    } finally {
      fs.rmSync(xsdFile, { force: true });
      fs.rmSync(zodFile, { force: true });
    }
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

    const runListUnionTest = (xsd: string, fn: (dir: string, file: string) => void): void => {
      withTempDir((dir) => {
        const file = path.join(dir, 'schema.xsd');
        fs.writeFileSync(file, xsd);
        fn(dir, file);
      });
    };

    it('coerces inline list item simpleType to its base XSD primitive (#29)', () => {
      runListUnionTest(LIST_INLINE_XSD, (_dir, file) => {
        const ir = parseXsd([file]);
        const generated = irToZod(ir);
        const runtimeMetadata = extractRuntimeMetadata(generated.metadata);
        const rootMeta = runtimeMetadata.roots.find(r => r.rootElement.endsWith('}listContainer'));
        expect(rootMeta).toBeDefined();
        const { parseXml } = createRootHelpers<Record<string, unknown>>(rootMeta!, runtimeMetadata.types);

        const parsed = parseXml(`<listContainer xmlns="urn:listunion"><inlineNumbers>1 2 3</inlineNumbers><namedNumbers>4 5 6</namedNumbers></listContainer>`);
        expect(parsed.inlineNumbers).toEqual([1, 2, 3]);
        expect(parsed.namedNumbers).toEqual([4, 5, 6]);
      });
    });

    it('enforces facets from named list item simpleType at runtime', () => {
      runListUnionTest(LIST_INLINE_XSD, (_dir, file) => {
        const ir = parseXsd([file]);
        const generated = irToZod(ir);
        const runtimeMetadata = extractRuntimeMetadata(generated.metadata);
        const rootMeta = runtimeMetadata.roots.find(r => r.rootElement.endsWith('}listContainer'))!;
        const { parseXml } = createRootHelpers(rootMeta, runtimeMetadata.types);

        expect(() => parseXml(`<listContainer xmlns="urn:listunion"><inlineNumbers>1 2 3</inlineNumbers><namedNumbers>4 99 6</namedNumbers></listContainer>`))
          .toThrow('exceeds maximum');
      });
    });

    it('coerces inline union members and falls through on member mismatch (#29)', () => {
      runListUnionTest(UNION_INLINE_XSD, (_dir, file) => {
        const ir = parseXsd([file]);
        const generated = irToZod(ir);
        const runtimeMetadata = extractRuntimeMetadata(generated.metadata);
        const rootMeta = runtimeMetadata.roots.find(r => r.rootElement.endsWith('}unionContainer'));
        expect(rootMeta).toBeDefined();
        const { parseXml } = createRootHelpers<Record<string, unknown>>(rootMeta!, runtimeMetadata.types);

        const numericParsed = parseXml(`<unionContainer xmlns="urn:listunion"><val>42</val></unionContainer>`);
        expect(numericParsed.val).toBe(42);

        const stringParsed = parseXml(`<unionContainer xmlns="urn:listunion"><val>hello</val></unionContainer>`);
        expect(stringParsed.val).toBe('hello');
      });
    });

    it('handles xs:list attributes and xs:union text fields', () => {
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
      runListUnionTest(ATTR_UNION_XSD, (_dir, file) => {
        const ir = parseXsd([file]);
        const generated = irToZod(ir);
        const runtimeMetadata = extractRuntimeMetadata(generated.metadata);
        const rootMeta = runtimeMetadata.roots.find(r => r.rootElement.endsWith('}container'))!;
        const { parseXml, serializeXml } = createRootHelpers<Record<string, unknown>>(rootMeta, runtimeMetadata.types);

        const parsed = parseXml(`<container xmlns="urn:listunion" tags="a b c">42</container>`);
        expect(parsed._text).toBe(42);
        expect(parsed['@tags']).toEqual(['a', 'b', 'c']);

        const stringParsed = parseXml(`<container xmlns="urn:listunion" tags="x y">hello</container>`);
        expect(stringParsed._text).toBe('hello');
        expect(stringParsed['@tags']).toEqual(['x', 'y']);

        const serialized = serializeXml(parsed);
        const reparsed = parseXml(serialized);
        expect(reparsed).toEqual(parsed);
      });
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
});
