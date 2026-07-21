import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { irToZod, parseXsd, safeParseXml } from '../src/index.js';
import { findRootSchema, importGeneratedSchemas, readXmlFile } from './helpers.js';

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
  // Bounded cardinality: maxOccurs=4 but XML has 5 items.
  'invalid-max-occurs': { error: '<=4 items', zod: true },
  // Bounded cardinality: minOccurs=2 but XML has 1 item.
  'invalid-min-occurs': { error: '>=2 items', zod: true },
  // A missing required element fails the final schema validation.
  'invalid-missing-required-element': { error: 'Invalid input: expected string', zod: true },
  // Root in a foreign namespace is rejected structurally.
  'invalid-namespace': { error: "Root element '{urn:negative}strict' not found in XML payload", zod: false },
  // xsi:nil="true" on the root: content of a nilled element is dropped.
  'invalid-nil-with-content': { data: null },
  // Unknown elements are silently tolerated (xs:any wildcards not yet supported).
  'invalid-unexpected-element': { data: { required: 'req', repeated: [1, 2], '@must': 'abc' } },
  // Element order is enforced as a subsequence of the declared field order:
  // 'first' appears after 'second' in the XML, violating [first, second, third].
  'invalid-wrong-element-order': { error: "Element 'first' out of order", zod: false },
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
    mod = await importGeneratedSchemas(irToZod(parseXsd([xsdPath])).schemas);
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
