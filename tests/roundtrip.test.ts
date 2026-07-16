import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import { runRoundTrip, type TestCase } from './helpers.js';

function discoverCuratedCases(): TestCase[] {
  const cases: TestCase[] = [];
  const base = path.resolve('testdata/curated');

  for (const cat of fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== 'negative')) {
    const catPath = path.join(base, cat.name);
    const files = fs.readdirSync(catPath);
    const allXsdPaths = files.filter(f => f.endsWith('.xsd')).map(f => path.join(catPath, f));

    for (const xmlFile of files.filter(f => f.endsWith('.xml'))) {
      const stem = xmlFile.replace(/\.xml$/, '');
      cases.push({
        name: `${cat.name}/${stem}`,
        xsdFiles: allXsdPaths,
        xmlFile: path.join(catPath, xmlFile),
      });
    }
  }

  return cases;
}

const curatedCases = discoverCuratedCases();

const KNOWN_FAILURES = new Map<string, string>([]);

describe('curated round-trip', () => {
  for (const c of curatedCases) {
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
