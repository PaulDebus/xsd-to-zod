import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runRoundTrip } from './helpers.js';
import { discoverValidCases, parseSuiteIndex, type W3cCase } from './w3cDriver.js';
import { W3C_CORPUS_KNOWN_FAILURES } from './w3cCorpusKnownFailures.js';

const W3C_DIR = path.resolve('testdata/upstream/w3c-xsdtests');

// Full XSD 1.0 corpus (#108 Phase 4): every testSet in suite.xml except the
// XSD 1.1 contributions (saxon/ibm/oracle — licensing and 1.1 features) and
// common/introspection (round-trips the suite's own multi-MB metadata files —
// minutes per case for no instance-conformance value).
// Runs nightly (npm run test:corpus), not in the PR suite.
export const corpusTestSets = (): string[] =>
  parseSuiteIndex(path.join(W3C_DIR, 'suite.xml')).filter(f => !/saxonMeta|ibmMeta|oracleMeta|common\/introspection/.test(f));

export const corpusAvailable = (): boolean =>
  fs.existsSync(W3C_DIR) && fs.readdirSync(W3C_DIR).length > 0;

export const discoverCorpusCases = (testSetFiles: string[]): W3cCase[] => discoverValidCases(testSetFiles);

export const corpusKeyOf = (testSet: string, name: string): string =>
  `${path.relative(W3C_DIR, testSet)}/${name}`;

// Register the round-trip tests for a slice of the corpus. Known failures run
// as it.fails, so conformance fixes turn the suite red until the pin is
// removed — same mechanics as the selection suite. The stale-key guard only
// checks entries belonging to this slice's testSets (the pin file is shared).
export const registerCorpusTests = (label: string, testSetFiles: string[]): void => {
  const cases = discoverCorpusCases(testSetFiles);
  const slicePrefixes = testSetFiles.map(f => `${path.relative(W3C_DIR, f)}/`);

  it(`has no stale W3C corpus KNOWN_FAILURES entries (${label})`, () => {
    const discovered = new Set(cases.map(c => corpusKeyOf(c.testSet, c.name)));
    const stale = [...W3C_CORPUS_KNOWN_FAILURES.keys()]
      .filter(k => slicePrefixes.some(p => k.startsWith(p)))
      .filter(k => !discovered.has(k));
    expect(stale).toEqual([]);
  });

  for (const c of cases) {
    const key = corpusKeyOf(c.testSet, c.name);
    const anchors = c.specRefs.length > 0 ? ` [${c.specRefs.join(', ')}]` : '';
    const title = `round-trips W3C ${key}${anchors}`;
    const reason = W3C_CORPUS_KNOWN_FAILURES.get(key);
    if (reason) {
      it.fails(`${title} — KNOWN FAILURE: ${reason}`, async () => {
        await runRoundTrip(c.xsdFiles, c.xmlFile);
      }, 30_000);
    } else {
      it(title, async () => {
        await runRoundTrip(c.xsdFiles, c.xmlFile);
      }, 30_000);
    }
  }
};
