import fs from "node:fs";
import path from "node:path";
import XMLParser from "@nodable/flexible-xml-parser";
import { describe, expect, it } from "vitest";
import { readXmlFile } from "../src/index.js";
import { splitQName } from "../src/qname.js";
import { createOutputBuilder } from "../src/runtime.js";
import { extractRootInfo, validateXmlAgainstSchemas } from "./helpers.js";
import { W3C_CORPUS_KNOWN_FAILURES, W3C_CORPUS_REASONS } from "./w3cCorpusKnownFailures.js";
import { discoverValidCases, type W3cCase } from "./w3cDriver.js";
import { REASONS, W3C_KNOWN_FAILURES } from "./w3cKnownFailures.js";

// A pin's reason is a claim about the world, and claims drift: a libxml2
// upgrade can close a gap, a codegen change can grow root coverage. This
// suite re-verifies each pin's stated reason, so a pin that stops being
// true breaks the build instead of silently becoming wrong documentation.
//
// - libxmlGap / libxmlStrictWildcardXsiType: the ORIGINAL instance must
//   still fail libxml2 validation against the original schemas.
// - noRootDeclaration: no schema of the case may declare a top-level
//   element matching the instance root.

const W3C_DIR = path.resolve("testdata/upstream/w3c-xsdtests");

type AnyNode = Record<string, unknown>;

const parser = new XMLParser({
  skip: { attributes: false },
  attributes: { prefix: "@_" },
  OutputBuilder: createOutputBuilder(),
});

const isNode = (value: unknown): value is AnyNode => value !== null && typeof value === "object";

const asArray = (value: unknown): unknown[] => {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const findCase = (testSetFile: string, group: string, instance: string): W3cCase => {
  const found = discoverValidCases([
    { file: testSetFile, groupFilter: new RegExp(`^${escapeRegExp(group)}$`) },
  ]).find((c) => c.name === `${group}/${instance}`);
  if (!found) {
    throw new Error(`pinned case no longer discovered: ${group}/${instance} in ${testSetFile}`);
  }
  return found;
};

// Corpus keys carry the testSet path: `<testSet-relative-path>/<group>/<instance>`.
const corpusCase = (key: string): W3cCase => {
  const segments = key.split("/");
  const instance = segments.pop();
  const group = segments.pop();
  if (instance === undefined || group === undefined || segments.length === 0) {
    throw new Error(`malformed corpus pin key: ${key}`);
  }
  return findCase(path.join(W3C_DIR, segments.join("/")), group, instance);
};

// Selection keys carry the testSet basename without extension:
// `<testSetName>/<group>/<instance>`; sun sets are `<name>.testSet`, ms sets
// `<name>_w3c.xml`.
const selectionCase = (key: string): W3cCase => {
  const [testSetName, group, instance, ...rest] = key.split("/");
  if (
    testSetName === undefined ||
    group === undefined ||
    instance === undefined ||
    rest.length > 0
  ) {
    throw new Error(`malformed selection pin key: ${key}`);
  }
  for (const candidate of [`sunMeta/${testSetName}.testSet`, `msMeta/${testSetName}_w3c.xml`]) {
    const file = path.join(W3C_DIR, candidate);
    if (fs.existsSync(file)) {
      return findCase(file, group, instance);
    }
  }
  throw new Error(`no testSet file resolves selection pin: ${key}`);
};

// Top-level element declarations of a schema document: {name, targetNamespace}.
const globalElementDecls = (xsdFile: string): { name: string; targetNamespace: string }[] => {
  const parsed = parser.parse(readXmlFile(xsdFile)) as AnyNode;
  const schemaKey = Object.keys(parsed).find((k) => splitQName(k).local === "schema");
  const schema = schemaKey === undefined ? undefined : parsed[schemaKey];
  if (!isNode(schema)) {
    throw new Error(`no schema root in ${xsdFile}`);
  }
  const targetNamespace =
    typeof schema["@_targetNamespace"] === "string" ? schema["@_targetNamespace"] : "";
  const decls: { name: string; targetNamespace: string }[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (splitQName(key).local !== "element") {
      continue;
    }
    for (const el of asArray(value)) {
      if (isNode(el) && typeof el["@_name"] === "string") {
        decls.push({ name: el["@_name"], targetNamespace });
      }
    }
  }
  return decls;
};

// The pin claims libxml2 rejects the original — so validating the original
// instance against the original schemas must throw.
const expectOriginalRejected = async (c: W3cCase): Promise<void> => {
  await expect(
    validateXmlAgainstSchemas(readXmlFile(c.xmlFile), c.xsdFiles, c.xmlFile),
  ).rejects.toThrow();
};

// The pin claims no global element matches the instance root, so there is no
// generated root schema to parse with.
const expectNoRootDeclaration = (c: W3cCase): void => {
  const root = extractRootInfo(readXmlFile(c.xmlFile));
  for (const xsdFile of c.xsdFiles) {
    for (const decl of globalElementDecls(xsdFile)) {
      expect(
        decl.name === root.local && decl.targetNamespace === root.namespace,
        `${xsdFile} now declares a global element matching the instance root ` +
          `<${root.local}> — the pin's no-root claim no longer holds`,
      ).toBe(false);
    }
  }
};

describe("W3C pin verification", () => {
  if (!fs.existsSync(W3C_DIR) || fs.readdirSync(W3C_DIR).length === 0) {
    it("skip — W3C submodule not checked out", () => {});
    return;
  }

  it("every selection pin uses a categorized reason", () => {
    const known = new Set<string>(Object.values(REASONS));
    const uncategorized = [...W3C_KNOWN_FAILURES.entries()].filter(([, r]) => !known.has(r));
    expect(uncategorized).toEqual([]);
  });

  it("every corpus pin uses a categorized reason", () => {
    const known = new Set<string>(Object.values(W3C_CORPUS_REASONS));
    const uncategorized = [...W3C_CORPUS_KNOWN_FAILURES.entries()].filter(([, r]) => !known.has(r));
    expect(uncategorized).toEqual([]);
  });

  for (const [key, reason] of W3C_KNOWN_FAILURES) {
    if (reason === REASONS.libxmlGap || reason === REASONS.libxmlStrictWildcardXsiType) {
      it(`selection pin ${key}: the original instance fails libxml2`, async () => {
        await expectOriginalRejected(selectionCase(key));
      }, 30_000);
    } else if (reason === REASONS.noRootDeclaration) {
      it(`selection pin ${key}: no global element matches the instance root`, () => {
        expectNoRootDeclaration(selectionCase(key));
      });
    }
  }

  for (const [key, reason] of W3C_CORPUS_KNOWN_FAILURES) {
    if (
      reason === W3C_CORPUS_REASONS.libxmlGap ||
      reason === W3C_CORPUS_REASONS.libxmlStrictWildcardXsiType
    ) {
      it(`corpus pin ${key}: the original instance fails libxml2`, async () => {
        await expectOriginalRejected(corpusCase(key));
      }, 30_000);
    } else if (reason === W3C_CORPUS_REASONS.noRootDeclaration) {
      it(`corpus pin ${key}: no global element matches the instance root`, () => {
        expectNoRootDeclaration(corpusCase(key));
      });
    }
  }
});
