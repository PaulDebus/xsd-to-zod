import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractRootInfo, findRootSchema, generateAndImport, readXmlFile } from "./helpers.js";
import { discoverInvalidCases, type W3cTestSetRef } from "./w3cDriver.js";

const W3C_DIR = path.resolve("testdata/upstream/w3c-xsdtests");

// Same selection as the positive extended suite (#108 Phase 3): for instances
// the suite marks INVALID, assert the generated Zod schema rejects them. Where
// the zod tier is intentionally lenient (unenforced facets, unsupported
// features), the libxml2 tier is the conformance authority: the case passes
// when libxml2 rejects, and the leniency is recorded in the report. Cases
// where even libxml2 accepts are anomalies — pinned below.
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

// Known failures: anomalies (both tiers accept what the suite marks invalid,
// e.g. XSD 1.0 vs 1.1 expectation differences) and crash/harness cases that
// need their own fixes. Keyed by `<testSetName>/<testGroup>/<instanceTest>`.
const KNOWN_ANOMALIES = new Map<string, string>([
  [
    "suntest/identitytestsuitetest001/test.2.n",
    "identity constraints unsupported — both tiers accept",
  ],
  [
    "Element/elemZ016/elemZ016.i",
    "both tiers accept (needs triage — likely XSD 1.0/1.1 expectation difference)",
  ],
  [
    "Attribute/attZ014a/attZ014a.i",
    "both tiers accept (needs triage — likely XSD 1.0/1.1 expectation difference)",
  ],
  [
    "Attribute/attZ014b/attZ014b.i",
    "both tiers accept (needs triage — likely XSD 1.0/1.1 expectation difference)",
  ],
  [
    "Particles/particlesZ001/particlesZ001.i",
    "both tiers accept (needs triage — likely XSD 1.0/1.1 expectation difference)",
  ],
  ["Additional/addB066/addB066.i", "both tiers accept (needs triage)"],
]);

// libxml2 verdict for one instance against the XSD whose targetNamespace
// matches the document root (same relevance rule as the positive suite).
const libxmlValidates = async (xml: string, xsdFiles: string[]): Promise<boolean> => {
  const { validateXml } = await import("../src/validate.js");
  const { namespace: rootNamespace } = extractRootInfo(xml);
  const withNs = xsdFiles.map((f) => ({
    file: f,
    targetNamespace: readXmlFile(f).match(/\btargetNamespace\s*=\s*["']([^"']*)["']/)?.[1] ?? "",
  }));
  const matching = withNs.filter((c) => c.targetNamespace === rootNamespace);
  for (const { file } of matching.length > 0 ? matching : withNs) {
    try {
      if ((await validateXml(xml, readXmlFile(file), { url: file })).valid) {
        return true;
      }
    } catch {
      // Schema unloadable (e.g. relative namespace URI) — no verdict from this file.
    }
  }
  return false;
};

type Outcome = "rejected" | "rejected-foreign-root" | "lenient" | "anomaly";
const stats = new Map<string, { rejected: number; lenient: number; anomaly: number }>();
const lenientCases: string[] = [];
const record = (anchor: string, outcome: Outcome, key: string): void => {
  const entry = stats.get(anchor) ?? { rejected: 0, lenient: 0, anomaly: 0 };
  entry[outcome === "lenient" ? "lenient" : outcome === "anomaly" ? "anomaly" : "rejected"]++;
  stats.set(anchor, entry);
  if (outcome === "lenient") {
    lenientCases.push(key);
  }
};

afterAll(() => {
  const reportDir = path.resolve(".xsd-to-zod-tests");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, "w3c-negative-conformance.json"),
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        bySpecSection: Object.fromEntries(
          [...stats.entries()].sort(([a], [b]) => a.localeCompare(b)),
        ),
        lenientCases: lenientCases.sort(),
      },
      null,
      2,
    ),
  );
});

describe("W3C negative tests (invalid instances)", () => {
  if (!fs.existsSync(W3C_DIR) || fs.readdirSync(W3C_DIR).length === 0) {
    it("skip — W3C submodule not checked out", () => {});
    return;
  }

  const cases = discoverInvalidCases(
    TEST_SETS.map((ref) =>
      typeof ref === "string"
        ? path.join(W3C_DIR, ref)
        : { ...ref, file: path.join(W3C_DIR, ref.file) },
    ),
  );
  const keyOf = (testSet: string, name: string): string =>
    `${path.basename(testSet).replace(/\.testSet$|_w3c\.xml$/, "")}/${name}`;

  it("has no stale KNOWN_ANOMALIES entries", () => {
    const discovered = new Set(cases.map((c) => keyOf(c.testSet, c.name)));
    const stale = [...KNOWN_ANOMALIES.keys()].filter((k) => !discovered.has(k));
    expect(stale).toEqual([]);
  });

  for (const c of cases) {
    const key = keyOf(c.testSet, c.name);
    const anchors = c.specRefs.length > 0 ? c.specRefs : ["(no spec reference)"];
    const title = `rejects W3C ${key}${c.specRefs.length > 0 ? ` [${c.specRefs.join(", ")}]` : ""}`;
    const reason = KNOWN_ANOMALIES.get(key);

    const body = async () => {
      const xml = readXmlFile(c.xmlFile);
      const mod = await generateAndImport(c.xsdFiles);
      let outcome: Outcome = "rejected";
      try {
        const rootSchema = findRootSchema(mod, xml);
        const { safeParseXml } = await import("../src/index.js");
        if (safeParseXml(rootSchema, xml).success) {
          outcome = "lenient";
        }
      } catch {
        outcome = "rejected-foreign-root";
      }
      if (outcome === "lenient" && (await libxmlValidates(xml, c.xsdFiles))) {
        outcome = "anomaly";
      }
      for (const anchor of anchors) {
        record(anchor, outcome, key);
      }
      expect(outcome).not.toBe("anomaly");
    };

    if (reason) {
      it.fails(`${title} — KNOWN ANOMALY: ${reason}`, body, 30_000);
    } else {
      it(title, body, 30_000);
    }
  }
});
