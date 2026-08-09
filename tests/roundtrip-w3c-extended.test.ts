import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runRoundTrip } from "./helpers.js";
import { discoverValidCases, type W3cTestSetRef } from "./w3cDriver.js";
import { W3C_KNOWN_FAILURES } from "./w3cKnownFailures.js";

const W3C_DIR = path.resolve("testdata/upstream/w3c-xsdtests");

// Targeted selection of sun/ms test sets exercising supported features
// (complexType, simpleType, elements, attributes, groups) — Phase 1b of #108,
// extended in Phase 2 with the ms schema-composition/annotation sets and a
// nist datatype pilot (group-filtered: the nist testSet is one giant file).
// The IdConstrDefs/Wildcard/IdentityConstraint/Notation sets are covered by
// the full-corpus suite instead (tests/corpus/, runs on main).
const TEST_SETS: W3cTestSetRef[] = [
  "sunMeta/suntest.testSet",
  "sunMeta/CType.testSet",
  "sunMeta/SType.testSet",
  "sunMeta/ElemDecl.testSet",
  "sunMeta/AttrDecl.testSet",
  "sunMeta/AttrUse.testSet",
  "sunMeta/MGroup.testSet",
  "sunMeta/MGroupDef.testSet",
  "sunMeta/AGroupDef.testSet",
  "msMeta/ComplexType_w3c.xml",
  "msMeta/SimpleType_w3c.xml",
  "msMeta/Element_w3c.xml",
  "msMeta/Attribute_w3c.xml",
  "msMeta/AttributeGroup_w3c.xml",
  "msMeta/Group_w3c.xml",
  "msMeta/ModelGroups_w3c.xml",
  "msMeta/Particles_w3c.xml",
  "msMeta/DataTypes_w3c.xml",
  "msMeta/Schema_w3c.xml",
  "msMeta/Additional_w3c.xml",
  "msMeta/Annotations_w3c.xml",
  "msMeta/Errata10_w3c.xml",
  {
    file: "nistMeta/NISTXMLSchemaDatatypes.testSet",
    groupFilter: /^atomic-decimal-/,
  },
];

describe("W3C extended round-trip (sun/ms selection)", () => {
  if (!fs.existsSync(W3C_DIR) || fs.readdirSync(W3C_DIR).length === 0) {
    it("skip — W3C submodule not checked out", () => {});
    return;
  }

  const cases = discoverValidCases(
    TEST_SETS.map((ref) =>
      typeof ref === "string"
        ? path.join(W3C_DIR, ref)
        : { ...ref, file: path.join(W3C_DIR, ref.file) },
    ),
  );
  const keyOf = (testSet: string, name: string): string =>
    `${path.basename(testSet).replace(/\.testSet$|_w3c\.xml$/, "")}/${name}`;

  // Spec-section conformance report (#108): XSD spec anchor → case counts.
  // Written to the gitignored test-artifacts dir; CI can pick it up from there.
  {
    const byAnchor = new Map<string, { total: number; knownFailures: number }>();
    for (const c of cases) {
      for (const anchor of c.specRefs.length > 0 ? c.specRefs : ["(no spec reference)"]) {
        const entry = byAnchor.get(anchor) ?? { total: 0, knownFailures: 0 };
        entry.total++;
        if (W3C_KNOWN_FAILURES.has(keyOf(c.testSet, c.name))) {
          entry.knownFailures++;
        }
        byAnchor.set(anchor, entry);
      }
    }
    const reportDir = path.resolve(".xsd-to-zod-tests");
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir, "w3c-conformance.json"),
      JSON.stringify(
        {
          generated: new Date().toISOString(),
          testSets: TEST_SETS.map((ref) =>
            typeof ref === "string" ? ref : `${ref.file} (groups: ${ref.groupFilter})`,
          ),
          totalCases: cases.length,
          knownFailures: W3C_KNOWN_FAILURES.size,
          bySpecSection: Object.fromEntries(
            [...byAnchor.entries()].sort(([a], [b]) => a.localeCompare(b)),
          ),
        },
        null,
        2,
      ),
    );
  }

  // Every W3C_KNOWN_FAILURES key must match a discovered case — a stale key means
  // the testSet changed or the case was renamed.
  it("has no stale W3C_KNOWN_FAILURES entries", () => {
    const discovered = new Set(cases.map((c) => keyOf(c.testSet, c.name)));
    const stale = [...W3C_KNOWN_FAILURES.keys()].filter((k) => !discovered.has(k));
    expect(stale).toEqual([]);
  });

  for (const c of cases) {
    const key = keyOf(c.testSet, c.name);
    const anchors = c.specRefs.length > 0 ? ` [${c.specRefs.join(", ")}]` : "";
    const title = `round-trips W3C ${key}${anchors}`;
    const reason = W3C_KNOWN_FAILURES.get(key);
    if (reason) {
      // Known failures run as it.fails: a fix that makes one pass turns the
      // suite red ("expected test to fail"), forcing the entry's removal in
      // the same PR that lands the fix.
      it.fails(`${title} — KNOWN FAILURE: ${reason}`, async () => {
        await runRoundTrip(c.xsdFiles, c.xmlFile);
      }, 30_000);
    } else {
      it(title, async () => {
        await runRoundTrip(c.xsdFiles, c.xmlFile);
      }, 30_000);
    }
  }
});
