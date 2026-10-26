import { readXmlFile } from "../src/index.js";
import { extractRootInfo, findRootSchema, generateAndImport } from "./helpers.js";
import type { W3cCase } from "./w3cDriver.js";

// Negative-case outcome: the zod tier rejects (pass), the case has no
// generated root schema for the instance (pass), the zod tier accepts but
// libxml2 rejects (documented leniency), or both tiers accept (anomaly).
export type NegativeOutcome = "rejected" | "rejected-foreign-root" | "lenient" | "anomaly";

// libxml2 verdict for one instance against the XSD whose targetNamespace
// matches the document root (same relevance rule as the positive suites).
export const libxmlValidates = async (xml: string, xsdFiles: string[]): Promise<boolean> => {
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

export const evaluateNegativeCase = async (c: W3cCase): Promise<NegativeOutcome> => {
  const xml = readXmlFile(c.xmlFile);
  const mod = await generateAndImport(c.xsdFiles);
  let outcome: NegativeOutcome = "rejected";
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
  return outcome;
};

export interface NegativeTally {
  rejected: number;
  lenient: number;
  anomaly: number;
}

export const tallyNegative = (
  stats: Map<string, NegativeTally>,
  anchors: string[],
  outcome: NegativeOutcome,
): void => {
  for (const anchor of anchors) {
    const entry = stats.get(anchor) ?? { rejected: 0, lenient: 0, anomaly: 0 };
    entry[outcome === "lenient" ? "lenient" : outcome === "anomaly" ? "anomaly" : "rejected"]++;
    stats.set(anchor, entry);
  }
};
