import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import { runRoundTrip, type TestCase } from './helpers.js';

const KNOWN_FAILURES = new Map<string, string>([
  ['xmlschema/collection/collection2', 'original XML violates xs:key identity constraint on author/@dn (inherent test data)'],
  ['xmlschema/collection/collection3', 'original XML violates xs:keyref identity constraint (inherent test data)'],
]);

function isXsdSchemaRoot(xml: string): boolean {
  const match = xml.match(/<([\w-]+):(\w+)(?:\s[^>]*)?\s+xmlns:\1="http:\/\/www\.w3\.org\/2001\/XMLSchema"/);
  return match !== null;
}

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
          const xml = fs.readFileSync(full, 'utf8');
          if (isXsdSchemaRoot(xml)) continue;

          const stem = e.name.replace(/\.xml$/, '');
          const matchingXsd = path.join(dir, stem + '.xsd');
          const xsdFiles = fs.existsSync(matchingXsd) ? [matchingXsd] : allXsdFiles;

          cases.push({
            name: `${source.name}/${path.relative(sourcePath, full.replace(/\.xml$/, ''))}`,
            xsdFiles,
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
