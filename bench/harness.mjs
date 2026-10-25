// Performance harness: measure parseXml / safeParseXml / serializeXml
// against a real UBL Invoice document + schema. Reports per-phase timings and
// heap deltas, with an optional V8 CPU profile dump. Run with:
//
//   node bench/harness.mjs [--iterations N] [--copies N] [--only PHASES]
//                           [--profile] [--out DIR]
//
// --only accepts a comma-separated subset of the timed phases (parseXsdOnce,
// irToZodOnce, parseXml, safeParseXml, serializeXml); use it to scope a
// --profile run to one phase. The document is amplified by replicating the
// (maxOccurs unbounded) InvoiceLine children, so the generated schema stays
// fixed while runtime cost scales.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

// ---- args ----
const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const iterations = Number(argOf("--iterations", "20"));
const copies = Number(argOf("--copies", "200"));
const profile = argv.includes("--profile");
const outDir = argOf("--out", path.join(root, "bench", "out"));
const ALL_PHASES = ["parseXsdOnce", "irToZodOnce", "parseXml", "safeParseXml", "serializeXml"];
const only = new Set(
  argOf("--only", "")
    .split(",")
    .map((phase) => phase.trim())
    .filter(Boolean),
);
for (const phase of only) {
  if (!ALL_PHASES.includes(phase)) {
    throw new Error(`unknown --only phase "${phase}" (expected ${ALL_PHASES.join(", ")})`);
  }
}

const XSD_DIR = path.join(root, "testdata", "upstream", "oasis-ubl-2.4", "xsdrt");
const XML_FILE = path.join(
  root,
  "testdata",
  "upstream",
  "oasis-ubl-2.4",
  "xml",
  "UBL-Invoice-2.1-Example.xml",
);

const XSD_FILES = [
  "maindoc/UBL-Invoice-2.4.xsd",
  "common/UBL-CommonAggregateComponents-2.4.xsd",
  "common/UBL-CommonBasicComponents-2.4.xsd",
  "common/UBL-CommonExtensionComponents-2.4.xsd",
  "common/UBL-CommonSignatureComponents-2.4.xsd",
  "common/UBL-SignatureAggregateComponents-2.4.xsd",
  "common/UBL-SignatureBasicComponents-2.4.xsd",
  "common/UBL-QualifiedDataTypes-2.4.xsd",
  "common/UBL-ExtensionContentDataType-2.4.xsd",
  "common/BDNDR-CCTS_CCT_SchemaModule-1.1.xsd",
  "common/BDNDR-UnqualifiedDataTypes-1.1.xsd",
].map((p) => path.join(XSD_DIR, p));

const ROOT_QNAME = "{urn:oasis:names:specification:ubl:schema:xsd:Invoice-2}Invoice";
const INDEX_FILE = path.join(root, "dist", "index.js");

