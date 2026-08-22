// Digit-count checks for the XSD totalDigits/fractionDigits facets, expressed
// as zod refinements in generated schemas. Both count digits of the numeric
// VALUE in canonical form (shortest round-trip representation), so neither
// 'e'/'-' nor leading/trailing zeros count — and 1.19 is not rejected for
// failing a float multipleOf(0.01) (#69).

const canonicalParts = (value: number): { digits: string; exponent: number } => {
  const abs = Math.abs(value);
  if (abs === 0) {
    return { digits: "0", exponent: 0 };
  }
  const [mantissa, exponent] = abs.toExponential().split("e");
  return {
    digits: mantissa?.replace(".", "").replace(/0+$/, "") || "0",
    exponent: Number(exponent!),
  };
};

// Significant digits: exponent form is expanded so 1200 has 2 and 0.0012 has 2.
export const countTotalDigits = (value: number): number => {
  const { digits, exponent } = canonicalParts(value);
  return exponent >= 0 ? Math.max(digits.length, exponent + 1) : digits.length;
};

// Digits after the decimal point: 1.19 → 2, 0.07 → 2, 100 → 0.
export const countFractionDigits = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const { digits, exponent } = canonicalParts(value);
  return Math.max(0, digits.length - (exponent + 1));
};

export const xsdTotalDigits =
  (limit: number): ((value: number) => boolean) =>
  (value) =>
    !Number.isFinite(value) || countTotalDigits(value) <= limit;

export const xsdFractionDigits =
  (limit: number): ((value: number) => boolean) =>
  (value) =>
    !Number.isFinite(value) || countFractionDigits(value) <= limit;

// ---------------------------------------------------------------------------
// Exact order-facet comparison for xs:decimal (#136). Both the facet boundary
// and the instance value can carry more significant digits than a double
// holds, so generated schemas compare the original decimal lexicals — scaled
// to integers and cross-multiplied in BigInt arithmetic — before the value is
// coerced to a JS number.
// ---------------------------------------------------------------------------

const DECIMAL_LEXICAL = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/;

const decimalParts = (lexical: string): { neg: boolean; digits: bigint; scale: number } => {
  const m = DECIMAL_LEXICAL.exec(lexical.trim());
  if (!m) {
    throw new Error(`Invalid xs:decimal lexical: ${JSON.stringify(lexical)}`);
  }
  const intPart = m[2] ?? "0";
  const frac = m[3] ?? m[4] ?? "";
  const digits = BigInt(`${intPart}${frac}`);
  return { neg: m[1] === "-", digits, scale: frac.length };
};

// Compare two XSD decimal lexicals: negative/zero/positive as value is less
// than / equal to / greater than the boundary. Invalid lexicals compare to
// NaN so every order-facet refinement rejects them.
export const xsdDecimalCompare = (valueLexical: string, boundaryLexical: string): number => {
  let value: { neg: boolean; digits: bigint; scale: number };
  let boundary: { neg: boolean; digits: bigint; scale: number };
  try {
    value = decimalParts(valueLexical);
    boundary = decimalParts(boundaryLexical);
  } catch {
    return Number.NaN;
  }
  // -0 and 0.0 are not negative.
  const vNeg = value.neg && value.digits !== 0n;
  const bNeg = boundary.neg && boundary.digits !== 0n;
  if (vNeg !== bNeg) {
    return vNeg ? -1 : 1;
  }
  // Align scales: value = vDigits / 10^vScale, boundary = bDigits / 10^bScale.
  const vScaled = value.digits * 10n ** BigInt(boundary.scale);
  const bScaled = boundary.digits * 10n ** BigInt(value.scale);
  const cmp = vScaled > bScaled ? 1 : vScaled < bScaled ? -1 : 0;
  // Guard the sign flip: -cmp would yield -0 for an exact match.
  return vNeg && cmp !== 0 ? -cmp : cmp;
};
