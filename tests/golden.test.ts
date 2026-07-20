import { describe, expect, it } from 'vitest';
import { irToZod, parseXsd } from '../src/index.js';
import { discoverCuratedCases } from './helpers.js';

// Golden output assertions (#84): the full generated module for one
// representative case per curated category, so every codegen change shows up
// as a reviewable snapshot diff.
const seen = new Set<string>();
const representative = discoverCuratedCases().filter((c) => {
  const key = c.xsdFiles.join('|');
  if (seen.has(key)) {
    return false;
  }
  seen.add(key);
  return true;
});

describe('golden generated output (#84)', () => {
  for (const c of representative) {
    it(`matches the golden output for ${c.name}`, () => {
      expect(irToZod(parseXsd(c.xsdFiles)).schemas).toMatchSnapshot();
    });
  }
});