// The runner is written to bench/out and executed with plain node (it imports
// compiled JS from dist/); regex backslashes inside the template below are
// preserved verbatim via String.raw.
const runnerSource = String.raw`
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { performance } from "node:perf_hooks";
import {
  parseXsd,
  irToZod,
  parseXml,
  safeParseXml,
  serializeXml,
  xmlRegistry,
} from ${JSON.stringify(INDEX_FILE)};

const xsdFiles = ${JSON.stringify(XSD_FILES)};
const xmlFile = ${JSON.stringify(XML_FILE)};
const copies = ${JSON.stringify(copies)};
const iterations = ${JSON.stringify(iterations)};
const rootQName = ${JSON.stringify(ROOT_QNAME)};
const only = new Set(${JSON.stringify([...only])});

function importGenerated(schemasCode) {
  const base = path.join(process.cwd(), ".xsd-to-zod-bench");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "schema-"));
  const file = path.join(dir, "schema.zod.ts");
  fs.writeFileSync(file, schemasCode);
  try {
    return import(url.pathToFileURL(file).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// strip prolog/doctype/comment noise, keep the document element
const base = fs.readFileSync(xmlFile, "utf8");
const cleaned = base
  .replace(/<\?[\s\S]*?\?>/, "")
  .replace(/<!DOCTYPE[^>\[]*(\[[\s\S]*?\])?[^>]*>/i, "")
  .replace(/<!--[\s\S]*?-->/g, "");

// Replicate the (maxOccurs unbounded) InvoiceLine children to amplify
// runtime cost while keeping the document valid against the fixed schema.
const lineSource = "<cac:InvoiceLine[\\s\\S]*?<\\/cac:InvoiceLine>";
const lineRe = new RegExp(lineSource, "g");
const invoiceLines = cleaned.match(lineRe) ?? [];
if (invoiceLines.length === 0) throw new Error("no InvoiceLine elements found");
const doc = cleaned.replace(
  new RegExp("(?:" + lineSource + ")+"),
  invoiceLines.join("").repeat(copies),
);

// heapDeltaBytes is *retained* memory: GC runs on both sides so the value
// excludes garbage the phase produced and already collected. Allocation churn
// shows up as GC samples in a --profile run rather than in this delta.
function timed(name, fn) {
  globalThis.gc?.();
  fn(); // warmup
  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const t1 = performance.now();
  globalThis.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;
  return {
    totalMs: +(t1 - t0).toFixed(2),
    perIterMs: +((t1 - t0) / iterations).toFixed(3),
    heapDeltaBytes: heapAfter - heapBefore,
  };
}

const schema = await parseXsd(xsdFiles);
const mod = await importGenerated(irToZod(schema, {}).schemas);
const rootSchema = Object.values(mod).find(
  (v) =>
    v !== null &&
    typeof v === "object" &&
    "_zod" in v &&
    xmlRegistry.get(v)?.root === rootQName,
);
if (rootSchema === undefined) {
  throw new Error("no root schema for " + rootQName);
}

const parsed = parseXml(rootSchema, doc);
const serialized = serializeXml(rootSchema, parsed);

const phaseRuns = {
  parseXsdOnce: () => parseXsd(xsdFiles),
  irToZodOnce: () => irToZod(schema, {}),
  parseXml: () => parseXml(rootSchema, doc),
  safeParseXml: () => safeParseXml(rootSchema, doc),
  serializeXml: () => serializeXml(rootSchema, parsed),
};

const selected = (phase) => only.size === 0 || only.has(phase);
const results = {};
for (const [phase, run] of Object.entries(phaseRuns)) {
  if (selected(phase)) results[phase] = timed(phase, run);
}

// round-trip sanity: re-parse the serialized output once and re-serialize
const reparsed = parseXml(rootSchema, serialized);
const roundTripStable = serializeXml(rootSchema, reparsed) === serialized;

console.log(JSON.stringify({
  meta: {
    documentBytes: Buffer.byteLength(doc),
    serializedBytes: Buffer.byteLength(serialized),
    invoiceLines: invoiceLines.length * copies,
    copies,
    iterations,
    phases: Object.keys(results),
    roundTripStable,
    node: process.version,
  },
  results,
}, null, 2));
`;

fs.mkdirSync(outDir, { recursive: true });
const runnerPath = path.join(outDir, "runner.mjs");
fs.writeFileSync(runnerPath, runnerSource);

// The runner only imports compiled JS from dist/, so plain node suffices
// (and --cpu-prof then profiles the actual work instead of a tsx wrapper).
const nodeArgs = ["--expose-gc", runnerPath];
if (profile) {
  nodeArgs.unshift(
    "--cpu-prof",
    `--cpu-prof-dir=${outDir}`,
    "--cpu-prof-interval=500",
  );
}

const result = spawnSync(process.execPath, nodeArgs, {
  cwd: root,
  encoding: "utf8",
  env: process.env,
  maxBuffer: 1024 * 1024 * 64,
});
if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}
console.log(result.stdout);

if (profile) {
  const profiles = fs.readdirSync(outDir).filter((f) => f.endsWith(".cpuprofile"));
  console.log(`CPU profile(s): ${profiles.map((f) => path.join(outDir, f)).join(", ")}`);
}
