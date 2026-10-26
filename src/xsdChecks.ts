// Digit-count checks for the XSD totalDigits/fractionDigits facets, expressed
// as zod refinements in generated schemas. Both count digits of the numeric
// VALUE in canonical form (shortest round-trip representation), so neither
// 'e'/'-' nor leading/trailing zeros count — and 1.19 is not rejected for
// failing a float multipleOf(0.01).

import {
  parseXsdDatatype,
  writeXsdDatatype,
  type XsdDatatypeName,
  type XsdDate,
  type XsdDateTime,
  type XsdDuration,
  type XsdGDay,
  type XsdGMonth,
  type XsdGMonthDay,
  type XsdGYear,
  type XsdGYearMonth,
  type XsdStructuredValue,
  type XsdTime,
} from "./xsdDateTime.js";

const canonicalParts = (value: number): { digits: string; exponent: number } => {
  const abs = Math.abs(value);
  if (abs === 0) {
    return { digits: "0", exponent: 0 };
  }
  const [mantissa, exponent] = abs.toExponential().split("e");
  return {
    digits: mantissa?.replace(".", "").replace(/0+$/, "") || "0",
    exponent: Number(exponent ?? "0"),
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
// Exact order-facet comparison for xs:decimal. Both the facet boundary
// and the instance value can carry more significant digits than a double
// holds, so generated schemas compare the original decimal lexicals — scaled
// to integers and cross-multiplied in BigInt arithmetic — before the value is
// coerced to a JS number.
// ---------------------------------------------------------------------------

const DECIMAL_LEXICAL = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/;

// The XSD decimal lexical space (no exponent notation). The marker lets the
// runtime recognize string-backed decimal schemas even when the generated
// module and the runtime were loaded from separate builds (function identity
// is not stable across copies).
export type XsdDecimalLexical = ((value: string) => boolean) & {
  readonly xsdDecimalMarker: true;
};

export const xsdDecimalLexical: XsdDecimalLexical = Object.assign(
  (value: string): boolean => DECIMAL_LEXICAL.test(value),
  { xsdDecimalMarker: true } as const,
);

// Normalize a decimal lexical to an exact canonical form: no leading `+`, no
// leading integer zeros, no trailing fraction zeros, and `0` for every zero
// value. The value is unchanged because only representation is rewritten —
// unlike Number(), no significant digit is ever dropped.
export const canonicalDecimalLexical = (lexical: string): string => {
  const m = DECIMAL_LEXICAL.exec(lexical.trim());
  if (!m) {
    throw new Error(`Invalid xs:decimal lexical: ${JSON.stringify(lexical)}`);
  }
  const intPart = (m[2] ?? "0").replace(/^0+/, "") || "0";
  const fracPart = (m[3] ?? m[4] ?? "").replace(/0+$/, "");
  if (intPart === "0" && fracPart === "") {
    return "0";
  }
  return `${m[1] === "-" ? "-" : ""}${intPart}${fracPart === "" ? "" : `.${fracPart}`}`;
};

// Fraction digits of a decimal LEXICAL in value space: trailing zeros carry no
// value (1.100 is 1.1), so they do not count. Non-decimal lexicals (exponent
// notation) return 0 — other checks reject them.
export const countLexicalFractionDigits = (lexical: string): number => {
  const m = DECIMAL_LEXICAL.exec(lexical.trim());
  if (!m) {
    return 0;
  }
  return (m[3] ?? m[4] ?? "").replace(/0+$/, "").length;
};

// Total digits of a decimal LEXICAL in value space: positional zeros count
// (1200 has 4), but leading integer/fraction zeros and trailing fraction zeros
// do not (0.0012 has 2, 1.2300 has 3).
export const countLexicalTotalDigits = (lexical: string): number => {
  const m = DECIMAL_LEXICAL.exec(lexical.trim());
  if (!m) {
    return 0;
  }
  const intPart = m[2] ?? "0";
  const fracPart = (m[3] ?? m[4] ?? "").replace(/0+$/, "");
  const digits = `${intPart}${fracPart}`.replace(/^0+/, "");
  return digits.length === 0 ? 1 : digits.length;
};

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

// ---------------------------------------------------------------------------
// Order comparison for the ordered non-numeric builtins.
//
// The date/time family orders by value space (XSD 1.0 Part 2 §3.2.7.4): a
// present timezone is normalized to UTC, and a timezone-present value is
// compared against a timezone-absent one through the ±14:00 window, so
// genuinely indeterminate pairs reject. xs:duration follows its four
// reference-date partial order (§3.2.6.2). Strings compare by Unicode
// codepoint, not by UTF-16 code unit.
//
// Generated schemas call this from a refine; the value is either the original
// lexical (datatypes: "string") or the parsed object (datatypes: "structured"),
// so both shapes are accepted.
// ---------------------------------------------------------------------------

export type XsdOrderDatatype = XsdDatatypeName | "string";

const codepointCompare = (a: string, b: string): number => {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const l = left[i]?.codePointAt(0) ?? 0;
    const r = right[i]?.codePointAt(0) ?? 0;
    if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
};

const fractionCompare = (a: string | undefined, b: string | undefined): number => {
  const left = a ?? "";
  const right = b ?? "";
  const length = Math.max(left.length, right.length);
  const paddedLeft = left.padEnd(length, "0");
  const paddedRight = right.padEnd(length, "0");
  return paddedLeft < paddedRight ? -1 : paddedLeft > paddedRight ? 1 : 0;
};

const fieldCompare = (
  a: readonly (number | undefined)[],
  b: readonly (number | undefined)[],
): number => {
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
};

const hasTimezone = (value: XsdStructuredValue): boolean =>
  (value as { tzOffset?: number }).tzOffset !== undefined;

// Add the given timezone to a timezone-absent value by round-tripping through
// its canonical lexical (write never emits a timezone here, so the suffix is
// unambiguous). Parsing normalizes the result to UTC, like every explicit tz.
const withTimezone = (
  datatype: XsdDatatypeName,
  value: XsdStructuredValue,
  offset: "+14:00" | "-14:00",
): XsdStructuredValue =>
  parseXsdDatatype(datatype, `${writeXsdDatatype(datatype, value)}${offset}`);

const compareFields = (
  datatype: XsdDatatypeName,
  a: XsdStructuredValue,
  b: XsdStructuredValue,
): number => {
  switch (datatype) {
    case "date": {
      const x = a as XsdDate;
      const y = b as XsdDate;
      return fieldCompare([x.year, x.month, x.day], [y.year, y.month, y.day]);
    }
    case "dateTime": {
      const x = a as XsdDateTime;
      const y = b as XsdDateTime;
      const date = fieldCompare(
        [x.year, x.month, x.day, x.hour, x.minute, x.second],
        [y.year, y.month, y.day, y.hour, y.minute, y.second],
      );
      return date === 0 ? fractionCompare(x.fraction, y.fraction) : date;
    }
    case "time": {
      const x = a as XsdTime;
      const y = b as XsdTime;
      // Both sides are timezoned here: compare the normalized UTC instants,
      // keeping the day their normalization landed on (§3.2.7.4 step A).
      const time = fieldCompare(
        [x.dayOffset ?? 0, x.hour, x.minute, x.second],
        [y.dayOffset ?? 0, y.hour, y.minute, y.second],
      );
      return time === 0 ? fractionCompare(x.fraction, y.fraction) : time;
    }
    case "gYear": {
      const x = a as XsdGYear;
      const y = b as XsdGYear;
      return fieldCompare([x.year], [y.year]);
    }
    case "gYearMonth": {
      const x = a as XsdGYearMonth;
      const y = b as XsdGYearMonth;
      return fieldCompare([x.year, x.month], [y.year, y.month]);
    }
    case "gMonth": {
      const x = a as XsdGMonth;
      const y = b as XsdGMonth;
      return fieldCompare([x.month], [y.month]);
    }
    case "gMonthDay": {
      const x = a as XsdGMonthDay;
      const y = b as XsdGMonthDay;
      return fieldCompare([x.month, x.day], [y.month, y.day]);
    }
    case "gDay": {
      const x = a as XsdGDay;
      const y = b as XsdGDay;
      return fieldCompare([x.day], [y.day]);
    }
    case "duration":
      return compareDurations(a as XsdDuration, b as XsdDuration);
  }
};

// Seconds on an unwrapped axis: a timezoned value's UTC normalization can land
// on another day, and that day offset has to survive into the comparison (a
// floating value's ±14:00 window spans 28 hours, so the two operands must be
// measured on the same axis). Floating values carry no offset.
const timeSeconds = (value: XsdTime): number =>
  (value.dayOffset ?? 0) * 86400 + value.hour * 3600 + value.minute * 60 + value.second;

const compareTimeInstants = (
  secondsA: number,
  fractionA: string | undefined,
  secondsB: number,
  fractionB: string | undefined,
): number => {
  if (secondsA !== secondsB) {
    return secondsA < secondsB ? -1 : 1;
  }
  return fractionCompare(fractionA, fractionB);
};

// xs:time recurs every day, so a floating value's ±14:00 window can cross
// midnight (a floating 10:30 spans 20:30 the previous day through 00:30 the
// next), and a timezoned value's UTC normalization can land on another day.
// Both operands are therefore evaluated on an unwrapped axis instead of
// modulo 24h, so neither day offset collapses into the wrapped clock time.
const compareMixedTime = (a: XsdTime, b: XsdTime, aHasTimezone: boolean): number => {
  const window = 14 * 3600;
  if (aHasTimezone) {
    // a is timezoned, b is not: b's real instant spans [b-14:00, b+14:00].
    const aSeconds = timeSeconds(a);
    const earliest = timeSeconds(b) - window;
    const latest = timeSeconds(b) + window;
    if (compareTimeInstants(aSeconds, a.fraction, earliest, b.fraction) < 0) {
      return -1;
    }
    if (compareTimeInstants(aSeconds, a.fraction, latest, b.fraction) > 0) {
      return 1;
    }
    return Number.NaN;
  }
  // a is not timezoned, b is: a's real instant spans [a-14:00, a+14:00].
  const bSeconds = timeSeconds(b);
  const earliest = timeSeconds(a) - window;
  const latest = timeSeconds(a) + window;
  if (compareTimeInstants(latest, a.fraction, bSeconds, b.fraction) < 0) {
    return -1;
  }
  if (compareTimeInstants(earliest, a.fraction, bSeconds, b.fraction) > 0) {
    return 1;
  }
  return Number.NaN;
};

const compareDateTimeLike = (
  datatype: Exclude<XsdDatatypeName, "duration">,
  a: XsdStructuredValue,
  b: XsdStructuredValue,
): number => {
  const aHasTimezone = hasTimezone(a);
  const bHasTimezone = hasTimezone(b);
  if (aHasTimezone === bHasTimezone) {
    return compareFields(datatype, a, b);
  }
  if (datatype === "time") {
    return compareMixedTime(a as XsdTime, b as XsdTime, aHasTimezone);
  }
  if (aHasTimezone) {
    // a is timezoned, b is not: b's real instant spans [b+14:00, b-14:00].
    const earliest = withTimezone(datatype, b, "+14:00");
    const latest = withTimezone(datatype, b, "-14:00");
    if (compareFields(datatype, a, earliest) < 0) {
      return -1;
    }
    if (compareFields(datatype, a, latest) > 0) {
      return 1;
    }
    return Number.NaN;
  }
  // a is not timezoned, b is: a's real instant spans [a-14:00, a+14:00].
  const earliest = withTimezone(datatype, a, "+14:00");
  const latest = withTimezone(datatype, a, "-14:00");
  if (compareFields(datatype, latest, b) < 0) {
    return -1;
  }
  if (compareFields(datatype, earliest, b) > 0) {
    return 1;
  }
  return Number.NaN;
};

const astroYear = (year: bigint): bigint => (year < 0n ? year + 1n : year);

const floorDiv = (a: bigint, b: bigint): bigint => {
  const quotient = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? quotient - 1n : quotient;
};

// Proleptic Gregorian day number (Howard Hinnant's civil_from_days inverse).
const daysFromCivil = (year: bigint, month: bigint, day: bigint): bigint => {
  const shiftedYear = month <= 2n ? year - 1n : year;
  const era = floorDiv(shiftedYear, 400n);
  const yearOfEra = shiftedYear - era * 400n;
  const shiftedMonth = month > 2n ? month - 3n : month + 9n;
  const dayOfYear = (153n * shiftedMonth + 2n) / 5n + day - 1n;
  const dayOfEra = yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
  return era * 146097n + dayOfEra;
};

// The four reference dates from XSD 1.0 Part 2 §3.2.6.2.
const DURATION_REFERENCES: ReadonlyArray<readonly [bigint, bigint]> = [
  [1696n, 9n],
  [1697n, 2n],
  [1903n, 3n],
  [1903n, 7n],
];

interface DurationParts {
  months: bigint;
  seconds: bigint;
  scale: number;
}

const durationParts = (value: XsdDuration): DurationParts => {
  const sign = BigInt(value.sign);
  const months = BigInt((value.years ?? 0) * 12 + (value.months ?? 0));
  const wholeSeconds =
    BigInt(value.days ?? 0) * 86400n +
    BigInt(value.hours ?? 0) * 3600n +
    BigInt(value.minutes ?? 0) * 60n +
    BigInt(value.seconds ?? 0);
  const fractionDigits = value.fraction ?? "";
  const factor = 10n ** BigInt(fractionDigits.length);
  const fraction = fractionDigits === "" ? 0n : BigInt(fractionDigits);
  return {
    months: sign * months,
    seconds: sign * (wholeSeconds * factor + fraction),
    scale: fractionDigits.length,
  };
};

const scaledSeconds = (parts: DurationParts, scale: number): bigint =>
  parts.seconds * 10n ** BigInt(scale - parts.scale);

// Add the duration to a reference date (day 1) and express the result as an
// exact instant: whole days times 86400 plus the duration's seconds.
const durationInstant = (
  parts: DurationParts,
  commonScale: number,
  referenceYear: bigint,
  referenceMonth: bigint,
): bigint => {
  const totalMonths = referenceYear * 12n + (referenceMonth - 1n) + parts.months;
  const year = floorDiv(totalMonths, 12n);
  const month = totalMonths - year * 12n + 1n;
  const dayNumber = daysFromCivil(astroYear(year), month, 1n);
  const factor = 10n ** BigInt(commonScale);
  return dayNumber * 86400n * factor + scaledSeconds(parts, commonScale);
};

const compareDurations = (a: XsdDuration, b: XsdDuration): number => {
  const left = durationParts(a);
  const right = durationParts(b);
  const commonScale = Math.max(left.scale, right.scale);
  let allLess = true;
  let allGreater = true;
  let allEqual = true;
  for (const [year, month] of DURATION_REFERENCES) {
    const leftInstant = durationInstant(left, commonScale, year, month);
    const rightInstant = durationInstant(right, commonScale, year, month);
    allLess &&= leftInstant < rightInstant;
    allGreater &&= leftInstant > rightInstant;
    allEqual &&= leftInstant === rightInstant;
  }
  // The spec orders x < y only when every reference agrees strictly: a single
  // equal or opposite result is the indeterminate case (P1M vs P31D).
  return allLess ? -1 : allGreater ? 1 : allEqual ? 0 : Number.NaN;
};

const boundaryCache = new Map<string, XsdStructuredValue | undefined>();

const parsedBoundary = (
  datatype: XsdDatatypeName,
  boundary: string,
): XsdStructuredValue | undefined => {
  const key = `${datatype}\u0000${boundary}`;
  if (boundaryCache.has(key)) {
    return boundaryCache.get(key);
  }
  let parsed: XsdStructuredValue | undefined;
  try {
    parsed = parseXsdDatatype(datatype, boundary);
  } catch {
    parsed = undefined;
  }
  boundaryCache.set(key, parsed);
  return parsed;
};

// Negative/zero/positive as the instance value compares to the boundary;
// NaN when either side is invalid or the XSD partial order is indeterminate.
export const xsdOrderCompare = (
  datatype: XsdOrderDatatype,
  value: string | XsdStructuredValue,
  boundary: string,
): number => {
  if (datatype === "string") {
    return typeof value === "string" ? codepointCompare(value, boundary) : Number.NaN;
  }
  const parsed = parsedBoundary(datatype, boundary);
  if (parsed === undefined) {
    return Number.NaN;
  }
  let instance: XsdStructuredValue;
  try {
    instance = typeof value === "string" ? parseXsdDatatype(datatype, value) : value;
  } catch {
    return Number.NaN;
  }
  if (datatype === "duration") {
    return compareDurations(instance as XsdDuration, parsed as XsdDuration);
  }
  return compareDateTimeLike(datatype, instance, parsed);
};
