import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createRootHelpers } from '../src/index.js';
import { findRootMetadata, getRuntimeMetadata } from './helpers.js';

const NEGATIVE_DIR = path.resolve('testdata/curated/negative');

interface NegativeCase {
  name: string;
  xmlFile: string;
  expectedToThrow: boolean;
}

function discoverNegativeCases(): NegativeCase[] {
  const cases: NegativeCase[] = [];
  for (const f of fs.readdirSync(NEGATIVE_DIR)) {
    if (f.endsWith('.xml')) {
      cases.push({
        name: f.replace(/\.xml$/, ''),
        xmlFile: path.join(NEGATIVE_DIR, f),
        expectedToThrow: f.includes('namespace'),
      });
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
    if (c.expectedToThrow) {
      it(`rejects ${c.name}`, () => {
        const xml = fs.readFileSync(c.xmlFile, 'utf8');
        const rootMeta = findRootMetadata(runtimeMetadata, xml);

        const { parseXml } = createRootHelpers<Record<string, unknown>>(rootMeta, runtimeMetadata.types);
        expect(() => parseXml(xml)).toThrow();
      });
    } else {
      it(`gracefully handles ${c.name} (no throw — lenient validation)`, () => {
        const xml = fs.readFileSync(c.xmlFile, 'utf8');
        const rootMeta = findRootMetadata(runtimeMetadata, xml);

        const { parseXml } = createRootHelpers<Record<string, unknown>>(rootMeta, runtimeMetadata.types);
        expect(() => parseXml(xml)).not.toThrow();
      });
    }
  }
});
