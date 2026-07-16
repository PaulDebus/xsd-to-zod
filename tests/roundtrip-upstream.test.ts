import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import { runRoundTrip, type TestCase } from './helpers.js';

const KNOWN_FAILURES = new Map<string, string>([
  ['oasis-ubl-2.4/xml/UBL-Invoice-2.1-Example', 'serialized XML fails XSD validation — UBL schema imports and element ordering issues (#37)'],
  ['oasis-ubl-2.4/xml/UBL-Order-2.0-Example', 'serialized XML fails XSD validation — UBL schema imports and element ordering issues (#37)'],
  ['xmlschema/collection/collection', 'serialized XML fails XSD validation — elementFormDefault handling (#35)'],
  ['xmlschema/collection/collection2', 'serialized XML fails XSD validation — elementFormDefault handling (#35)'],
  ['xmlschema/collection/collection3', 'serialized XML fails XSD validation — elementFormDefault handling (#35)'],
  ['xmlschema/collection/collection3bis', 'serialized XML fails XSD validation — elementFormDefault handling (#35)'],
  ['xmlschema/collection/collection4', 'serialized XML fails XSD validation — elementFormDefault handling (#35)'],
  ['xmlschema/collection/collection6', '#14 — XSD-level elements like <xs:import> not recognized as document root'],
  ['xmlschema/collection/collection-redef-xmlns', 'serialized XML fails XSD validation — elementFormDefault handling (#35)'],
  ['xmlschema/vehicles/vehicles-ns-mix', 'serialized XML fails XSD validation — child element namespace context resolution (#36 follow-up)'],
  ['xmlschema/menù/menù-ascii', '#15 — numeric character references in root element name not decoded'],
  ['xmlschema/menù/menù-cp1252', 'serialized XML fails XSD validation — encoding issues in schema file name'],

]);

function discoverUpstreamCases(): TestCase[] {
  const cases: TestCase[] = [];
  const base = path.resolve('testdata/upstream');

  for (const source of fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== 'w3c-xsdtests')) {
    const sourcePath = path.join(base, source.name);

    const allXsdFiles: string[] = [];
    const collectXsds = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) collectXsds(full);
        else if (e.name.endsWith('.xsd')) allXsdFiles.push(full);
      }
    };
    collectXsds(sourcePath);

    const scanXml = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) scanXml(full);
        else if (e.name.endsWith('.xml') && !e.name.includes('error') && !e.name.includes('invalid')) {
          cases.push({
            name: `${source.name}/${path.relative(sourcePath, full.replace(/\.xml$/, ''))}`,
            xsdFiles: allXsdFiles,
            xmlFile: full,
          });
        }
      }
    };
    scanXml(sourcePath);
  }

  return cases;
}

const upstreamCases = discoverUpstreamCases();

describe('upstream round-trip', () => {
  for (const c of upstreamCases) {
    const reason = KNOWN_FAILURES.get(c.name);
    if (reason) {
      it.skip(`round-trips ${c.name} — SKIPPED: ${reason}`, () => {});
    } else {
      it(`round-trips ${c.name}`, async () => {
        await runRoundTrip(c.xsdFiles, c.xmlFile);
      });
    }
  }
});
