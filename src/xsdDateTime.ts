// Structured value-space representation of the XSD 1.0 date/time builtins,
// used when codegen runs with datatypes: "structured". Generated schemas stay
// `z.string().refine(xsdX).transform(parseXsdX)`, so the parsers here only
// ever see lexically valid input (plus surrounding whitespace, which the
// validators already collapse without storing).
//
// Value-preserving normalization at parse time. Writers emit stable, valid
// lexicals; partial dates retain their offset instead of truncating UTC fields.
// parse(write(parse(x))) deep-equals parse(x), except for
// xs:time's order-only `dayOffset`, which the canonical lexical cannot carry):
// - xs:dateTime and xs:time with a present timezone are converted to UTC and
//   kept as tzOffset: 0 ("Z", "+00:00" and "-00:00" collapse); tzOffset
//   absent means floating. Those two types carry the full instant, so no
//   information is lost.
// - xs:date and the xs:g* partial types keep their original local components
//   and carry the actual offset (minutes east of UTC) in tzOffset. Normalizing
//   them to UTC would shift the calendar fields and change the value (a date
//   is an interval anchored at local midnight, not an instant). tzOffset
//   absent means floating; 0 means UTC.
// - xs:time 24:00:00 becomes 00:00:00; xs:dateTime 24:00:00 rolls into the
//   next day's 00:00:00.
// - fractional seconds lose trailing zeros (dropped entirely when zero).
// - duration zero components are dropped; an all-zero duration has sign 1.

import { collapseWhiteSpace, DAY, DURATION_RE, MONTH, TZ, YEAR } from "./xsdLexicals.js";

export type XsdDate = { year: number; month: number; day: number; tzOffset?: number };
export type XsdDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  fraction?: string;
  tzOffset?: number;
};
// xs:time has no date, so UTC normalization wraps within the day. The offset
// is still needed for ordering: a timezoned value is compared against a
// floating one through the ±14:00 window, which recurs daily, so the day the
// normalization landed on has to survive modulo 24h. Present (and nonzero)
// only when a timezone is given and the normalization crossed midnight; the
// canonical lexical form stays the wrapped time of day.
export type XsdTime = {
  hour: number;
  minute: number;
  second: number;
  fraction?: string;
  tzOffset?: number;
  dayOffset?: number;
};
export type XsdGYear = { year: number; tzOffset?: number };
export type XsdGYearMonth = { year: number; month: number; tzOffset?: number };
export type XsdGMonth = { month: number; tzOffset?: number };
export type XsdGMonthDay = { month: number; day: number; tzOffset?: number };
export type XsdGDay = { day: number; tzOffset?: number };
export type XsdDuration = {
  sign: 1 | -1;
  years?: number;
  months?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  fraction?: string;
};

export type XsdStructuredValue =
  | XsdDate
  | XsdDateTime
  | XsdTime
  | XsdGYear
  | XsdGYearMonth
  | XsdGMonth
  | XsdGMonthDay
  | XsdGDay
  | XsdDuration;

export type XsdDatatypeName =
  | "date"
  | "dateTime"
  | "time"
  | "gYear"
  | "gYearMonth"
  | "gMonth"
  | "gMonthDay"
  | "gDay"
  | "duration";

// Timezone wrapped in a capture group; the time body captures hh/mm/ss/frac.
// Input is already lexically valid (the refine runs before the transform), so
// the time shape does not re-check ranges.
const TZ_C = String.raw`(${TZ})`;
const TIME_C = String.raw`(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?`;

