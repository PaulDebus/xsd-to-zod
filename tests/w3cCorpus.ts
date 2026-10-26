import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { runRoundTrip } from "./helpers.js";
import { W3C_CORPUS_KNOWN_FAILURES } from "./w3cCorpusKnownFailures.js";
import { W3C_CORPUS_NEGATIVE_KNOWN_ANOMALIES } from "./w3cCorpusNegativeKnownAnomalies.js";
import {
  discoverInvalidCases,
  discoverValidCases,
  parseSuiteIndex,
  type W3cCase,
} from "./w3cDriver.js";
import { evaluateNegativeCase, type NegativeTally, tallyNegative } from "./w3cNegative.js";

const W3C_DIR = path.resolve("testdata/upstream/w3c-xsdtests");

// Full XSD 1.0 corpus: every testSet in suite.xml except the
// XSD 1.1 contributions (saxon/ibm/oracle — licensing and 1.1 features) and
// common/introspection (round-trips the suite's own multi-MB metadata files —
// minutes per case for no instance-conformance value).
// Runs nightly (npm run test:corpus), not in the PR suite.
export const corpusTestSets = (): string[] =>
  parseSuiteIndex(path.join(W3C_DIR, "suite.xml")).filter(
    (f) => !/saxonMeta|ibmMeta|oracleMeta|common\/introspection/.test(f),
  );

export const corpusAvailable = (): boolean =>
  fs.existsSync(W3C_DIR) && fs.readdirSync(W3C_DIR).length > 0;

export const discoverCorpusCases = (testSetFiles: string[]): W3cCase[] =>
  discoverValidCases(testSetFiles);

export const corpusKeyOf = (testSet: string, name: string): string =>
  `${path.relative(W3C_DIR, testSet)}/${name}`;

// Register the round-trip tests for a slice of the corpus. Known failures run
// as it.fails, so conformance fixes turn the suite red until the pin is
// removed — same mechanics as the selection suite. The stale-key guard only
// checks entries belonging to this slice's testSets (the pin file is shared).
// The corpus measures value-space conformance, so it generates in the exact
// integer mapping (integers: bigint). The PR-level NIST datatype selection
// uses the same mapping; the rest of the selection suite exercises the default
// number mapping, whose boundary divergences are pinned there.
export const registerCorpusTests = (label: string, testSetFiles: string[]): void => {
  const cases = discoverCorpusCases(testSetFiles);
  const slicePrefixes = testSetFiles.map((f) => `${path.relative(W3C_DIR, f)}/`);

  it(`has no stale W3C corpus KNOWN_FAILURES entries (${label})`, () => {
    const discovered = new Set(cases.map((c) => corpusKeyOf(c.testSet, c.name)));
    const stale = [...W3C_CORPUS_KNOWN_FAILURES.keys()]
      .filter((k) => slicePrefixes.some((p) => k.startsWith(p)))
      .filter((k) => !discovered.has(k));
    expect(stale).toEqual([]);
  });

  for (const c of cases) {
    const key = corpusKeyOf(c.testSet, c.name);
    const anchors = c.specRefs.length > 0 ? ` [${c.specRefs.join(", ")}]` : "";
    const title = `round-trips W3C ${key}${anchors}`;
    const reason = W3C_CORPUS_KNOWN_FAILURES.get(key);
    if (reason) {
      it.fails(`${title} — KNOWN FAILURE: ${reason}`, async () => {
        await runRoundTrip(c.xsdFiles, c.xmlFile, undefined, { integers: "bigint" });
      }, 30_000);
    } else {
      it(title, async () => {
        await runRoundTrip(c.xsdFiles, c.xmlFile, undefined, { integers: "bigint" });
      }, 30_000);
    }
  }
};

// Register the invalid-instance tests for a slice of the corpus. Mechanics
// match the PR-level negative suite: a zod reject passes, a zod accept is
// checked against libxml2 (the conformance authority) and recorded as
// leniency, and a case both tiers accept is an anomaly pinned as `it.fails`.
// Each shard writes its own leniency report; the corpus workflow publishes
// all shards together.
export const registerCorpusNegativeTests = (label: string, testSetFiles: string[]): void => {
  const cases = discoverInvalidCases(testSetFiles);
  const slicePrefixes = testSetFiles.map((f) => `${path.relative(W3C_DIR, f)}/`);
  const inSlice = (key: string): boolean => slicePrefixes.some((p) => key.startsWith(p));

  it(`has no stale W3C corpus negative KNOWN_ANOMALIES entries (${label})`, () => {
    const discovered = new Set(cases.map((c) => corpusKeyOf(c.testSet, c.name)));
    const stale = [...W3C_CORPUS_NEGATIVE_KNOWN_ANOMALIES.keys()]
      .filter(inSlice)
      .filter((k) => !discovered.has(k));
    expect(stale).toEqual([]);
  });

  const stats = new Map<string, NegativeTally>();
  const lenientCases: string[] = [];
  const anomalyCases: string[] = [];

  afterAll(() => {
    const reportDir = path.resolve(".xsd-to-zod-tests");
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir, `w3c-negative-corpus-${label}.json`),
      JSON.stringify(
        {
          generated: new Date().toISOString(),
          label,
          testSets: testSetFiles.map((f) => path.relative(W3C_DIR, f)),
          totalCases: cases.length,
          knownAnomalies: [...W3C_CORPUS_NEGATIVE_KNOWN_ANOMALIES.keys()].filter(inSlice).length,
          bySpecSection: Object.fromEntries(
            [...stats.entries()].sort(([a], [b]) => a.localeCompare(b)),
          ),
          lenientCases: lenientCases.sort(),
          anomalyCases: anomalyCases.sort(),
        },
        null,
        2,
      ),
    );
  });

  for (const c of cases) {
    const key = corpusKeyOf(c.testSet, c.name);
    const anchors = c.specRefs.length > 0 ? c.specRefs : ["(no spec reference)"];
    const anchorsSuffix = c.specRefs.length > 0 ? ` [${c.specRefs.join(", ")}]` : "";
    const title = `rejects W3C ${key}${anchorsSuffix}`;
    const reason = W3C_CORPUS_NEGATIVE_KNOWN_ANOMALIES.get(key);

    const body = async () => {
      const outcome = await evaluateNegativeCase(c);
      if (outcome === "lenient") {
        lenientCases.push(key);
      }
      if (outcome === "anomaly") {
        anomalyCases.push(key);
      }
      tallyNegative(stats, anchors, outcome);
      expect(outcome).not.toBe("anomaly");
    };

    if (reason) {
      it.fails(`${title} — KNOWN ANOMALY: ${reason}`, body, 30_000);
    } else {
      it(title, body, 30_000);
    }
  }
};
