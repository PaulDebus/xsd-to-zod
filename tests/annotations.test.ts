import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { irToZod, parseXsd } from '../src/index.js';
import { withTempDir } from './helpers.js';

// Issue #25: xs:annotation/xs:documentation is extracted into the IR and
// emitted as zod .describe() on types, elements, attributes and fields.

const FIXTURE = path.resolve('testdata/curated/annotations/documentation.xsd');

const REFS_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:attribute name="currency">
    <xs:annotation><xs:documentation>ISO 4217 currency code</xs:documentation></xs:annotation>
    <xs:simpleType>
      <xs:restriction base="xs:string"/>
    </xs:simpleType>
  </xs:attribute>
  <xs:element name="amount" type="xs:decimal">
    <xs:annotation>
      <xs:documentation xml:lang="en">Line total</xs:documentation>
      <xs:documentation xml:lang="de">Zeilensumme</xs:documentation>
    </xs:annotation>
  </xs:element>
  <xs:complexType name="InvoiceType">
    <xs:sequence>
      <xs:element ref="t:amount"/>
    </xs:sequence>
    <xs:attribute ref="t:currency" use="required"/>
  </xs:complexType>
  <xs:element name="invoice" type="t:InvoiceType"/>
</xs:schema>`;

describe('xs:annotation/xs:documentation (#25)', () => {
  it('extracts documentation into the IR', () => {
    const ir = parseXsd([FIXTURE]);

    expect(ir.simpleTypes['{urn:curated}AmountType'].description).toBe('Monetary amount with two fraction digits');
    expect(ir.complexTypes['{urn:curated}InvoiceType'].description).toBe('An invoice line item');
    expect(ir.elements['{urn:curated}invoice'].description).toBe('Root invoice element');

    const fields = ir.complexTypes['{urn:curated}InvoiceType'].fields;
    expect(fields.find((f) => f.kind === 'element' && f.qname === '{urn:curated}amount')?.description).toBe('Line total');
    expect(fields.find((f) => f.kind === 'attribute')?.description).toBe('ISO 4217 currency code');
    // Undocumented constructs carry no description.
    expect(fields.find((f) => f.kind === 'element' && f.qname === '{urn:curated}note')?.description).toBeUndefined();
  });

  it('falls back to the referenced global declaration and joins multiple documentation entries', () => {
    withTempDir((dir) => {
      const file = path.join(dir, 'refs.xsd');
      fs.writeFileSync(file, REFS_XSD);
      const fields = parseXsd([file]).complexTypes['{urn:test}InvoiceType'].fields;

      expect(fields.find((f) => f.kind === 'attribute')?.description).toBe('ISO 4217 currency code');
      expect(fields.find((f) => f.kind === 'element')?.description).toBe('Line total\nZeilensumme');
    });
  });

  it('emits .describe() for types, elements, attributes and fields', () => {
    const { schemas } = irToZod(parseXsd([FIXTURE]));

    expect(schemas).toContain('.describe("Monetary amount with two fraction digits")');
    expect(schemas).toContain('.describe("An invoice line item")');
    expect(schemas).toContain('.describe("Root invoice element")');
    expect(schemas).toContain('.describe("Line total")');
    expect(schemas).toContain('.describe("ISO 4217 currency code")');
  });

  it('leaves generated code unchanged when no annotations are present', () => {
    const fixture = path.resolve('testdata/curated/basic/simpleType.xsd');
    expect(irToZod(parseXsd([fixture])).schemas).not.toContain('.describe(');
  });
});
