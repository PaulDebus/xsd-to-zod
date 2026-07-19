// Digit-count checks for the XSD totalDigits/fractionDigits facets, expressed
// as zod refinements in generated schemas. Both count digits of the numeric
// VALUE in canonical form (shortest round-trip representation), so neither
// 'e'/'-' nor leading/trailing zeros count — and 1.19 is not rejected for
// failing a float multipleOf(0.01) (#69).

const canonicalParts = (value: number): { digits: string; exponent: number } => {
  const abs = Math.abs(value);
  if (abs === 0) {
    return { digits: '0', exponent: 0 };
  }
  const [mantissa, exponent] = abs.toExponential().split('e');
  return { digits: mantissa.replace('.', '').replace(/0+$/, '') || '0', exponent: Number(exponent) };
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

export const xsdTotalDigits = (limit: number): ((value: number) => boolean) =>
  (value) => !Number.isFinite(value) || countTotalDigits(value) <= limit;

export const xsdFractionDigits = (limit: number): ((value: number) => boolean) =>
  (value) => !Number.isFinite(value) || countFractionDigits(value) <= limit;
