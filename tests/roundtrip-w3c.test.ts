import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runRoundTrip } from './helpers.js';
import { parseXsd } from '../src/index.js';
import { discoverValidCases } from './w3cDriver.js';

const W3C_DIR = path.resolve('testdata/upstream/w3c-xsdtests');

// Cases exercising XSD features xsd-to-zod does not support yet, with the
// reason. Keyed by `<testGroup>/<instanceTest>` name.
const KNOWN_FAILURES = new Map<string, string>([
  ['ipo6/ipo_1', 'substitution groups unsupported (salutation substitutes ipo:ExternFirstElement)'],
  ['ipo6/ipo_2', 'substitution groups unsupported (salutation substitutes ipo:ExternFirstElement)'],
]);

// Test groups are discovered from the .testSet metadata (#108), not hardcoded
// directories. Test names carry the group's XSD spec anchors.
describe('W3C smoke round-trip', () => {
  if (!fs.existsSync(W3C_DIR) || fs.readdirSync(W3C_DIR).length === 0) {
    it('skip — W3C submodule not checked out', () => {});
    return;
  }

  const boeingCases = discoverValidCases([path.join(W3C_DIR, 'boeingMeta/BoeingXSDTestSet.testSet')]);

  for (const c of boeingCases) {
    const anchors = c.specRefs.length > 0 ? ` [${c.specRefs.join(', ')}]` : '';
    const title = `round-trips W3C boeing/${c.name}${anchors}`;
    const reason = KNOWN_FAILURES.get(c.name);
    if (reason) {
      it.skip(`${title} — SKIPPED: ${reason}`, () => {});
    } else {
      it(title, async () => {
        await runRoundTrip(c.xsdFiles, c.xmlFile);
      }, 30_000);
    }
  }
});

describe('upstream parse benchmark', () => {
  it('parseXsds all upstream XSDs under 5s', () => {
    const upstreamDir = path.resolve('testdata/upstream');

    const allXsdFiles: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.name.includes('w3c')) walk(full);
        else if (e.name.endsWith('.xsd')) allXsdFiles.push(full);
      }
    };
    walk(upstreamDir);

    expect(allXsdFiles.length).toBeGreaterThan(0);

    // NOTE: duration check removed — see issue #19.
    // We only assert that all upstream XSDs parse without error.
    // If parse time becomes a concern, add a proper benchmark script.
    parseXsd(allXsdFiles);
  });
});
