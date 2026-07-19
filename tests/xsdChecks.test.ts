import { describe, expect, it } from 'vitest';
import { countFractionDigits, countTotalDigits, xsdFractionDigits, xsdTotalDigits } from '../src/xsdChecks.js';

// Direct unit tests for the digit-count checks: generated code imports these
// from the installed 'xsd-to-zod' package (dist/), so only direct src imports
// exercise them for coverage.
describe('countTotalDigits', () => {
  it.each([
    [0, 1],
    [5, 1],
    [99999, 5],
    [123456, 6],
    // Trailing zeros in the integer part count (XSD totalDigits is not
    // "significant digits"): 1200 has 4 total digits.
    [1200, 4],
    // …but leading zeros after the decimal point do not: 0.0012 has 2.
    [0.0012, 2],
    [-123.45, 5],
  ])('countTotalDigits(%s) === %s', (value, expected) => {
    expect(countTotalDigits(value)).toBe(expected);
  });
});

describe('countFractionDigits', () => {
  it.each([
    [1.19, 2],
    [0.07, 2],
    [100, 0],
    [1.5, 1],
  ])('countFractionDigits(%s) === %s', (value, expected) => {
    expect(countFractionDigits(value)).toBe(expected);
  });

  it('treats non-finite numbers as having no fraction digits', () => {
    expect(countFractionDigits(Infinity)).toBe(0);
    expect(countFractionDigits(-Infinity)).toBe(0);
    expect(countFractionDigits(NaN)).toBe(0);
  });
});

describe('xsdTotalDigits / xsdFractionDigits refinements', () => {
  it('accepts values within the limit and rejects beyond it', () => {
    expect(xsdTotalDigits(5)(99999)).toBe(true);
    expect(xsdTotalDigits(5)(123456)).toBe(false);
    expect(xsdFractionDigits(2)(19.99)).toBe(true);
    expect(xsdFractionDigits(2)(19.999)).toBe(false);
  });

  it('accepts non-finite numbers (the libxml2 tier owns exact semantics)', () => {
    expect(xsdTotalDigits(1)(Infinity)).toBe(true);
    expect(xsdTotalDigits(1)(NaN)).toBe(true);
    expect(xsdFractionDigits(0)(-Infinity)).toBe(true);
  });
});
