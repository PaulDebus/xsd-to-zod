// Lexical-space validators for the XSD 1.0 builtin datatypes, emitted as zod
// refinements in generated schemas. Values stay strings (round-trip stability)
// — the checks only keep lexically invalid garbage out of parseXml results.
//
// Every builtin here has whiteSpace="collapse" fixed in XSD 1.0, and schema
// validation applies that facet BEFORE the lexical mapping — so each validator
// collapses first, exactly like a schema processor would. The stored value is
// untouched; only the check sees the collapsed form.
//
// Vacuous-by-spec types are deliberately absent: xs:normalizedString
// (whiteSpace=replace) and xs:token (collapse) accept every string after facet
// application, and xs:anyURI accepts every string after the XSD escaping
// procedure — there is nothing a lexical check could reject. QName/NOTATION
// need schema context and are separate work.

// Exported for xsdDateTime.ts, whose structured parsers collapse first too.
export const collapseWhiteSpace = (value: string): string =>
  value.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "");

// XSD 1.0 timezones are bounded to -14:00..+14:00 (per errata).
// The lexical building blocks are exported for the structured parsers in
// xsdDateTime.ts, which wrap them in capture groups.
export const TZ = String.raw`(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))`;
export const YEAR = String.raw`-?(?:[1-9]\d{3,}|0\d{3})`;
export const MONTH = String.raw`(?:0[1-9]|1[0-2])`;
export const DAY = String.raw`(?:0[1-9]|[12]\d|3[01])`;
// Hour 24 is only permitted as 24:00:00 with optional zero fraction.
const TIME = String.raw`(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?|24:00:00(?:\.0+)?)`;

const DATE_RE = new RegExp(String.raw`^(${YEAR})-(${MONTH})-(${DAY})(?:${TZ})?$`);
const DATE_TIME_RE = new RegExp(String.raw`^(${YEAR})-(${MONTH})-(${DAY})T${TIME}(?:${TZ})?$`);
const TIME_RE = new RegExp(String.raw`^${TIME}(?:${TZ})?$`);
const G_YEAR_RE = new RegExp(String.raw`^(${YEAR})(?:${TZ})?$`);
const G_YEAR_MONTH_RE = new RegExp(String.raw`^(${YEAR})-${MONTH}(?:${TZ})?$`);
// XSD 1.0 writes gMonth as --MM--, XSD 1.1 dropped the trailing --; both are
// accepted (the round-trip re-emits the original lexical).
const G_MONTH_RE = new RegExp(String.raw`^--${MONTH}(?:--)?(?:${TZ})?$`);
const G_MONTH_DAY_RE = new RegExp(String.raw`^--(${MONTH})-(${DAY})(?:${TZ})?$`);
const G_DAY_RE = new RegExp(String.raw`^---${DAY}(?:${TZ})?$`);

// Shape only; component presence is checked after the match ("P"/"PT" carry
// no components and are invalid). Exported for the structured duration parser
// in xsdDateTime.ts (the capture groups carry the components).
export const DURATION_RE =
  /^-?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

// The regex shape allows year 0000 and day 31 for every month; the value
// space does not (no year zero in XSD 1.0, and the day must exist in the
// month).
const validYearMonthDay = (year: string, month: string, day: string): boolean => {
  const y = Number(year);
  const m = Number(month);
  return y !== 0 && Number(day) <= daysInMonth(y, m);
};

const match =
  (re: RegExp) =>
  (value: string): boolean =>
    re.test(collapseWhiteSpace(value));

export const xsdDate = (value: string): boolean => {
  const m = DATE_RE.exec(collapseWhiteSpace(value));
  return m !== null && validYearMonthDay(m[1]!, m[2]!, m[3]!);
};

export const xsdDateTime = (value: string): boolean => {
  const m = DATE_TIME_RE.exec(collapseWhiteSpace(value));
  return m !== null && validYearMonthDay(m[1]!, m[2]!, m[3]!);
};

