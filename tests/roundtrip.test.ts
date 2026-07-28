import fs from "node:fs";
import { describe, it } from "vitest";
import { discoverCuratedCases, runRoundTrip } from "./helpers.js";

// Golden assertions on the parsed object, so symmetric silent data loss in
// parseXml/serializeXml cannot pass undetected (#83). JSON cannot represent
// bigint, so xs:integer-family values are encoded as { "$bigint": "<digits>" }.
function goldenFor(xmlFile: string): unknown {
  const goldenFile = xmlFile.replace(/\.xml$/, ".expected.json");
  if (!fs.existsSync(goldenFile)) {
    throw new Error(`missing golden file: ${goldenFile}`);
  }
  return JSON.parse(fs.readFileSync(goldenFile, "utf8"), (_key, value: unknown) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const marker = (value as Record<string, unknown>)["$bigint"];
      if (typeof marker === "string" && Object.keys(value).length === 1) {
        return BigInt(marker);
      }
    }
    return value;
  }) as unknown;
}

const curatedCases = discoverCuratedCases();

describe("curated round-trip", () => {
  for (const c of curatedCases) {
    it(`round-trips ${c.name}`, async () => {
      await runRoundTrip(c.xsdFiles, c.xmlFile, goldenFor(c.xmlFile));
    });
  }
});
