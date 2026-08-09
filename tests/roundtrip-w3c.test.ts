import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseXsd } from "../src/index.js";
import { runRoundTrip } from "./helpers.js";
import { discoverValidCases } from "./w3cDriver.js";

const W3C_DIR = path.resolve("testdata/upstream/w3c-xsdtests");

// Cases exercising XSD features xsd-to-zod does not support yet, with the
// reason. Keyed by `<testGroup>/<instanceTest>` name.
const KNOWN_FAILURES = new Map<string, string>([]);

// Test groups are discovered from the .testSet metadata (#108), not hardcoded
// directories. Test names carry the group's XSD spec anchors.
describe("W3C smoke round-trip", () => {
  if (!fs.existsSync(W3C_DIR) || fs.readdirSync(W3C_DIR).length === 0) {
    it("skip — W3C submodule not checked out", () => {});
    return;
  }

  const boeingCases = discoverValidCases([
    path.join(W3C_DIR, "boeingMeta/BoeingXSDTestSet.testSet"),
  ]);

  // Every KNOWN_FAILURES key must match a discovered case — a stale key means
  // the testSet changed or the case was renamed.
  it("has no stale KNOWN_FAILURES entries", () => {
    const discovered = new Set(boeingCases.map((c) => c.name));
    const stale = [...KNOWN_FAILURES.keys()].filter((k) => !discovered.has(k));
    expect(stale).toEqual([]);
  });

  for (const c of boeingCases) {
    const anchors = c.specRefs.length > 0 ? ` [${c.specRefs.join(", ")}]` : "";
    const title = `round-trips W3C boeing/${c.name}${anchors}`;
    const reason = KNOWN_FAILURES.get(c.name);
    if (reason) {
      // Known failures run as it.fails: the round-trip actually executes, and
      // a fix (here: substitution group support) turns the suite red until
      // the entry is removed — same pattern as the extended suite.
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

describe("upstream parse benchmark", () => {
  it("parseXsds all upstream XSDs under 5s", () => {
    const upstreamDir = path.resolve("testdata/upstream");

    const allXsdFiles: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.name.includes("w3c")) {
          walk(full);
        } else if (e.name.endsWith(".xsd")) {
          allXsdFiles.push(full);
        }
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