export const xsdTime = match(TIME_RE);

export const xsdGYear = (value: string): boolean => {
  const m = G_YEAR_RE.exec(collapseWhiteSpace(value));
  return m !== null && Number(m[1]) !== 0;
};

export const xsdGYearMonth = (value: string): boolean => {
  const m = G_YEAR_MONTH_RE.exec(collapseWhiteSpace(value));
  return m !== null && Number(m[1]) !== 0;
};

export const xsdGMonth = match(G_MONTH_RE);

export const xsdGMonthDay = (value: string): boolean => {
  const m = G_MONTH_DAY_RE.exec(collapseWhiteSpace(value));
  // No year: February allows day 29 (the date recurs — some year is leap).
  return m !== null && Number(m[2]) <= (Number(m[1]) === 2 ? 29 : daysInMonth(2001, Number(m[1])));
};

export const xsdGDay = match(G_DAY_RE);

export const xsdDuration = (value: string): boolean => {
  const m = DURATION_RE.exec(collapseWhiteSpace(value));
  if (m === null) {
    return false;
  }
  const components = m.slice(1);
  const hasDate = components.slice(0, 3).some((c) => c !== undefined);
  const hasTime = components.slice(3).some((c) => c !== undefined);
  if (!hasDate && !hasTime) {
    return false; // bare "P" / "-P"
  }
  // A trailing "T" with no time components ("P1YT") is invalid.
  return !value.includes("T") || hasTime;
};

export const xsdHexBinary = (value: string): boolean =>
  /^([0-9a-fA-F]{2})*$/.test(collapseWhiteSpace(value));

// Whitespace may separate base64 quads (spec BNF), so strip it all rather
// than just collapsing.
export const xsdBase64Binary = (value: string): boolean =>
  /^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)?$/.test(value.replace(/\s+/g, ""));

// XML Schema Part 2 pattern for xs:language (BCP 47-ish, not the full RFC).
export const xsdLanguage = match(/^[a-zA-Z]{1,8}(?:-[a-zA-Z0-9]{1,8})*$/);

// XML 1.0 (5th edition) Name productions. NameChar adds digits, '-', '.',
// middle dot and combining ranges to NameStartChar; NCName* excludes ':'.
// Exported (as character-class content) for the XSD regex translation in
// xsdPattern.ts, whose \i / \c multi-character escapes are these same sets.
export const NAME_START_CHAR =
  ":A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF" +
  "\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD" +
  "\\u{10000}-\\u{EFFFF}";
const NCNAME_START_CHAR = NAME_START_CHAR.replace(":", "");
export const NAME_CHAR_EXTRA = "\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040";
const NAME_RE = new RegExp(`^[${NAME_START_CHAR}][${NAME_START_CHAR}${NAME_CHAR_EXTRA}]*$`, "u");
const NMTOKEN_RE = new RegExp(`^[${NAME_START_CHAR}${NAME_CHAR_EXTRA}]+$`, "u");
const NCNAME_RE = new RegExp(
  `^[${NCNAME_START_CHAR}][${NCNAME_START_CHAR}${NAME_CHAR_EXTRA}]*$`,
  "u",
);

export const xsdName = match(NAME_RE);
export const xsdNCName = match(NCNAME_RE);
export const xsdNMTOKEN = match(NMTOKEN_RE);

// XSD list types (NMTOKENS, IDREFS, ENTITIES): whitespace-separated items,
// validated after the fixed whiteSpace=collapse.
const listOf =
  (item: (value: string) => boolean) =>
  (value: string): boolean => {
    const collapsed = collapseWhiteSpace(value);
    return collapsed !== "" && collapsed.split(" ").every(item);
  };

export const xsdNMTOKENS = listOf(match(NMTOKEN_RE));
export const xsdNCNames = listOf(match(NCNAME_RE));
