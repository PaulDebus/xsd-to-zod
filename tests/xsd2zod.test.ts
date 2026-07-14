import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRootHelpers, irToZod, parseXsd } from '../src/index.js';
import type { RuntimeRootMetadata } from '../src/types.js';

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:complexType name="OrderType">
    <xs:sequence>
      <xs:element name="item" type="xs:string" minOccurs="0" maxOccurs="3"/>
      <xs:choice minOccurs="0">
        <xs:element name="sku" type="xs:string"/>
        <xs:element name="ean" type="xs:string"/>
      </xs:choice>
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

const extractRuntimeRoots = (metadataCode: string): RuntimeRootMetadata[] => {
  const match = metadataCode.match(/runtimeMetadata = ([\s\S]+) as const;/);
  if (!match) {
    throw new Error('runtime metadata not found');
  }
  return JSON.parse(match[1]).roots as RuntimeRootMetadata[];
};

describe('xsd2zod v1 pipeline', () => {
  it('supports array cardinality, collisions, choice, and nillable handling', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsd2zod-'));
    const file = path.join(dir, 'schema.xsd');
    fs.writeFileSync(file, XSD);

    const ir = parseXsd([file]);
    const generated = irToZod(ir);
    const runtimeRoots = extractRuntimeRoots(generated.metadata);

    const orderMeta = runtimeRoots.find((root) => root.rootElement.endsWith('}order'));
    expect(orderMeta).toBeDefined();

    const { parseXml, serializeXml } = createRootHelpers<Record<string, unknown>>(orderMeta!);

    const xml = `<order xmlns="urn:test" item="shadow"><item>one</item><sku>A1</sku><note xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true"/></order>`;
    const parsed = parseXml(xml);

    expect(parsed['@item']).toBe('shadow');
    expect(parsed.item).toEqual(['one']);
    expect(parsed.__choice).toBe('sku');
    expect(parsed.note).toBeNull();

    const serialized = serializeXml(parsed);
    expect(serialized).toContain('xsi:nil="true"');
    expect(serialized).toContain('<sku>A1</sku>');
  });

  it('supports simpleContent with attributes and text value', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsd2zod-'));
    const file = path.join(dir, 'schema.xsd');
    fs.writeFileSync(file, XSD);

    const ir = parseXsd([file]);
    const generated = irToZod(ir);
    const runtimeRoots = extractRuntimeRoots(generated.metadata);

    const priceMeta = runtimeRoots.find((root) => root.rootElement.endsWith('}price'));
    expect(priceMeta).toBeDefined();

    const { parseXml } = createRootHelpers<Record<string, unknown>>(priceMeta!);
    const parsed = parseXml('<price xmlns="urn:test" currency="USD">42</price>');

    expect(parsed._text).toBe(42);
    expect(parsed['@currency']).toBe('USD');
  });
});
