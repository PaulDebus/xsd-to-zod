import { describe, expect, it } from "vitest";
import {
  countFractionDigits,
  countLexicalFractionDigits,
  countTotalDigits,
  xsdDecimalCompare,
  xsdFractionDigits,
  xsdOrderCompare,
  xsdTotalDigits,
} from "../src/xsdChecks.js";
import { parseXsdDatatype } from "../src/xsdDateTime.js";

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

describe("countLexicalFractionDigits", () => {
  it.each([
    ["100", 0],
    ["+1.0", 0],
    ["1.100", 1],
    ["1.19", 2],
    [".5", 1],
    ["-0.0700", 2],
    ["12345678912345678.9", 1],
    ["12345.6789123456789", 13],
    ["1e5", 0],
  ])("countLexicalFractionDigits(%s) === %s", (lexical, expected) => {
    expect(countLexicalFractionDigits(lexical)).toBe(expected);
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
    // Boundary digits beyond double precision compare exactly.
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

describe("xsdOrderCompare", () => {
  it("orders strings by codepoint", () => {
    expect(xsdOrderCompare("string", "a", "b")).toBe(-1);
    expect(xsdOrderCompare("string", "b", "a")).toBe(1);
    expect(xsdOrderCompare("string", "ab", "ab")).toBe(0);
    expect(xsdOrderCompare("string", "ab", "a")).toBe(1);
    // U+10000 is a single codepoint above U+E000, though its UTF-16
    // surrogate sorts before it.
    expect(xsdOrderCompare("string", "\u{10000}", "\uE000")).toBe(1);
  });

  it("compares date/time values in value space", () => {
    expect(xsdOrderCompare("date", "2002-06-01", "2002-01-01")).toBe(1);
    expect(xsdOrderCompare("date", "2002-01-01Z", "2002-01-01")).toBe(Number.NaN);
    expect(xsdOrderCompare("date", "2002-01-03Z", "2002-01-01")).toBe(1);
    expect(xsdOrderCompare("dateTime", "2002-10-10T12:00:00-05:00", "2002-10-10T17:00:00Z")).toBe(
      0,
    );
    // Fractional seconds order by value, not by lexical length.
    expect(xsdOrderCompare("dateTime", "2002-01-01T00:00:00.5", "2002-01-01T00:00:00.50")).toBe(0);
    expect(xsdOrderCompare("time", "12:00:00+01:00", "10:30:00Z")).toBe(1);
    expect(xsdOrderCompare("gYear", "2002", "2001")).toBe(1);
    expect(xsdOrderCompare("gYearMonth", "2002-02", "2002-01")).toBe(1);
    expect(xsdOrderCompare("gMonth", "--02", "--01")).toBe(1);
    expect(xsdOrderCompare("gMonthDay", "--02-01", "--01-31")).toBe(1);
    expect(xsdOrderCompare("gDay", "---02", "---01")).toBe(1);
  });

  it("accepts an already parsed structured value", () => {
    expect(xsdOrderCompare("date", parseXsdDatatype("date", "2002-06-01"), "2002-01-01")).toBe(1);
  });

  it("follows duration's partial order", () => {
    expect(xsdOrderCompare("duration", "PT6S", "PT5.999999999S")).toBe(1);
    expect(xsdOrderCompare("duration", "PT6S", "PT6.000S")).toBe(0);
    expect(xsdOrderCompare("duration", "P1M", "P30D")).toBe(Number.NaN);
    expect(xsdOrderCompare("duration", "P1M", "P32D")).toBe(-1);
    expect(xsdOrderCompare("duration", "P1Y", "P367D")).toBe(-1);
    expect(xsdOrderCompare("duration", "P1Y", "P364D")).toBe(1);
    expect(xsdOrderCompare("duration", "-P1D", "PT0S")).toBe(-1);
  });

  it("returns NaN for invalid lexicals", () => {
    expect(xsdOrderCompare("date", "not-a-date", "2002-01-01")).toBe(Number.NaN);
    expect(xsdOrderCompare("duration", "P1D", "nope")).toBe(Number.NaN);
    expect(xsdOrderCompare("string", 42 as unknown as string, "a")).toBe(Number.NaN);
  });
});
