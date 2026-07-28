import { describe, expect, it } from "vitest";
import {
  countFractionDigits,
  countTotalDigits,
  xsdDecimalCompare,
  xsdFractionDigits,
  xsdTotalDigits,
} from "../src/xsdChecks.js";

// Direct unit tests for the digit-count checks: generated code imports these
// from the installed 'xsd-to-zod' package (dist/), so only direct src imports
// exercise them for coverage.
describe("countTotalDigits", () => {
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
  ])("countTotalDigits(%s) === %s", (value, expected) => {
    expect(countTotalDigits(value)).toBe(expected);
  });
});

describe("countFractionDigits", () => {
  it.each([
    [1.19, 2],
    [0.07, 2],
    [100, 0],
    [1.5, 1],
  ])("countFractionDigits(%s) === %s", (value, expected) => {
    expect(countFractionDigits(value)).toBe(expected);
  });

  it("treats non-finite numbers as having no fraction digits", () => {
    expect(countFractionDigits(Infinity)).toBe(0);
    expect(countFractionDigits(-Infinity)).toBe(0);
    expect(countFractionDigits(NaN)).toBe(0);
  });
});

describe("xsdTotalDigits / xsdFractionDigits refinements", () => {
  it("accepts values within the limit and rejects beyond it", () => {
    expect(xsdTotalDigits(5)(99999)).toBe(true);
    expect(xsdTotalDigits(5)(123456)).toBe(false);
    expect(xsdFractionDigits(2)(19.99)).toBe(true);
    expect(xsdFractionDigits(2)(19.999)).toBe(false);
  });

  it("accepts non-finite numbers (the libxml2 tier owns exact semantics)", () => {
    expect(xsdTotalDigits(1)(Infinity)).toBe(true);
    expect(xsdTotalDigits(1)(NaN)).toBe(true);
    expect(xsdFractionDigits(0)(-Infinity)).toBe(true);
  });
});

describe("xsdDecimalCompare", () => {
  it.each([
    // Ordinary comparisons.
    ["1.5", "1.4", 1],
    ["1.5", "1.5", 0],
    ["1.5", "1.6", -1],
    ["-273.15", "-273.15", 0],
    ["-1", "-2", 1],
    ["0", "-0.0", 0],
    ["-0", "0", 0],
    // Lexical forms: leading/trailing zeros, missing int or fraction part.
    [".5", "0.5", 0],
    ["5.", "5.0", 0],
    ["+007", "7", 0],
    // The #136 case: boundary digits beyond double precision compare exactly.
    ["1000000000000000000", "999999999999999999.488264", 1],
    ["999999999999999999", "999999999999999999.488264", -1],
    ["-1000000000000000000", "-999999999999999999.488264", -1],
    ["1000000000000000000", "1000000000000000000.000001", -1],
    // 53-bit edge: 2^53 vs 2^53 + 1 (indistinguishable as doubles).
    ["9007199254740992", "9007199254740993", -1],
    ["9007199254740992", "9007199254740992", 0],
    // Signs and zeros.
    ["1", "-999999999999999999999", 1],
    ["-1", "999999999999999999999", -1],
    ["0", "0.00000000000000000001", -1],
    ["0.00000000000000000001", "0", 1],
  ])("xsdDecimalCompare(%s, %s) === %s", (value, boundary, expected) => {
    expect(Math.sign(xsdDecimalCompare(value, boundary))).toBe(expected);
  });

  it("rejects invalid lexicals through every comparison", () => {
    for (const bad of ["1.2.3", "1e3", "abc", ""]) {
      const cmp = xsdDecimalCompare(bad, "0");
      for (const result of [cmp > 0, cmp >= 0, cmp < 0, cmp <= 0, cmp === 0]) {
        expect(result, bad).toBe(false);
      }
    }
  });
});