const DATE_RE = new RegExp(String.raw`^(${YEAR})-(${MONTH})-(${DAY})${TZ_C}?$`);
const DATE_TIME_RE = new RegExp(String.raw`^(${YEAR})-(${MONTH})-(${DAY})T${TIME_C}${TZ_C}?$`);
const TIME_RE = new RegExp(String.raw`^${TIME_C}${TZ_C}?$`);
const G_YEAR_RE = new RegExp(String.raw`^(${YEAR})${TZ_C}?$`);
const G_YEAR_MONTH_RE = new RegExp(String.raw`^(${YEAR})-(${MONTH})${TZ_C}?$`);
const G_MONTH_RE = new RegExp(String.raw`^--(${MONTH})(?:--)?${TZ_C}?$`);
const G_MONTH_DAY_RE = new RegExp(String.raw`^--(${MONTH})-(${DAY})${TZ_C}?$`);
const G_DAY_RE = new RegExp(String.raw`^---(${DAY})${TZ_C}?$`);

const fail = (datatype: string, value: string): never => {
  throw new Error(`invalid xs:${datatype} lexical: ${JSON.stringify(value)}`);
};

const mustExec = (re: RegExp, value: string, datatype: string): RegExpExecArray => {
  const m = re.exec(collapseWhiteSpace(value));
  if (!m || m[1] === undefined) {
    fail(datatype, value);
  }
  return m as RegExpExecArray;
};

// Timezone designator → minutes east of UTC; undefined when floating.
const tzMinutes = (tz: string | undefined): number | undefined => {
  if (tz === undefined) {
    return undefined;
  }
  if (tz === "Z") {
    return 0;
  }
  const sign = tz.startsWith("-") ? -1 : 1;
  const minutes = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(4, 6)));
  // "-00:00" is the same value as UTC; avoid carrying a negative zero.
  return minutes === 0 ? 0 : minutes;
};

// Trailing zeros carry no value; a zero fraction is dropped entirely.
const fraction = (digits: string | undefined): string | undefined =>
  digits?.replace(/0+$/, "") || undefined;

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const monthDays = (year: number, month: number): number => {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

// No year zero in XSD 1.0: the calendar steps 1 → -1 and back.
const prevYear = (year: number): number => (year === 1 ? -1 : year - 1);
const nextYear = (year: number): number => (year === -1 ? 1 : year + 1);

const parseYear = (raw: string | undefined): number => {
  const year = Number(raw);
  if (!Number.isSafeInteger(year)) {
    throw new Error(
      "Structured XSD years must be safe integers; use the string datatype mapping for larger years",
    );
  }
  return year;
};

// Shift a local date-time to UTC by subtracting the offset (minutes east of
// UTC). Also normalizes hour 24 (xs:dateTime midnight) when offset is 0.
const toUtc = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  offsetMinutes: number,
): { year: number; month: number; day: number; hour: number; minute: number } => {
  let total = hour * 60 + minute - offsetMinutes;
  const dayShift = Math.floor(total / 1440);
  total -= dayShift * 1440;
  let d = day + dayShift;
  let m = month;
  let y = year;
  while (d < 1) {
    m -= 1;
    if (m < 1) {
      m = 12;
      y = prevYear(y);
    }
    d += monthDays(y, m);
  }
  while (d > monthDays(y, m)) {
    d -= monthDays(y, m);
    m += 1;
    if (m > 12) {
      m = 1;
      y = nextYear(y);
    }
  }
  return { year: y, month: m, day: d, hour: Math.floor(total / 60), minute: total % 60 };
};

// Minutes-of-day shift for xs:time, which wraps within the day. The wrapped
// clock fields are the value's canonical form; dayOffset carries how many days
// the normalization moved. For floating values the offset is zero and hour 24
// folds to 00:00 of the same day, so dayOffset stays zero; only timezoned
// values can move across a midnight boundary.
const toUtcTime = (
  hour: number,
  minute: number,
  offsetMinutes: number,
): { hour: number; minute: number; dayOffset: number } => {
  const total = (hour % 24) * 60 + minute - offsetMinutes;
  const dayOffset = Math.floor(total / 1440);
  const within = total - dayOffset * 1440;
  return { hour: Math.floor(within / 60), minute: within % 60, dayOffset };
};

