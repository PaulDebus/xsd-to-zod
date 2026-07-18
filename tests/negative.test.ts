import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createRootHelpers } from '../src/index.js';
import { findRootMetadata, getRuntimeMetadata, readXmlFile } from './helpers.js';

const NEGATIVE_DIR = path.resolve('testdata/curated/negative');

interface NegativeCase {
  name: string;
  xmlFile: string;
  // 'throw' when parsing must fail; otherwise the exact expected parse result.
  expected: 'throw' | unknown;
}

// Invalid input must not only "not crash" — the parsed result is pinned so
// silent data loss becomes visible (#83).
const EXPECTED: Record<string, 'throw' | unknown> = {
  // Runtime is lenient about cardinality: extra items are kept.
  'invalid-max-occurs': { required: 'req', repeated: [1, 2, 3, 4, 5], '@must': 'abc' },
  // Fewer items than minOccurs: kept as-is.
  'invalid-min-occurs': { required: 'req', repeated: [1], '@must': 'abc' },
  // Missing required element is absent from the result.
  'invalid-missing-required-element': { optional: 'present', repeated: [1, 2], '@must': 'abc' },
  // Root in a foreign namespace is rejected.
  'invalid-namespace': 'throw',
  // xsi:nil="true" on the root: content of a nilled element is dropped.
  'invalid-nil-with-content': null,
  // Unknown elements are ignored.
  'invalid-unexpected-element': { required: 'req', repeated: [1, 2], '@must': 'abc' },
  // Order is not enforced: fields are matched by name.
  'invalid-wrong-element-order': { first: 'wrong order', second: 42, third: true },
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

  const runtimeMetadata = getRuntimeMetadata([xsdPath]);

  for (const c of negativeCases) {
    if (c.expected === 'throw') {
      it(`rejects ${c.name}`, () => {
        const xml = readXmlFile(c.xmlFile);
        const rootMeta = findRootMetadata(runtimeMetadata, xml);

        const { parseXml } = createRootHelpers<Record<string, unknown>>(rootMeta, runtimeMetadata.types);
        expect(() => parseXml(xml)).toThrow();
      });
    } else {
      it(`leniently parses ${c.name} (pinned result)`, () => {
        const xml = readXmlFile(c.xmlFile);
        const rootMeta = findRootMetadata(runtimeMetadata, xml);

        const { parseXml } = createRootHelpers<Record<string, unknown>>(rootMeta, runtimeMetadata.types);
        expect(parseXml(xml)).toEqual(c.expected);
      });
    }
  }
});
