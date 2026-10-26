import { parseXsd, readXmlFile } from "../src/index.js";
import type { W3cInvalidSchemaCase } from "./w3cDriver.js";

// Schema-validity outcome for a schema the suite marks invalid (XSD 1.0):
//   rejected — the zod tier rejects the schema (a pass). libxml2 may reject it
//              too or let it through; either way our tier matches the suite.
//   lenient  — the zod tier accepts while libxml2 (the conformance authority)
//              rejects: a codegen gap other tools catch, recorded for the report.
//   anomaly  — both tiers accept the schema: pinned as `it.fails` until fixed.
// A libxml2 accept combined with a zod-tier reject is therefore a pass, not an
// anomaly.
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
  if (codegenRejects) {
    return "rejected";
  }
  // The zod tier let a suite-invalid schema through: libxml2 catching it is a
  // documented leniency, both tiers accepting it is an anomaly.
  return libxmlAccepts ? "anomaly" : "lenient";
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
