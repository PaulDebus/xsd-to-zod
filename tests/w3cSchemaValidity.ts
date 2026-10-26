import { parseXsd, readXmlFile } from "../src/index.js";
import type { W3cInvalidSchemaCase } from "./w3cDriver.js";

// Schema-validity outcome: both tiers reject (pass), the zod tier accepts while
// libxml2 rejects (documented leniency), or libxml2 accepts a schema the suite
// marks invalid (anomaly — pinned).
export type SchemaValidityOutcome = "rejected" | "lenient" | "anomaly";

// libxml2 (the conformance authority) rejects the schema when any document of
// the schemaTest fails to compile.
export const libxmlAcceptsSchema = async (xsdFiles: string[]): Promise<boolean> => {
  const { validateSchema } = await import("../src/validate.js");
  for (const file of xsdFiles) {
    if (!(await validateSchema(readXmlFile(file), { url: file })).valid) {
      return false;
    }
  }
  return true;
};

export const codegenRejectsSchema = async (xsdFiles: string[]): Promise<boolean> => {
  try {
    await parseXsd(xsdFiles);
    return false;
  } catch {
    return true;
  }
};

export const evaluateInvalidSchemaCase = async (
  c: W3cInvalidSchemaCase,
): Promise<SchemaValidityOutcome> => {
  const libxmlAccepts = await libxmlAcceptsSchema(c.xsdFiles);
  const codegenRejects = await codegenRejectsSchema(c.xsdFiles);
  if (libxmlAccepts) {
    return "anomaly";
  }
  return codegenRejects ? "rejected" : "lenient";
};

export interface SchemaValidityTally {
  rejected: number;
  lenient: number;
  anomaly: number;
}

export const tallySchemaValidity = (
  stats: Map<string, SchemaValidityTally>,
  anchors: string[],
  outcome: SchemaValidityOutcome,
): void => {
  for (const anchor of anchors) {
    const entry = stats.get(anchor) ?? { rejected: 0, lenient: 0, anomaly: 0 };
    entry[outcome]++;
    stats.set(anchor, entry);
  }
};
