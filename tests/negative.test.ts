import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { safeParseXml } from '../src/index.js';
import { findRootSchema, generateAndImport, readXmlFile } from './helpers.js';

const NEGATIVE_DIR = path.resolve('testdata/curated/negative');

type NegativeExpectation =
  // Parsing must succeed with exactly this result (pinned so silent data loss
  // becomes visible, #83).
  | { data: unknown }
  // Parsing must fail: `error` is a stable message substring; `zod: true`
  // pins a ZodError (validation failure), `zod: false` a plain structural
  // Error (root not found, invalid lexical, …).
  | { error: string; zod: boolean };

interface NegativeCase {
  name: string;
  xmlFile: string;
  expected: NegativeExpectation;
}

const EXPECTED: Record<string, NegativeExpectation> = {
  // Cardinality bounds are not expressible as zod checks on the array: extra
  // items are kept (the libxml2 tier is the strict one).
  'invalid-max-occurs': { data: { required: 'req', repeated: [1, 2, 3, 4, 5], '@must': 'abc' } },
  // Fewer items than minOccurs: kept as-is.
  'invalid-min-occurs': { data: { required: 'req', repeated: [1], '@must': 'abc' } },
  // A missing required element now fails the final schema validation.
  'invalid-missing-required-element': { error: 'Invalid input: expected string', zod: true },
  // Root in a foreign namespace is rejected structurally.
  'invalid-namespace': { error: "Root element '{urn:negative}strict' not found in XML payload", zod: false },
  // xsi:nil="true" on the root: content of a nilled element is dropped.
  'invalid-nil-with-content': { data: null },
  // Unknown elements are ignored.
  'invalid-unexpected-element': { data: { required: 'req', repeated: [1, 2], '@must': 'abc' } },
  // Order is not enforced: fields are matched by name.
  'invalid-wrong-element-order': { data: { first: 'wrong order', second: 42, third: true } },
};

function discoverNegativeCases(): NegativeCase[] {
  const cases: NegativeCase[] = [];
  for (const f of fs.readdirSync(NEGATIVE_DIR)) {
    if (f.endsWith('.xml')) {
      const name = f.replace(/\.xml$/, '');
      if (!(name in EXPECTED)) {
        throw new Error(`no pinned expectation for negative fixture ${f} — add one to EXPECTED`);
      }
      cases.push({ name, xmlFile: path.join(NEGATIVE_DIR, f), expected: EXPECTED[name] });
    }
  }
  return cases;
}

const negativeCases = discoverNegativeCases();

describe('negative — invalid XML handling', () => {
  const xsdPath = path.join(NEGATIVE_DIR, 'invalid.xsd');
  if (!fs.existsSync(xsdPath)) {
    it('skip — no negative test XSD found', () => {});
    return;
  }

  let mod: Record<string, unknown>;
  beforeAll(async () => {
    mod = await generateAndImport([xsdPath]);
  });

  for (const c of negativeCases) {
    const expected = c.expected;
    if ('error' in expected) {
      it(`rejects ${c.name}`, () => {
        const xml = readXmlFile(c.xmlFile);
        const schema = findRootSchema(mod, xml);

        const result = safeParseXml(schema, xml);
        expect(result.success).toBe(false);
        if (!result.success) {
          if (expected.zod) {
            expect(result.error).toBeInstanceOf(z.ZodError);
          } else {
            expect(result.error).toBeInstanceOf(Error);
            expect(result.error).not.toBeInstanceOf(z.ZodError);
          }
          expect((result.error as Error).message).toContain(expected.error);
        }
      });
    } else {
      it(`parses ${c.name} (pinned result)`, () => {
        const xml = readXmlFile(c.xmlFile);
        const schema = findRootSchema(mod, xml);

        const result = safeParseXml(schema, xml);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual(expected.data);
        }
      });
    }
  }
});