export const parseXsdDate = (value: string): XsdDate => {
  const m = mustExec(DATE_RE, value, "date");
  if (m[2] === undefined || m[3] === undefined) {
    fail("date", value);
  }
  const offset = tzMinutes(m[4]);
  const result: XsdDate = { year: parseYear(m[1]), month: Number(m[2]), day: Number(m[3]) };
  if (offset !== undefined) {
    result.tzOffset = offset;
  }
  return result;
};

export const parseXsdDateTime = (value: string): XsdDateTime => {
  const m = mustExec(DATE_TIME_RE, value, "dateTime");
  if (
    m[2] === undefined ||
    m[3] === undefined ||
    m[4] === undefined ||
    m[5] === undefined ||
    m[6] === undefined
  ) {
    fail("dateTime", value);
  }
  const frac = fraction(m[7]);
  const utc = toUtc(
    parseYear(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    tzMinutes(m[8]) ?? 0,
  );
  const result: XsdDateTime = {
    year: utc.year,
    month: utc.month,
    day: utc.day,
    hour: utc.hour,
    minute: utc.minute,
    second: Number(m[6]),
  };
  if (frac !== undefined) {
    result.fraction = frac;
  }
  if (m[8] !== undefined) {
    result.tzOffset = 0;
  }
  return result;
};

export const parseXsdTime = (value: string): XsdTime => {
  const m = mustExec(TIME_RE, value, "time");
  if (m[2] === undefined || m[3] === undefined) {
    fail("time", value);
  }
  const frac = fraction(m[4]);
  const offset = tzMinutes(m[5]);
  const utc = toUtcTime(Number(m[1]), Number(m[2]), offset ?? 0);
  const result: XsdTime = { hour: utc.hour, minute: utc.minute, second: Number(m[3]) };
  if (frac !== undefined) {
    result.fraction = frac;
  }
  if (offset !== undefined) {
    result.tzOffset = 0;
    if (utc.dayOffset !== 0) {
      result.dayOffset = utc.dayOffset;
    }
  }
  return result;
};

const parseGWithTz = <T extends object>(
  value: string,
  re: RegExp,
  dt: string,
  build: (m: RegExpExecArray) => T,
  tzIdx: number,
): T => {
  const m = mustExec(re, value, dt);
  if (tzIdx === 3 && m[2] === undefined) {
    fail(dt, value);
  }
  const result = build(m);
  const offset = tzMinutes(m[tzIdx]);
  if (offset !== undefined) {
    (result as { tzOffset?: number }).tzOffset = offset;
  }
  return result;
};

export const parseXsdGYear = (value: string): XsdGYear =>
  parseGWithTz(value, G_YEAR_RE, "gYear", (m) => ({ year: parseYear(m[1]) }), 2);

export const parseXsdGYearMonth = (value: string): XsdGYearMonth =>
  parseGWithTz(
    value,
    G_YEAR_MONTH_RE,
    "gYearMonth",
    (m) => ({ year: parseYear(m[1]), month: Number(m[2]) }),
    3,
  );

// Recurring types (gMonth/gMonthDay/gDay) use the leap reference year 2000
// when an order comparison has to place them on the calendar.
const REFERENCE_YEAR = 2000;

export const parseXsdGMonth = (value: string): XsdGMonth =>
  parseGWithTz(value, G_MONTH_RE, "gMonth", (m) => ({ month: Number(m[1]) }), 2);

export const parseXsdGMonthDay = (value: string): XsdGMonthDay =>
  parseGWithTz(
    value,
    G_MONTH_DAY_RE,
    "gMonthDay",
    (m) => ({ month: Number(m[1]), day: Number(m[2]) }),
    3,
  );

export const parseXsdGDay = (value: string): XsdGDay =>
  parseGWithTz(value, G_DAY_RE, "gDay", (m) => ({ day: Number(m[1]) }), 2);

// Datatypes that compare as calendar values (everything but xs:time, which
// wraps within the day, and xs:duration, which has its own partial order).
export type XsdDateComparableDatatype = Exclude<XsdDatatypeName, "time" | "duration">;

// UTC-normalized view of a date-like value, for order comparison only. Parsed
// values keep their local components and actual offset, so comparison shifts a
// timezoned operand here without touching the public value. The shift follows
// the interval interpretation of the date/g* types (anchored at the start of
// the period), exactly as the old parse-time normalization did.
export const xsdUtcComparable = (
  datatype: XsdDateComparableDatatype,
  value: XsdStructuredValue,
): XsdDateTime => {
  const year = "year" in value ? value.year : REFERENCE_YEAR;
  const month = "month" in value ? value.month : 1;
  const day = "day" in value ? value.day : 1;
  const datetime = datatype === "dateTime" ? (value as XsdDateTime) : undefined;
  const offset = "tzOffset" in value ? value.tzOffset : undefined;
  const utc = toUtc(year, month, day, datetime?.hour ?? 0, datetime?.minute ?? 0, offset ?? 0);
  return {
    ...utc,
    second: datetime?.second ?? 0,
    ...(datetime?.fraction === undefined ? {} : { fraction: datetime.fraction }),
    ...(offset === undefined ? {} : { tzOffset: 0 }),
  };
};

export const parseXsdDuration = (value: string): XsdDuration => {
  const collapsed = collapseWhiteSpace(value);
  const m = DURATION_RE.exec(collapsed);
  if (!m) {
    return fail("duration", value);
  }
  const component = (raw: string | undefined): number | undefined => {
    const n = raw === undefined ? undefined : Number(raw);
    return n === undefined || n === 0 ? undefined : n;
  };
  const secondsRaw = m[6];
  const dot = secondsRaw?.indexOf(".") ?? -1;
  const seconds = component(dot >= 0 ? secondsRaw?.slice(0, dot) : secondsRaw);
  const frac = dot >= 0 ? fraction(secondsRaw?.slice(dot + 1)) : undefined;
  const result: XsdDuration = { sign: collapsed.startsWith("-") ? -1 : 1 };
  const assign = (
    key: "years" | "months" | "days" | "hours" | "minutes",
    n: number | undefined,
  ) => {
    if (n !== undefined) {
      result[key] = n;
    }
  };
  assign("years", component(m[1]));
  assign("months", component(m[2]));
  assign("days", component(m[3]));
  assign("hours", component(m[4]));
  assign("minutes", component(m[5]));
  if (seconds !== undefined) {
    result.seconds = seconds;
  }
  if (frac !== undefined) {
    result.fraction = frac;
  }
  // Negative zero is the same value as positive zero: canonical sign is 1.
  if (Object.keys(result).length === 1) {
    result.sign = 1;
  }
  return result;
};

const pad = (n: number, len = 2): string => String(n).padStart(len, "0");
const writeYear = (year: number): string => (year < 0 ? "-" : "") + pad(Math.abs(year), 4);
// Partial date types carry their actual offset, so the writer reproduces the
// timezone designator (UTC canonicalizes to "Z").
const writeTz = (tzOffset: number | undefined): string => {
  if (tzOffset === undefined) {
    return "";
  }
  if (tzOffset === 0) {
    return "Z";
  }
  const sign = tzOffset < 0 ? "-" : "+";
  const abs = Math.abs(tzOffset);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};
// dateTime and time are normalized to UTC, whose canonical designator is "Z".
const writeUtcTz = (tzOffset: number | undefined): string => (tzOffset === undefined ? "" : "Z");
const writeFraction = (frac: string | undefined): string => {
  const s = frac?.replace(/0+$/, "");
  return s ? `.${s}` : "";
};

export const writeXsdDate = (v: XsdDate): string =>
  `${writeYear(v.year)}-${pad(v.month)}-${pad(v.day)}${writeTz(v.tzOffset)}`;

export const writeXsdDateTime = (v: XsdDateTime): string => {
  const utc = toUtc(v.year, v.month, v.day, v.hour, v.minute, v.tzOffset ?? 0);
  return `${writeYear(utc.year)}-${pad(utc.month)}-${pad(utc.day)}T${pad(utc.hour)}:${pad(utc.minute)}:${pad(v.second)}${writeFraction(v.fraction)}${writeUtcTz(v.tzOffset)}`;
};

export const writeXsdTime = (v: XsdTime): string => {
  const utc = toUtcTime(v.hour, v.minute, v.tzOffset ?? 0);
  return `${pad(utc.hour)}:${pad(utc.minute)}:${pad(v.second)}${writeFraction(v.fraction)}${writeUtcTz(v.tzOffset)}`;
};

export const writeXsdGYear = (v: XsdGYear): string => `${writeYear(v.year)}${writeTz(v.tzOffset)}`;

export const writeXsdGYearMonth = (v: XsdGYearMonth): string =>
  `${writeYear(v.year)}-${pad(v.month)}${writeTz(v.tzOffset)}`;

export const writeXsdGMonth = (v: XsdGMonth): string => `--${pad(v.month)}${writeTz(v.tzOffset)}`;

export const writeXsdGMonthDay = (v: XsdGMonthDay): string =>
  `--${pad(v.month)}-${pad(v.day)}${writeTz(v.tzOffset)}`;

export const writeXsdGDay = (v: XsdGDay): string => `---${pad(v.day)}${writeTz(v.tzOffset)}`;

export const writeXsdDuration = (v: XsdDuration): string => {
  const date = `${v.years ? `${v.years}Y` : ""}${v.months ? `${v.months}M` : ""}${v.days ? `${v.days}D` : ""}`;
  const seconds =
    v.seconds || writeFraction(v.fraction) ? `${v.seconds ?? 0}${writeFraction(v.fraction)}S` : "";
  const time = `${v.hours ? `${v.hours}H` : ""}${v.minutes ? `${v.minutes}M` : ""}${seconds}`;
  const body = `${date}${time ? `T${time}` : ""}`;
  // Zero duration: every component dropped, canonical fallback PT0S.
  return body === "" ? "PT0S" : `${v.sign < 0 ? "-" : ""}P${body}`;
};

// Datatype-name dispatch, for the codegen (fixed/default/enum lexicals are
// parsed at generation time) and the runtime serializer (canonical output).
export const parseXsdDatatype = (datatype: XsdDatatypeName, value: string): XsdStructuredValue => {
  switch (datatype) {
    case "date":
      return parseXsdDate(value);
    case "dateTime":
      return parseXsdDateTime(value);
    case "time":
      return parseXsdTime(value);
    case "gYear":
      return parseXsdGYear(value);
    case "gYearMonth":
      return parseXsdGYearMonth(value);
    case "gMonth":
      return parseXsdGMonth(value);
    case "gMonthDay":
      return parseXsdGMonthDay(value);
    case "gDay":
      return parseXsdGDay(value);
    case "duration":
      return parseXsdDuration(value);
  }
};

export const writeXsdDatatype = (datatype: XsdDatatypeName, value: XsdStructuredValue): string => {
  switch (datatype) {
    case "date":
      return writeXsdDate(value as XsdDate);
    case "dateTime":
      return writeXsdDateTime(value as XsdDateTime);
    case "time":
      return writeXsdTime(value as XsdTime);
    case "gYear":
      return writeXsdGYear(value as XsdGYear);
    case "gYearMonth":
      return writeXsdGYearMonth(value as XsdGYearMonth);
    case "gMonth":
      return writeXsdGMonth(value as XsdGMonth);
    case "gMonthDay":
      return writeXsdGMonthDay(value as XsdGMonthDay);
    case "gDay":
      return writeXsdGDay(value as XsdGDay);
    case "duration":
      return writeXsdDuration(value as XsdDuration);
  }
};
