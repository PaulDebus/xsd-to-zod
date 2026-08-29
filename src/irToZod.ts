import { Xsd2ZodError } from "./errors.js";
import { clarkToLocal, trySplitClark } from "./qname.js";
import type {
  ComplexTypeDef,
  ElementDef,
  Facet,
  IrField,
  QName,
  SimpleTypeDef,
  XsdIr,
} from "./types.js";
import type { XmlChoiceMeta, XmlLexicalFacets } from "./xmlMeta.js";
import { XSD_BIGINT_TYPE_NAMES, XSD_SAFE_INTEGER_TYPE_NAMES } from "./xsdBuiltins.js";
import { xsdDecimalCompare } from "./xsdChecks.js";
import { parseXsdDatatype, writeXsdDatatype, type XsdDatatypeName } from "./xsdDateTime.js";

const XSD_NS = "http://www.w3.org/2001/XMLSchema";

const NUMBER_PRIMITIVES = new Set([...XSD_SAFE_INTEGER_TYPE_NAMES, "decimal", "float", "double"]);

// Date/time builtins that datatypes: "structured" parses into plain objects
// (xsdDateTime.ts): builtin local name → generated-code helper and TS type.
const XSD_STRUCTURED_TYPES: ReadonlyMap<
  string,
  { parseFn: string; writeFn: string; tsType: string }
> = new Map([
  ["date", { parseFn: "parseXsdDate", writeFn: "writeXsdDate", tsType: "XsdDate" }],
  ["dateTime", { parseFn: "parseXsdDateTime", writeFn: "writeXsdDateTime", tsType: "XsdDateTime" }],
  ["time", { parseFn: "parseXsdTime", writeFn: "writeXsdTime", tsType: "XsdTime" }],
  ["gYear", { parseFn: "parseXsdGYear", writeFn: "writeXsdGYear", tsType: "XsdGYear" }],
  [
    "gYearMonth",
    { parseFn: "parseXsdGYearMonth", writeFn: "writeXsdGYearMonth", tsType: "XsdGYearMonth" },
  ],
  ["gMonth", { parseFn: "parseXsdGMonth", writeFn: "writeXsdGMonth", tsType: "XsdGMonth" }],
  [
    "gMonthDay",
    { parseFn: "parseXsdGMonthDay", writeFn: "writeXsdGMonthDay", tsType: "XsdGMonthDay" },
  ],
  ["gDay", { parseFn: "parseXsdGDay", writeFn: "writeXsdGDay", tsType: "XsdGDay" }],
  ["duration", { parseFn: "parseXsdDuration", writeFn: "writeXsdDuration", tsType: "XsdDuration" }],
]);

// Structured helper for a builtin local name, narrowed for the dispatch fns.
const structuredType = (
  builtinLocal: string | undefined,
):
  | ({ parseFn: string; writeFn: string; tsType: string } & { name: XsdDatatypeName })
  | undefined => {
  const info = builtinLocal === undefined ? undefined : XSD_STRUCTURED_TYPES.get(builtinLocal);
  return info === undefined ? undefined : { ...info, name: builtinLocal as XsdDatatypeName };
};

// Parse a fixed/default lexical at codegen time and emit it as an object
// literal matching the structured runtime value.
const structuredLiteral = (name: XsdDatatypeName, raw: string): string =>
  JSON.stringify(parseXsdDatatype(name, raw));

// Builtins whose lexical space the zod tier can check (xsdLexicals.ts has the
// validators): builtin local name → exported validator function. QName,
// NOTATION, anyURI, normalizedString and token are absent on purpose — see
// xsdLexicals.ts for why their lexical check is impossible or vacuous.
const XSD_LEXICAL_VALIDATORS: ReadonlyMap<string, string> = new Map([
  ["date", "xsdDate"],
  ["dateTime", "xsdDateTime"],
  ["time", "xsdTime"],
  ["gYear", "xsdGYear"],
  ["gYearMonth", "xsdGYearMonth"],
  ["gMonth", "xsdGMonth"],
  ["gMonthDay", "xsdGMonthDay"],
  ["gDay", "xsdGDay"],
  ["duration", "xsdDuration"],
  ["hexBinary", "xsdHexBinary"],
  ["base64Binary", "xsdBase64Binary"],
  ["language", "xsdLanguage"],
  ["Name", "xsdName"],
  ["NCName", "xsdNCName"],
  ["ID", "xsdNCName"],
  ["IDREF", "xsdNCName"],
  ["ENTITY", "xsdNCName"],
  ["NMTOKEN", "xsdNMTOKEN"],
  ["NMTOKENS", "xsdNMTOKENS"],
  ["IDREFS", "xsdNCNames"],
  ["ENTITIES", "xsdNCNames"],
]);

// The effective whiteSpace facet of a simple type: the nearest whiteSpace
// declaration up the restriction chain, else the builtin default (collapse
// for everything but string/anySimpleType, replace for normalizedString).
const effectiveWhiteSpace = (
  typeName: QName,
  ir: XsdIr,
  seen?: Set<string>,
): "collapse" | "replace" | undefined => {
  const parts = trySplitClark(typeName);
  if (parts?.ns === XSD_NS) {
    // anyType/anySimpleType have no whiteSpace facet; string preserves.
    if (parts.local === "string" || parts.local === "anySimpleType" || parts.local === "anyType") {
      return undefined;
    }
    return parts.local === "normalizedString" ? "replace" : "collapse";
  }
  const next = nextSeen(seen, typeName);
  if (!next) {
    return undefined;
  }
  const simple = ir.simpleTypes[typeName];
  if (simple === undefined) {
    return undefined;
  }
  if (simple.kind === "list") {
    return "collapse";
  }
  if (simple.kind === "union") {
    return undefined;
  }
  const declared = simple.facets?.find((f) => f.kind === "whiteSpace")?.value;
  if (declared === "collapse" || declared === "replace") {
    return declared;
  }
  return effectiveWhiteSpace(simple.baseType, ir, next);
};

const XSD_WS_COLLAPSE = "v.replace(/\\s+/g, \" \").trim()";
const XSD_WS_REPLACE = "v.replace(/[\\t\\n\\r]/g, \" \")";

// String-derived builtins with a fixed whiteSpace=collapse facet (XSD 1.0
// §4.3): language and the Name/NCName/NMTOKEN family (incl. the list-ish
// NMTOKENS/IDREFS/ENTITIES, which the codegen models as plain strings).
const XSD_COLLAPSE_STRING_BUILTINS: ReadonlySet<string> = new Set([
  "language",
  "Name",
  "NCName",
  "ID",
  "IDREF",
  "ENTITY",
  "NMTOKEN",
  "NMTOKENS",
  "IDREFS",
  "ENTITIES",
]);

// Value-space processing of a fixed/default/enum lexical: the whiteSpace facet
// applies to the literal itself, so the emitted JS literal is the processed
// value (NMTOKENS fixed="&#x9; X" means the value "X").
const wsProcessLiteral = (raw: string, whiteSpace: "collapse" | "replace" | undefined): string =>
  whiteSpace === "collapse"
    ? raw.replace(/\s+/g, " ").trim()
    : whiteSpace === "replace"
      ? raw.replace(/[\t\n\r]/g, " ")
      : raw;

// Primitive builtins that map to a constant zod expression; anything absent
// falls back to z.string().
const XSD_PRIMITIVE_EMITTERS: ReadonlyMap<string, string> = new Map([
  // Open content: the runtime walks/serializes it generically (open shape);
  // zod stays permissive for this lax tier.
  ["anyType", "z.unknown()"],
  ["string", "z.string()"],
  // xs:token/xs:normalizedString have fixed whiteSpace facets (collapse /
  // replace) — they apply to every value, so the preprocess rides the type.
  ["token", `z.preprocess((v) => typeof v === "string" ? ${XSD_WS_COLLAPSE} : v, z.string())`],
  [
    "normalizedString",
    `z.preprocess((v) => typeof v === "string" ? ${XSD_WS_REPLACE} : v, z.string())`,
  ],
  ["boolean", "z.boolean()"],
  ["decimal", "z.number()"],
  // xs:float/xs:double include INF/-INF/NaN in their value space; zod's
  // z.number() rejects non-finite numbers at the base-type level (#116).
  ["float", "z.union([z.number(), z.literal(Infinity), z.literal(-Infinity), z.nan()])"],
  ["double", "z.union([z.number(), z.literal(Infinity), z.literal(-Infinity), z.nan()])"],
]);

// Value-space bounds for the bounded integer builtins that fit a JS number.
const XSD_INTEGER_BOUNDS: ReadonlyMap<string, { min?: number; max?: number }> = new Map([
  ["byte", { min: -128, max: 127 }],
  ["short", { min: -32768, max: 32767 }],
  ["int", { min: -2147483648, max: 2147483647 }],
  ["unsignedByte", { min: 0, max: 255 }],
  ["unsignedShort", { min: 0, max: 65535 }],
  ["unsignedInt", { min: 0, max: 4294967295 }],
]);

// Bounds for the bigint-mapped builtins, as bigint literal source. The
// long/unsignedLong 64-bit bounds exceed MAX_SAFE_INTEGER, so they can only be
// expressed soundly as bigint literals.
const XSD_BIGINT_BOUNDS: ReadonlyMap<string, { min?: string; max?: string }> = new Map([
  ["long", { min: "-9223372036854775808n", max: "9223372036854775807n" }],
  ["unsignedLong", { min: "0n", max: "18446744073709551615n" }],
  ["nonNegativeInteger", { min: "0n" }],
  ["nonPositiveInteger", { max: "0n" }],
  ["negativeInteger", { max: "-1n" }],
  ["positiveInteger", { min: "1n" }],
]);

const nextSeen = (seen: Set<string> | undefined, name: string): Set<string> | undefined => {
  const s = seen ?? new Set<string>();
  if (s.has(name)) {
    return undefined;
  }
  s.add(name);
  return s;
};

// Resolve a (possibly user-defined) simple type to its builtin base kind, so
// fixed/default values are coerced to the JS type the runtime produces (#87).
const resolvePrimitiveKind = (
  typeName: QName,
  ir: XsdIr,
  seen?: Set<string>,
): "number" | "bigint" | "boolean" | "string" => {
  const parts = trySplitClark(typeName);
  if (!parts) {
    return "string";
  }
  if (parts.ns === XSD_NS) {
    if (XSD_BIGINT_TYPE_NAMES.has(parts.local)) {
      return "bigint";
    }
    if (NUMBER_PRIMITIVES.has(parts.local)) {
      return "number";
    }
    return parts.local === "boolean" ? "boolean" : "string";
  }
  const next = nextSeen(seen, typeName);
  if (!next) {
    return "string";
  }
  const simple = ir.simpleTypes[typeName];
  if (!simple) {
    return "string";
  }
  const base =
    simple.kind === "restriction"
      ? simple.baseType
      : simple.kind === "list"
        ? simple.itemType
        : simple.memberTypes[0];
  return base ? resolvePrimitiveKind(base, ir, next) : "string";
};

// The XSD builtin local name a (possibly user-defined) simple type derives
// from, e.g. 'NOTATION' or 'date'; undefined for lists/unions/unresolvable.
const resolveBuiltinLocal = (
  typeName: QName,
  ir: XsdIr,
  seen?: Set<string>,
): string | undefined => {
  const parts = trySplitClark(typeName);
  if (!parts) {
    return undefined;
  }
  if (parts.ns === XSD_NS) {
    return parts.local;
  }
  const next = nextSeen(seen, typeName);
  if (!next) {
    return undefined;
  }
  const simple = ir.simpleTypes[typeName];
  return simple?.kind === "restriction"
    ? resolveBuiltinLocal(simple.baseType, ir, next)
    : undefined;
};

// Resolve a (possibly user-defined) simple type to its xs:list item type, so a
// list-typed fixed/default lexical is emitted as an array literal — one typed
// item per whitespace-separated token.
const resolveListItemType = (typeName: QName, ir: XsdIr, seen?: Set<string>): QName | undefined => {
  const next = nextSeen(seen, typeName);
  if (!next) {
    return undefined;
  }
  const simple = ir.simpleTypes[typeName];
  if (simple?.kind === "list") {
    return simple.itemType;
  }
  return simple?.kind === "restriction"
    ? resolveListItemType(simple.baseType, ir, next)
    : undefined;
};

const primitiveToZod = (
  typeName: QName,
  definedTypes: Set<string>,
  constName: ReadonlyMap<QName, string>,
  usedHelpers: Set<string>,
  structured: boolean,
): string => {
  const parts = trySplitClark(typeName);
  if (!parts) {
    return "z.unknown()";
  }
  if (parts.ns !== XSD_NS) {
    // Unresolvable references (e.g. type="string" in a schema whose default
    // namespace is the targetNamespace) must not emit a dangling reference.
    const ref = constName.get(typeName);
    return definedTypes.has(typeName) && ref !== undefined ? ref : "z.unknown()";
  }

  if (XSD_SAFE_INTEGER_TYPE_NAMES.has(parts.local)) {
    const bounds = XSD_INTEGER_BOUNDS.get(parts.local);
    let expr = "z.number().int()";
    if (bounds?.min !== undefined) {
      expr += `.min(${bounds.min})`;
    }
    if (bounds?.max !== undefined) {
      expr += `.max(${bounds.max})`;
    }
    return expr;
  }

  if (XSD_BIGINT_TYPE_NAMES.has(parts.local)) {
    const bounds = XSD_BIGINT_BOUNDS.get(parts.local);
    let expr = "z.bigint()";
    if (bounds?.min !== undefined) {
      expr += `.min(${bounds.min})`;
    }
    if (bounds?.max !== undefined) {
      expr += `.max(${bounds.max})`;
    }
    return expr;
  }

  const validator = XSD_LEXICAL_VALIDATORS.get(parts.local);
  if (validator) {
    usedHelpers.add(validator);
    let base = `z.string().refine(${validator}, { message: 'invalid xs:${parts.local} lexical' })`;
    // The string-derived builtins fix whiteSpace=collapse (XSD 1.0) — it
    // applies to every value, so the preprocess rides the type. The date/time
    // family keeps its original lexicals (documented behavior).
    if (XSD_COLLAPSE_STRING_BUILTINS.has(parts.local)) {
      base = `z.preprocess((v) => typeof v === "string" ? ${XSD_WS_COLLAPSE} : v, ${base})`;
    }
    // Structured mode: the lexical check stays, the parsed value becomes a
    // plain object (xsdDateTime.ts) via a transform after the refine.
    const structuredInfo = structured ? structuredType(parts.local) : undefined;
    if (structuredInfo) {
      usedHelpers.add(structuredInfo.parseFn);
      return `${base}.transform(${structuredInfo.parseFn})`;
    }
    return base;
  }

  return XSD_PRIMITIVE_EMITTERS.get(parts.local) ?? "z.string()";
};

const isStringType = (zodExpr: string): boolean => zodExpr.startsWith("z.string()");
const isNumberType = (zodExpr: string): boolean => zodExpr.startsWith("z.number()");
const isBigIntType = (zodExpr: string): boolean => zodExpr.startsWith("z.bigint()");

// fixed/default values arrive as XSD lexicals; emit them coerced to the JS type
// the runtime produces for the field's (resolved) primitive kind (#68, #87).
const typedLiteral = (kind: "number" | "bigint" | "boolean" | "string", raw: string): string => {
  if (kind === "number") {
    const trimmed = raw.trim();
    // xs:float/xs:double special lexicals: Number() maps all three to NaN.
    if (trimmed === "INF") {
      return "Infinity";
    }
    if (trimmed === "-INF") {
      return "-Infinity";
    }
    if (trimmed === "NaN") {
      return "NaN";
    }
    return String(Number(raw));
  }
  if (kind === "bigint") {
    const trimmed = raw.trim();
    // Enumeration on a list-of-integers type: the facet value is a list
    // lexical, so emit an array literal (one bigint per item).
    if (/\s/.test(trimmed)) {
      return `[${trimmed
        .split(/\s+/)
        .map((tok) => `${BigInt(tok)}n`)
        .join(", ")}]`;
    }
    // BigInt() normalizes the lexical ('+5', '007') and rejects non-integers.
    return `${BigInt(trimmed)}n`;
  }
  if (kind === "boolean") {
    return raw === "true" || raw === "1" ? "true" : "false";
  }
  return JSON.stringify(raw);
};

// Whitespace-separated tokens of a list lexical; a trimmed empty lexical is an
// empty list.
const listTokens = (raw: string): string[] => {
  const trimmed = raw.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
};

// Typed array literal for a list-typed fixed lexical: one typed item per
// whitespace-separated token. The runtime substitutes it from the field meta —
// the schema constrains with a refine, not a z.literal.
const listLiteral = (typeName: QName, ir: XsdIr, raw: string): string => {
  const listItemType = resolveListItemType(typeName, ir);
  if (listItemType === undefined) {
    return typedLiteral(resolvePrimitiveKind(typeName, ir), raw);
  }
  const itemKind = resolvePrimitiveKind(listItemType, ir);
  return `[${listTokens(raw)
    .map((token) => typedLiteral(itemKind, token))
    .join(", ")}]`;
};

const toFieldKey = (field: IrField): string => {
  if (field.fieldKey !== undefined) {
    return field.fieldKey;
  }
  if (field.kind === "text") {
    return "_text";
  }
  const local = clarkToLocal(field.qname);
  return field.kind === "attribute" ? `@${local}` : local;
};

// xs:annotation/xs:documentation surfaces as zod .describe() — IDE tooltips and
// downstream form generators pick it up from the schema (#25).
const withDescription = (expr: string, description: string | undefined): string =>
  description === undefined ? expr : `${expr}.describe(${JSON.stringify(description)})`;

type FacetUsage = { totalDigits: boolean; fractionDigits: boolean };

// The structure a restriction ultimately derives from (list/union → lexical meta).
const resolveBaseStructure = (
  typeName: QName,
  ir: XsdIr,
  seen?: Set<string>,
): "list" | "union" | undefined => {
  const next = nextSeen(seen, typeName);
  if (!next) {
    return undefined;
  }
  const simple = ir.simpleTypes[typeName];
  return simple === undefined
    ? undefined
    : simple.kind === "restriction"
      ? resolveBaseStructure(simple.baseType, ir, next)
      : simple.kind;
};

// Pattern facets of one derivation step are alternatives (XSD ORs them).
// Combining at the XSD source level (alternation) keeps the anchors and
// translation in xsdPattern intact.
const applyPatternFacets = (
  result: string,
  facetValues: string[],
  st: ReturnType<typeof structuredType> | undefined,
  usedHelpers: Set<string>,
  ownPatterns: string[],
): string => {
  if (st !== undefined) {
    usedHelpers.add(st.writeFn);
    const alternatives = facetValues.map((v) => JSON.stringify(v)).join(", ");
    return `${result}.refine((val) => [${alternatives}].some((p) => new RegExp(p).test(${st.writeFn}(val))), { message: 'value does not match the pattern' })`;
  }
  if (isStringType(result)) {
    usedHelpers.add("xsdPattern");
    return `${result}.regex(xsdPattern(${JSON.stringify(facetValues.join("|"))}))`;
  }
  ownPatterns.push(...facetValues);
  return result;
};

const applyLengthFacet = (
  result: string,
  kind: Facet & { kind: "length" | "minLength" | "maxLength" },
  builtinLocal: string | undefined,
  st: ReturnType<typeof structuredType> | undefined,
  usedHelpers: Set<string>,
): string => {
  const op = kind.kind === "length" ? "===" : kind.kind === "minLength" ? ">=" : "<=";
  if (builtinLocal === "NOTATION" || builtinLocal === "QName") {
    return `${result} /* facet ${kind.kind} skipped: vacuous for xs:${builtinLocal} in XSD 1.0 */`;
  }
  if (builtinLocal === "hexBinary") {
    return `${result}.refine((val) => typeof val === 'string' && val.length % 2 === 0 && val.length / 2 ${op} ${kind.value}, { message: 'octet length constraint violated' })`;
  }
  if (builtinLocal === "base64Binary") {
    return `${result}.refine((val) => typeof val === 'string' && ((s) => Math.floor(s.length / 4) * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0))(val.replace(/\\s+/g, '')) ${op} ${kind.value}, { message: 'octet length constraint violated' })`;
  }
  if (builtinLocal === "IDREFS" || builtinLocal === "NMTOKENS" || builtinLocal === "ENTITIES") {
    return `${result}.refine((val) => typeof val === 'string' && (val.trim() === '' ? 0 : val.trim().split(/\\s+/).length) ${op} ${kind.value}, { message: 'item count constraint violated' })`;
  }
  if (st !== undefined) {
    usedHelpers.add(st.writeFn);
    return `${result}.refine((val) => ${st.writeFn}(val).length ${op} ${kind.value}, { message: 'length constraint violated' })`;
  }
  if (isStringType(result)) {
    return kind.kind === "length"
      ? `${result}.length(${kind.value})`
      : kind.kind === "minLength"
        ? `${result}.min(${kind.value})`
        : `${result}.max(${kind.value})`;
  }
  return `${result}.refine((val) => (typeof val === 'string' || Array.isArray(val)) && val.length ${op} ${kind.value}, { message: 'length constraint violated' })`;
};

const applyOrderFacet = (
  result: string,
  facet: Facet & { kind: "minInclusive" | "maxInclusive" | "minExclusive" | "maxExclusive" },
  kind: "number" | "bigint" | "boolean" | "string",
): string => {
  if (isNumberType(result)) {
    const bound = String(Number(facet.value));
    const suffix =
      facet.kind === "minInclusive"
        ? `.min(${bound})`
        : facet.kind === "maxInclusive"
          ? `.max(${bound})`
          : facet.kind === "minExclusive"
            ? `.gt(${bound})`
            : `.lt(${bound})`;
    return result + suffix;
  }
  if (isBigIntType(result)) {
    const bound = typedLiteral("bigint", facet.value);
    const suffix =
      facet.kind === "minInclusive"
        ? `.min(${bound})`
        : facet.kind === "maxInclusive"
          ? `.max(${bound})`
          : facet.kind === "minExclusive"
            ? `.gt(${bound})`
            : `.lt(${bound})`;
    return result + suffix;
  }
  if (kind === "number" || kind === "bigint") {
    const op =
      facet.kind === "minInclusive"
        ? ">="
        : facet.kind === "maxInclusive"
          ? "<="
          : facet.kind === "minExclusive"
            ? ">"
            : "<";
    const bound =
      kind === "bigint" ? typedLiteral("bigint", facet.value) : String(Number(facet.value));
    return `${result}.refine((val) => val ${op} ${bound}, { message: 'value out of range' })`;
  }
  return `${result} /* facet ${facet.kind} skipped: order facets unsupported on non-numeric types */`;
};

// Enum facet values arrive as XSD lexicals; emit them coerced to the JS type
// the runtime produces for the resolved primitive kind — same rule as
// fixed/default values (#68, #84). Facets the generated schema cannot check
// against the coerced value (pattern on non-string/list/union bases, enums on
// list/union/date-time bases, exact xs:decimal order bounds) are collected
// into `lexical` instead — the runtime enforces those against the original
// XML lexical (see XmlLexicalFacets).
const withFacets = (
  base: string,
  facets: Facet[],
  usage: FacetUsage,
  kind: "number" | "bigint" | "boolean" | "string",
  builtinLocal: string | undefined,
  structured: boolean,
  usedHelpers: Set<string>,
  baseStructure: "list" | "union" | undefined,
  lexical: XmlLexicalFacets,
): string => {
  if (!facets.length) {
    return base;
  }

  const enumFacets = facets.filter((f) => f.kind === "enumeration");
  const whiteSpace = facets.find((f) => f.kind === "whiteSpace");
  // Enum literals are values: the effective whiteSpace facet (own declaration,
  // else the builtin default) applies to the declared lexicals. Computed
  // lazily: union/list-based enums route to the runtime meta (enumViaMeta),
  // and coercing their literals to one primitive kind would be wrong (a
  // union's members span kinds — BigInt('x') would throw).
  const enumWhiteSpace =
    whiteSpace?.value === "collapse" || whiteSpace?.value === "replace"
      ? whiteSpace.value
      : builtinLocal === undefined || builtinLocal === "string" || builtinLocal === "anySimpleType"
        ? undefined
        : builtinLocal === "normalizedString"
          ? ("replace" as const)
          : ("collapse" as const);
  let enumLiteralsCache: string[] | undefined;
  const enumLiterals = (): string[] =>
    (enumLiteralsCache ??= enumFacets.map((f) =>
      typedLiteral(kind, wsProcessLiteral(f.value, kind === "string" ? enumWhiteSpace : undefined)),
    ));

  // Structured date/time values are objects, so enum membership compares
  // canonical lexicals (value-space equality) instead of reference identity.
  const st = structured ? structuredType(builtinLocal) : undefined;
  if (st && enumFacets.length > 0) {
    usedHelpers.add(st.writeFn);
  }
  const enumConstraint =
    st === undefined
      ? undefined
      : `.refine((val) => [${enumFacets
          .map((f) => JSON.stringify(writeXsdDatatype(st.name, parseXsdDatatype(st.name, f.value))))
          .join(
            ", ",
          )}].includes(${st.writeFn}(val)), { message: 'value is not one of the allowed values' })`;

  const enumViaMeta =
    st === undefined &&
    enumFacets.length > 0 &&
    (baseStructure !== undefined ||
      (builtinLocal !== undefined && XSD_STRUCTURED_TYPES.has(builtinLocal)));
  if (enumViaMeta) {
    lexical.enumerations = enumFacets.map((f) => f.value);
    if (baseStructure === undefined && builtinLocal !== undefined) {
      lexical.datatype = builtinLocal as XsdDatatypeName;
    }
  }

  // xs:decimal order facets compare the original lexicals exactly: both the
  // boundary and the instance value can carry more significant digits than a
  // double holds (#136), so they route to the runtime meta.
  const isDecimalOrderFacet = (
    f: Facet,
  ): f is Extract<
    Facet,
    { kind: "minInclusive" | "maxInclusive" | "minExclusive" | "maxExclusive" }
  > =>
    builtinLocal === "decimal" &&
    kind === "number" &&
    (f.kind === "minInclusive" ||
      f.kind === "maxInclusive" ||
      f.kind === "minExclusive" ||
      f.kind === "maxExclusive");
  for (const f of facets.filter(isDecimalOrderFacet)) {
    lexical[f.kind] = f.value;
  }

  const otherFacets = facets.filter(
    (f): f is Exclude<Facet, { kind: "enumeration" | "whiteSpace" }> =>
      f.kind !== "enumeration" && f.kind !== "whiteSpace" && !isDecimalOrderFacet(f),
  );

  // Patterns of this derivation step form one alternative set (XSD ORs
  // patterns within a step); collected here and flushed at the end.
  const ownPatterns: string[] = [];

  let result = base;
  if (enumFacets.length > 0 && !enumViaMeta && otherFacets.length === 0) {
    if (enumConstraint !== undefined) {
      // Structured base (a string→object pipe): keep it and constrain.
      result += enumConstraint;
    } else if (isStringType(base)) {
      result = `z.enum([${enumLiterals().join(", ")}])`;
    } else if (isNumberType(base) || isBigIntType(base) || base === "z.boolean()") {
      result = `z.union([${enumLiterals().map((lit) => `z.literal(${lit})`).join(", ")}])`;
    } else {
      // Base is a reference to another type's schema — keep it and constrain.
      result += `.refine((val) => [${enumLiterals().join(", ")}].includes(val), { message: 'value is not one of the allowed values' })`;
    }
  } else {
    for (const facet of otherFacets) {
      switch (facet.kind) {
        case "length":
        case "minLength":
        case "maxLength":
          result = applyLengthFacet(result, facet, builtinLocal, st, usedHelpers);
          break;
        case "minInclusive":
        case "maxInclusive":
        case "minExclusive":
        case "maxExclusive":
          result = applyOrderFacet(result, facet, kind);
          break;
        case "totalDigits":
          if (kind === "bigint") {
            result += `.refine((val) => String(val < 0n ? -val : val).length <= ${facet.value}, { message: ${JSON.stringify(`expected at most ${facet.value} total digits`)} })`;
          } else {
            usage.totalDigits = true;
            result += `.refine(xsdTotalDigits(${facet.value}), { message: ${JSON.stringify(`expected at most ${facet.value} total digits`)} })`;
          }
          break;
        case "fractionDigits":
          if (kind === "bigint") {
            result += ` /* facet fractionDigits skipped: vacuous for integer types */`;
          } else {
            usage.fractionDigits = true;
            result += `.refine(xsdFractionDigits(${facet.value}), { message: ${JSON.stringify(`expected at most ${facet.value} fraction digits`)} })`;
          }
          break;
      }
    }
    const patternValues = otherFacets
      .filter((f) => f.kind === "pattern")
      .map((f) => (f as Facet & { kind: "pattern" }).value);
    if (patternValues.length > 0) {
      result = applyPatternFacets(result, patternValues, st, usedHelpers, ownPatterns);
    }

    if (enumFacets.length > 0 && !enumViaMeta) {
      result +=
        enumConstraint ??
        `.refine((val) => [${enumLiterals().join(", ")}].includes(val), { message: 'value is not one of the allowed values' })`;
    }
  }

  if (ownPatterns.length > 0) {
    const patterns = lexical.patterns ?? [];
    patterns.push(ownPatterns);
    lexical.patterns = patterns;
  }

  // whiteSpace applies before the other facets per XSD, so it wraps the
  // checked schema in a preprocess (#69). 'preserve' is deliberately a no-op.
  if (whiteSpace?.value === "collapse") {
    lexical.whiteSpace = "collapse";
    result = `z.preprocess((v) => typeof v === "string" ? v.replace(/\\s+/g, " ").trim() : v, ${result})`;
  } else if (whiteSpace?.value === "replace") {
    lexical.whiteSpace = "replace";
    result = `z.preprocess((v) => typeof v === "string" ? v.replace(/[\\t\\n\\r]/g, " ") : v, ${result})`;
  }
  // whiteSpace=collapse is fixed for list types in XSD.
  if (baseStructure === "list" && lexical.whiteSpace === undefined) {
    lexical.whiteSpace = "collapse";
  }
  // Builtin defaults: every builtin but the string-ish ones fixes
  // whiteSpace=collapse (normalizedString: replace) — facet checks see the
  // processed lexical even when the restriction declares no whiteSpace facet.
  if (Object.keys(lexical).length > 0 && lexical.whiteSpace === undefined) {
    if (builtinLocal === "normalizedString") {
      lexical.whiteSpace = "replace";
    } else if (builtinLocal !== undefined && builtinLocal !== "string") {
      lexical.whiteSpace = "collapse";
    }
  }

  return result;
};

// Lexical facets accumulate over the derivation chain: patterns AND across
// steps (each step's set ORs internally), enumerations narrow (the derived
// set is a subset, so it wins), decimal bounds tighten. The immediate base's
// stored entry already carries its whole chain (dependency-order emission).
const mergeLexicalFacets = (
  base: XmlLexicalFacets | undefined,
  own: XmlLexicalFacets,
): XmlLexicalFacets | undefined => {
  if (base === undefined) {
    return Object.keys(own).length > 0 ? own : undefined;
  }
  const merged: XmlLexicalFacets = {};
  const whiteSpace = own.whiteSpace ?? base.whiteSpace;
  if (whiteSpace !== undefined) {
    merged.whiteSpace = whiteSpace;
  }
  const datatype = own.datatype ?? base.datatype;
  if (datatype !== undefined) {
    merged.datatype = datatype;
  }
  const patterns = [...(base.patterns ?? []), ...(own.patterns ?? [])];
  if (patterns.length > 0) {
    merged.patterns = patterns;
  }
  const enumerations = own.enumerations ?? base.enumerations;
  if (enumerations !== undefined) {
    merged.enumerations = enumerations;
  }
  const tighter = (
    a: string | undefined,
    b: string | undefined,
    preferLarger: boolean,
  ): string | undefined => {
    if (a === undefined) {
      return b;
    }
    if (b === undefined) {
      return a;
    }
    const cmp = xsdDecimalCompare(a, b);
    if (Number.isNaN(cmp) || cmp === 0) {
      return b;
    }
    return preferLarger === cmp > 0 ? a : b;
  };
  const minInclusive = tighter(base.minInclusive, own.minInclusive, true);
  if (minInclusive !== undefined) {
    merged.minInclusive = minInclusive;
  }
  const minExclusive = tighter(base.minExclusive, own.minExclusive, true);
  if (minExclusive !== undefined) {
    merged.minExclusive = minExclusive;
  }
  const maxInclusive = tighter(base.maxInclusive, own.maxInclusive, false);
  if (maxInclusive !== undefined) {
    merged.maxInclusive = maxInclusive;
  }
  const maxExclusive = tighter(base.maxExclusive, own.maxExclusive, false);
  if (maxExclusive !== undefined) {
    merged.maxExclusive = maxExclusive;
  }
  return merged;
};

// Emit simple types in dependency order — a restriction/list/union can
// reference a user-defined type declared later in the XSD, and the generated
// module evaluates these assignments eagerly (#72).
const sortSimpleTypes = (ir: XsdIr): SimpleTypeDef[] => {
  const types = Object.values(ir.simpleTypes);
  const byName = new Map(types.map((t) => [t.name, t]));
  const dependencies = (t: SimpleTypeDef): SimpleTypeDef[] => {
    const deps =
      t.kind === "restriction" ? [t.baseType] : t.kind === "list" ? [t.itemType] : t.memberTypes;
    return deps
      .map((dep) => byName.get(dep))
      .filter((dep): dep is SimpleTypeDef => dep !== undefined);
  };

  const sorted: SimpleTypeDef[] = [];
  const visited = new Set<string>();
  const visit = (t: SimpleTypeDef): void => {
    if (visited.has(t.name)) {
      return;
    }
    visited.add(t.name);
    for (const dep of dependencies(t)) {
      visit(dep);
    }
    sorted.push(t);
  };
  for (const t of types) {
    visit(t);
  }
  return sorted;
};

const withCardinality = (
  schema: string,
  field: IrField,
  ir: XsdIr,
  forceOptional: boolean,
  structured: boolean,
  usedHelpers: Set<string>,
): string => {
  const kind = resolvePrimitiveKind(field.typeName, ir);
  // Fixed/default literals are values: the type's whiteSpace facet applies to
  // the declared lexical before comparison.
  const ws = kind === "string" ? effectiveWhiteSpace(field.typeName, ir) : undefined;
  let result = schema;
  if (field.fixedValue !== undefined) {
    const fixedValue = wsProcessLiteral(field.fixedValue, ws);
    const listItemType = resolveListItemType(field.typeName, ir);
    if (listItemType === undefined) {
      // Structured date/time fixed: z.literal compares objects by reference, so
      // constrain by canonical lexical equality instead. The value itself is in
      // the field meta (the runtime substitutes present-but-empty content).
      const st = structured ? structuredType(resolveBuiltinLocal(field.typeName, ir)) : undefined;
      if (st) {
        usedHelpers.add(st.writeFn);
        const canonical = writeXsdDatatype(st.name, parseXsdDatatype(st.name, field.fixedValue));
        result += `.refine((val) => ${st.writeFn}(val) === ${JSON.stringify(canonical)}, { message: 'value does not match the fixed value' })`;
      } else {
        // z.literal replaces the type expression, so the type's whiteSpace
        // preprocessing must be re-applied around it (NMTOKENS fixed values
        // compare after collapse).
        const literal = `z.literal(${typedLiteral(kind, fixedValue)})`;
        result =
          ws === undefined
            ? literal
            : `z.preprocess((v) => typeof v === "string" ? ${ws === "collapse" ? XSD_WS_COLLAPSE : XSD_WS_REPLACE} : v, ${literal})`;
      }
    } else {
      // List-typed fixed: the lexical is whitespace-separated items. z.literal
      // cannot deep-compare arrays (zod 4), so constrain the list schema with a
      // refine against the typed array literal.
      const itemSt = structured ? structuredType(resolveBuiltinLocal(listItemType, ir)) : undefined;
      const itemKind = resolvePrimitiveKind(listItemType, ir);
      const tokens = listTokens(field.fixedValue);
      if (itemSt) {
        usedHelpers.add(itemSt.writeFn);
        const canonical = tokens
          .map((token) => writeXsdDatatype(itemSt.name, parseXsdDatatype(itemSt.name, token)))
          .join(" ");
        result += `.refine((val) => val.map((item) => ${itemSt.writeFn}(item)).join(" ") === ${JSON.stringify(canonical)}, { message: 'value does not match the fixed value' })`;
      } else {
        const items = tokens.map((token) => typedLiteral(itemKind, token));
        // Object.is so NaN items (xs:float/xs:double specials) compare equal.
        result += `.refine((val) => val.length === ${items.length} && val.every((item, i) => Object.is(item, [${items.join(", ")}][i])), { message: 'value does not match the fixed value' })`;
      }
    }
  }
  if (field.nillable) {
    result += ".nullable()";
  }
  if (field.maxOccurs === "unbounded" || field.maxOccurs > 1) {
    result = `z.array(${result})`;
    // Skip .min() for choice fields (forceOptional): absent choice branches
    // materialise as [] and must not fail cardinality validation (#73).
    if (field.minOccurs > 0 && !forceOptional) {
      result += `.min(${field.minOccurs})`;
    }
    if (field.maxOccurs !== "unbounded") {
      result += `.max(${field.maxOccurs})`;
    }
    // Merged same-qname siblings with per-position fixed constraints: the
    // array carries them (undefined = unconstrained position).
    if (field.positionalFixeds !== undefined) {
      const itemKind = resolvePrimitiveKind(field.typeName, ir);
      const lits = field.positionalFixeds.map((fx) =>
        fx === undefined ? "undefined" : typedLiteral(itemKind, wsProcessLiteral(fx, ws)),
      );
      result += `.refine((val) => [${lits.join(", ")}].every((fx, i) => fx === undefined || Object.is(val[i], fx)), { message: 'value does not match the fixed value' })`;
    }
  }
  if (field.minOccurs === 0 || forceOptional) {
    result += ".optional()";
  }
  // Attribute defaults apply on absence — zod .default() (after .optional(),
  // which would otherwise make it dead). Element defaults are NOT emitted as
  // .default(): XSD applies them to present-but-empty elements, not absent
  // ones, so the runtime substitutes them via meta.defaultValue (#66).
  if (
    field.kind === "attribute" &&
    field.defaultValue !== undefined &&
    field.fixedValue === undefined
  ) {
    const defaultValue = wsProcessLiteral(field.defaultValue, ws);
    const listItemType = resolveListItemType(field.typeName, ir);
    if (listItemType === undefined) {
      const st = structured ? structuredType(resolveBuiltinLocal(field.typeName, ir)) : undefined;
      result += `.default(${st ? structuredLiteral(st.name, field.defaultValue) : typedLiteral(kind, defaultValue)})`;
    } else {
      const itemSt = structured ? structuredType(resolveBuiltinLocal(listItemType, ir)) : undefined;
      const itemKind = resolvePrimitiveKind(listItemType, ir);
      // A trimmed empty default is an empty list; splitting it would yield a
      // single empty token.
      const trimmed = field.defaultValue.trim();
      const items = (trimmed === "" ? [] : trimmed.split(/\s+/)).map((token) =>
        itemSt ? structuredLiteral(itemSt.name, token) : typedLiteral(itemKind, token),
      );
      result += `.default([${items.join(", ")}])`;
    }
  }
  return result;
};

// Choice groups: multi-branch groups get optional fields + refine.
const choiceBranchMap = (type: ComplexTypeDef, group: string): Map<string, IrField[]> => {
  const byBranch = new Map<string, IrField[]>();
  for (const field of type.fields) {
    if (field.choiceGroup !== group || field.kind !== "element") {
      continue;
    }
    const key = field.choiceBranch ?? toFieldKey(field);
    const branch = byBranch.get(key) ?? [];
    branch.push(field);
    byBranch.set(key, branch);
  }
  for (const guard of Object.values(type.choiceGroupGuards ?? {})) {
    if (guard.group === group && !byBranch.has(guard.branch)) {
      byBranch.set(guard.branch, []);
    }
  }
  return byBranch;
};

const choiceChildren = (type: ComplexTypeDef, group: string, branch: string): string[] =>
  Object.entries(type.choiceGroupGuards ?? {})
    .filter(([, guard]) => guard.group === group && guard.branch === branch)
    .map(([id]) => id);

// Every element field of a group including nested descendant groups (guard ids
// grow along the nesting chain, so the recursion bottoms out).
const choiceSubtreeFields = (type: ComplexTypeDef, group: string): IrField[] => [
  ...type.fields.filter((field) => field.choiceGroup === group && field.kind === "element"),
  ...Object.entries(type.choiceGroupGuards ?? {})
    .filter(([, guard]) => guard.group === group)
    .flatMap(([id]) => choiceSubtreeFields(type, id)),
];

const choiceBranchSubtreeFields = (
  type: ComplexTypeDef,
  group: string,
  branch: string,
): IrField[] => [
  ...type.fields.filter(
    (field) =>
      field.choiceGroup === group &&
      field.kind === "element" &&
      (field.choiceBranch ?? toFieldKey(field)) === branch,
  ),
  ...choiceChildren(type, group, branch).flatMap((child) => choiceSubtreeFields(type, child)),
];

const multiBranchGroups = (type: ComplexTypeDef): Set<string> => {
  const groups = new Set<string>();
  for (const field of type.fields) {
    if (field.choiceGroup && field.kind === "element") {
      groups.add(field.choiceGroup);
    }
  }
  for (const [id, guard] of Object.entries(type.choiceGroupGuards ?? {})) {
    groups.add(id);
    // A choice that only shows up as the guard target of nested choices has no
    // fields of its own, but it is still a choice: its nested branches decide
    // reachability of everything below them.
    groups.add(guard.group);
  }
  const multi = new Set<string>();
  for (const group of groups) {
    // Wildcard branches carry no fields, so they are counted separately.
    const branchCount =
      choiceBranchMap(type, group).size +
      (type.wildcards ?? []).filter((w) => w.choiceGroup === group).length;
    if (branchCount > 1) {
      multi.add(group);
    }
  }
  return multi;
};

// Groups whose element fields must be optional in the object shape: branches
// of a multi-branch choice may not be selected, and a choice nested inside
// such a branch is only reachable when the branch is — so its fields are
// optional too, transitively along the guard chain.
const choiceOptionalGroups = (type: ComplexTypeDef): Set<string> => {
  const optional = multiBranchGroups(type);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, guard] of Object.entries(type.choiceGroupGuards ?? {})) {
      if (!optional.has(id) && optional.has(guard.group)) {
        optional.add(id);
        grew = true;
      }
    }
  }
  return optional;
};

const choiceFlags = (
  type: ComplexTypeDef,
  group: string,
): { required: boolean; repeated: boolean; flat: IrField[]; branches: [string, IrField[]][] } => {
  const map = choiceBranchMap(type, group);
  const entries: [string, IrField[]][] = [...map.entries()];
  const flat = entries.flatMap(([, fields]) => fields);
  const card = type.choiceGroups?.[group];
  const repeated = card !== undefined && (card.maxOccurs === "unbounded" || card.maxOccurs > 1);
  const required =
    flat.length > 0 ? flat.every((f) => f.minOccurs > 0) : card === undefined || card.minOccurs > 0;
  return { required, repeated, flat, branches: entries };
};

const choicesMetaFor = (type: ComplexTypeDef): string => {
  // Collect all group ids: choiceGroups keys + every key and guard.group from
  // choiceGroupGuards (mirror what multiBranchGroups collects).
  const groupIds: Set<string> = new Set();
  if (type.choiceGroups) {
    for (const g of Object.keys(type.choiceGroups)) {
      groupIds.add(g);
    }
  }
  for (const [id, guard] of Object.entries(type.choiceGroupGuards ?? {})) {
    groupIds.add(id);
    groupIds.add(guard.group);
  }

  // If no choice groups, emit nothing.
  if (groupIds.size === 0) {
    return "";
  }

  // Build the choices object entry per group.
  const choices: Record<string, XmlChoiceMeta> = {};

  for (const group of groupIds) {
    const { required: requiredChoice, repeated: repeatedChoice } = choiceFlags(type, group);
    const branchMap = choiceBranchMap(type, group);

    // Per-branch keys.
    const branchesMeta: Array<{ id: string; keys: Array<{ key: string; required: boolean }> }> = [];
    for (const [branchKey, fields] of branchMap) {
      branchesMeta.push({
        id: branchKey,
        keys: fields.map((f) => ({ key: toFieldKey(f), required: f.minOccurs > 0 })),
      });
    }

    // Guard from choiceGroupGuards.
    const guardMeta = type.choiceGroupGuards?.[group];
    const guard = guardMeta ? { group: guardMeta.group, branch: guardMeta.branch } : undefined;

    // Wildcard.
    const wildcard = (type.wildcards ?? []).some((w) => w.choiceGroup === group);

    // Enforce: group is in multiBranchGroups, not wildcard, and NOT (repeated && !required).
    const inMulti = multiBranchGroups(type).has(group);
    const enforce = inMulti && !wildcard && !(repeatedChoice && !requiredChoice);

    // Build the display names for the message.
    // Per branch: fields if non-empty else choiceBranchSubtreeFields, mapped through
    // clarkToLocal(f.qname), joined with "+"; branches joined with ", ".
    const names: string[] = [];
    for (const [branchKey, fields] of branchMap) {
      const display =
        fields.length > 0 ? fields : choiceBranchSubtreeFields(type, group, branchKey);
      const fieldNames = display.map((f) => clarkToLocal(f.qname)).join("+");
      names.push(fieldNames);
    }
    const joinedNames = names.join(", ");

    // Message: repeated ? "at least one" : required ? "exactly one" : "at most one".
    let message: string;
    if (repeatedChoice) {
      message = `choice requires at least one of: ${joinedNames}`;
    } else if (requiredChoice) {
      message = `choice requires exactly one of: ${joinedNames}`;
    } else {
      message = `choice allows at most one of: ${joinedNames}`;
    }

    choices[group] = {
      required: requiredChoice,
      repeated: repeatedChoice,
      branches: branchesMeta,
      message,
      ...(guard ? { guard } : {}),
      ...(wildcard ? { wildcard: true as const } : {}),
      ...(enforce ? { enforce: true as const } : {}),
    };
  }

  return `, choices: ${JSON.stringify(choices)}`;
};

// The structured datatype a type's values arrive in, looking through xs:list
// item types (a list of xs:date holds structured items too). Literals must NOT
// use this: fixed/default lexicals of a list type are whitespace-separated.
const structuredTypeOfTypeName = (
  typeName: QName,
  ir: XsdIr,
): ReturnType<typeof structuredType> => {
  const direct = structuredType(resolveBuiltinLocal(typeName, ir));
  if (direct) {
    return direct;
  }
  const simple = ir.simpleTypes[typeName];
  return simple?.kind === "list"
    ? structuredType(resolveBuiltinLocal(simple.itemType, ir))
    : undefined;
};

// QName/NOTATION values carry a namespace prefix in their lexical; the runtime
// must record the binding at parse time so the serializer can re-declare it.
const isQNameTyped = (typeName: QName, ir: XsdIr, seen?: Set<string>): boolean => {
  const builtin = resolveBuiltinLocal(typeName, ir);
  if (builtin !== undefined) {
    return builtin === "QName" || builtin === "NOTATION";
  }
  const seenNames = seen ?? new Set<string>();
  if (seenNames.has(typeName)) {
    return false;
  }
  seenNames.add(typeName);
  const simple = ir.simpleTypes[typeName];
  if (simple?.kind === "union") {
    return simple.memberTypes.some((member) => isQNameTyped(member, ir, seenNames));
  }
  if (simple?.kind === "list") {
    return isQNameTyped(simple.itemType, ir, seenNames);
  }
  return false;
};

// List-aware fixed-value meta emission shared by fields and roots: a list
// lexical is whitespace-separated items, so the meta carries a typed array
// (or the raw lexical for structured items) instead of a scalar literal.
// Roots additionally carry the coerced scalar for plain types and the fixed
// lexical in every mode — their schema never encodes the fixed constraint
// (no z.literal / refine), so the runtime reads it from the meta alone.
const fixedValueMetaParts = (
  typeName: QName,
  fixedValue: string,
  ir: XsdIr,
  structured: boolean,
  root = false,
): string[] => {
  const parts: string[] = [];
  const listItemType = resolveListItemType(typeName, ir);
  if (listItemType !== undefined) {
    // List-typed fixed values ride a refine, not a z.literal, so the
    // runtime cannot read the fixed value from the schema def; substitute
    // the typed array from the meta on absence (attributes) /
    // present-but-empty (elements). An empty fixed lexical is an empty
    // list: the raw "" would split into [""] and fail item validation.
    const itemSt = structured ? structuredType(resolveBuiltinLocal(listItemType, ir)) : undefined;
    if (itemSt) {
      // Structured items transform from the lexical, so the meta carries
      // the raw lexical for the schema's preprocess to split and parse.
      const trimmed = fixedValue.trim();
      parts.push(`fixedValue: ${trimmed === "" ? "[]" : JSON.stringify(fixedValue)}`);
    } else {
      parts.push(`fixedValue: ${listLiteral(typeName, ir, fixedValue)}`);
    }
  } else if (structured && structuredTypeOfTypeName(typeName, ir)) {
    // Structured fixed values cannot ride a z.literal (reference equality
    // on objects): the constraint is a canonical-lexical refine and the
    // runtime substitutes the lexical from here (validation transforms it).
    parts.push(`fixedValue: ${JSON.stringify(fixedValue)}`);
  } else if (root) {
    // Plain-typed roots: the schema is the bare type, so the runtime needs
    // the coerced value in the meta (fields read it from z.literal).
    const kind = resolvePrimitiveKind(typeName, ir);
    parts.push(
      `fixedValue: ${typedLiteral(kind, wsProcessLiteral(fixedValue, kind === "string" ? effectiveWhiteSpace(typeName, ir) : undefined))}`,
    );
  }
  if (!structured || root) {
    // The serializer re-emits the declared fixed lexical (see XmlFieldMeta).
    parts.push(`fixedLexical: ${JSON.stringify(fixedValue)}`);
  }
  return parts;
};

// List-aware default-value meta emission shared by fields and roots: a list
// lexical is whitespace-separated items, so the meta carries a typed array
// (or the raw lexical for structured items) instead of a scalar literal. The
// declared lexical rides along so the runtime can retain it on substitution —
// facet checks and re-serialization need the original form, not the coerced
// value's canonical one.
const defaultValueMetaParts = (
  typeName: QName,
  defaultValue: string,
  ir: XsdIr,
  structured: boolean,
): string[] => {
  const listItemType = resolveListItemType(typeName, ir);
  const parts =
    listItemType === undefined
      ? (() => {
          const kind = resolvePrimitiveKind(typeName, ir);
          return [
            `defaultValue: ${typedLiteral(kind, wsProcessLiteral(defaultValue, kind === "string" ? effectiveWhiteSpace(typeName, ir) : undefined))}`,
          ];
        })()
      : (() => {
          const itemSt = structured
            ? structuredType(resolveBuiltinLocal(listItemType, ir))
            : undefined;
          if (itemSt) {
            // Structured items transform from the lexical, so the meta carries the
            // raw lexical for the schema's preprocess to split and parse.
            const trimmed = defaultValue.trim();
            return [`defaultValue: ${trimmed === "" ? "[]" : JSON.stringify(defaultValue)}`];
          }
          return [`defaultValue: ${listLiteral(typeName, ir, defaultValue)}`];
        })();
  if (!structured) {
    parts.push(`defaultLexical: ${JSON.stringify(defaultValue)}`);
  }
  return parts;
};

// Same-qname element fields that survive the IR's adjacent merge (separated
// by other particles — e.g. choice branches, or a group ref between them)
// still share one object key: the generated shape, the interface and the
// fields meta must not repeat it (a duplicate key silently drops the first
// entry). Merge them for emission: the field becomes one repeated field whose
// cardinality accumulates across the members. Choice-branch structure is read
// from the unmerged fields (choiceBranchMap & co.), so the IR list stays
// untouched.
const dedupeEmissionFields = (type: ComplexTypeDef): IrField[] => {
  const byKey = new Map<string, IrField[]>();
  for (const field of type.fields) {
    const key = toFieldKey(field);
    const group = byKey.get(key) ?? [];
    group.push(field);
    byKey.set(key, group);
  }
  if ([...byKey.values()].every((members) => members.length === 1)) {
    return type.fields;
  }

  // A wildcard between two same-qname particles owns the intervening
  // occurrences — the fields must not merge across it.
  const wildcardPositions = new Set(
    (type.wildcards ?? []).flatMap((w) => (w.position === undefined ? [] : [w.position])),
  );
  const elementOrdinals = new Map<IrField, number>();
  let ordinal = 0;
  for (const field of type.fields) {
    if (field.kind === "element") {
      elementOrdinals.set(field, ordinal++);
    }
  }
  // A wildcard at position P sits between element ordinals P-1 and P, so it
  // owns intervening occurrences — fields must not merge across it.
  const separatedByWildcard = (a: IrField, b: IrField): boolean => {
    const [lo, hi] = [elementOrdinals.get(a) ?? 0, elementOrdinals.get(b) ?? 0];
    for (const pos of wildcardPositions) {
      if (pos > lo && pos <= hi) {
        return true;
      }
    }
    return false;
  };

  const sumMax = (members: IrField[]): number | "unbounded" =>
    members.some((f) => f.maxOccurs === "unbounded")
      ? "unbounded"
      : members.reduce((sum, f) => sum + (f.maxOccurs as number), 0);

  const mergeGroup = (members: IrField[]): IrField => {
    const first = members[0]!;
    // Choice-group members: branches are exclusive, so the group's
    // contribution is per-branch sums, max across branches for maxOccurs;
    // a branch missing the key (or an optional group) means minOccurs 0.
    const choiceGroups = new Set(
      members.map((f) => f.choiceGroup).filter((g): g is string => g !== undefined),
    );
    const choiceless = members.filter((f) => f.choiceGroup === undefined);
    let minOccurs = choiceless.reduce((sum, f) => sum + f.minOccurs, 0);
    let maxOccurs: number | "unbounded" = sumMax(choiceless);
    for (const groupId of choiceGroups) {
      const groupMembers = members.filter((f) => f.choiceGroup === groupId);
      const branches = choiceBranchMap(type, groupId);
      const branchIds = new Set(branches.keys());
      const coveredBranches = new Set(groupMembers.map((f) => f.choiceBranch ?? toFieldKey(f)));
      const card = type.choiceGroups?.[groupId];
      const repeated = card !== undefined && (card.maxOccurs === "unbounded" || card.maxOccurs > 1);
      const optionalGroup = card === undefined || card.minOccurs === 0;
      let groupMin = 0;
      let groupMax: number | "unbounded" = 0;
      for (const branch of coveredBranches) {
        const branchMembers = groupMembers.filter(
          (f) => (f.choiceBranch ?? toFieldKey(f)) === branch,
        );
        const branchMax = sumMax(branchMembers);
        groupMax =
          groupMax === "unbounded" || branchMax === "unbounded"
            ? "unbounded"
            : Math.max(groupMax, branchMax);
        groupMin = Math.max(groupMin, branchMembers.reduce((sum, f) => sum + f.minOccurs, 0));
      }
      if (optionalGroup || [...branchIds].some((b) => !coveredBranches.has(b))) {
        groupMin = 0;
      }
      if (repeated && groupMax !== "unbounded" && card !== undefined) {
        groupMax = card.maxOccurs === "unbounded" ? "unbounded" : groupMax * card.maxOccurs;
        groupMin = groupMin * card.minOccurs;
      }
      minOccurs += groupMin;
      maxOccurs =
        maxOccurs === "unbounded" || groupMax === "unbounded"
          ? "unbounded"
          : maxOccurs + groupMax;
    }
    const uniform = <T>(pick: (f: IrField) => T): T | undefined =>
      members.every((f) => Object.is(pick(f), pick(members[0]!))) ? pick(first) : undefined;
    const sameArray = (
      a: readonly (string | undefined)[] | undefined,
      b: readonly (string | undefined)[] | undefined,
    ): boolean =>
      a === b ||
      (a !== undefined &&
        b !== undefined &&
        a.length === b.length &&
        a.every((v, i) => v === b[i]));
    const positionalFixeds0 = first.positionalFixeds;
    const positionalFixeds = members.every((f) => sameArray(f.positionalFixeds, positionalFixeds0))
      ? positionalFixeds0
      : undefined;
    const merged: IrField = {
      ...first,
      minOccurs,
      maxOccurs,
      ...optPropU("defaultValue", uniform((f) => f.defaultValue)),
      ...optPropU("fixedValue", uniform((f) => f.fixedValue)),
      ...optPropU("positionalFixeds", positionalFixeds),
      ...optPropU(
        "choiceGroup",
        members.every((f) => f.choiceGroup !== undefined) && choiceGroups.size === 1
          ? [...choiceGroups][0]
          : undefined,
      ),
    };
    // The merged field spans every member's branch — it is not branch-scoped.
    delete merged.choiceBranch;
    return merged;
  };

  const out: IrField[] = [];
  const emitted = new Set<string>();
  for (const field of type.fields) {
    const key = toFieldKey(field);
    const members = byKey.get(key) ?? [];
    const mergeable =
      members.length > 1 &&
      members.every(
        (f) =>
          f.kind === "element" &&
          f.qname === field.qname &&
          f.typeName === field.typeName &&
          f.nillable === field.nillable,
      ) &&
      members.every((f, i) => i === 0 || !separatedByWildcard(members[i - 1]!, f));
    if (!mergeable) {
      out.push(field);
      continue;
    }
    if (emitted.has(key)) {
      continue;
    }
    emitted.add(key);
    out.push(mergeGroup(members));
  }
  return out;
};

const optPropU = <K extends string, T>(key: K, value: T | undefined): Record<K, T> | object =>
  value === undefined ? {} : { [key]: value };

// Per-field XML knowledge lives on the containing object schema: a named type
// can be referenced by several elements with different qnames, so field-level
// meta on shared schemas would conflict.
const fieldsMetaFor = (
  type: ComplexTypeDef,
  ir: XsdIr,
  structured: boolean,
  membersByHead: ReadonlyMap<QName, ElementDef[]>,
): string => {
  const entries = dedupeEmissionFields(type).map((field) => {
    const parts = [`kind: ${JSON.stringify(field.kind)}`, `qname: ${JSON.stringify(field.qname)}`];
    const substMembers = membersByHead.get(field.qname);
    if (substMembers !== undefined && substMembers.length > 0) {
      parts.push(`substitutes: ${JSON.stringify(substMembers.map((m) => m.name))}`);
    }
    if (field.typeName === "{http://www.w3.org/2001/XMLSchema}anyType") {
      parts.push("open: true");
    }
    const st = structured ? structuredTypeOfTypeName(field.typeName, ir) : undefined;
    if (st) {
      // Lets the serializer canonicalize structured values back to lexicals.
      parts.push(`datatype: ${JSON.stringify(st.name)}`);
    }
    if (field.kind === "element" || field.kind === "attribute") {
      if (isQNameTyped(field.typeName, ir)) {
        parts.push("qnameValue: true");
      }
    }
    // The runtime substitutes meta defaults before validation, so even in
    // structured mode the meta holds the lexical — the schema's transform
    // turns it into the structured value. Attribute defaults only need the
    // meta in structured mode: string mode reads them from the zod def.
    if (
      field.defaultValue !== undefined &&
      field.fixedValue === undefined &&
      (field.kind === "element" || (structured && st && field.kind === "attribute"))
    ) {
      parts.push(...defaultValueMetaParts(field.typeName, field.defaultValue, ir, structured));
    }
    if (field.fixedValue !== undefined) {
      parts.push(...fixedValueMetaParts(field.typeName, field.fixedValue, ir, structured));
    }
    if (field.positionalFixeds !== undefined) {
      const lits = field.positionalFixeds.map((fx) =>
        fx === undefined ? "undefined" : JSON.stringify(fx),
      );
      parts.push(`fixedLexicals: [${lits.join(", ")}]`);
    }
    return `${JSON.stringify(toFieldKey(field))}: { ${parts.join(", ")} }`;
  });
  // Wildcard sentinels: '*' sweeps unmatched child elements, '@*' unmatched
  // attributes into the open shape. Several element wildcards get distinct
  // keys plus their namespace constraint, so the serializer can attribute
  // each extra to the wildcard allowing it (see XmlFieldMeta).
  const anyWildcards = (type.wildcards ?? []).filter((w) => w.kind === "any");
  anyWildcards.forEach((wildcard, i) => {
    const parts = [`kind: "any"`, `qname: "{}*"`];
    if (wildcard.position !== undefined) {
      parts.push(`position: ${wildcard.position}`);
    }
    if (anyWildcards.length > 1) {
      parts.push(`namespaceConstraint: ${JSON.stringify(wildcard.namespaceConstraint)}`);
    }
    entries.push(`${JSON.stringify(i === 0 ? "*" : `*${i + 1}`)}: { ${parts.join(", ")} }`);
  });
  if ((type.wildcards ?? []).some((w) => w.kind === "anyAttribute")) {
    entries.push(`"@*": { kind: "anyAttribute", qname: "{}*" }`);
  }
  return `qname: ${JSON.stringify(type.name)}, fields: { ${entries.join(", ")} }${choicesMetaFor(type)}`;
};

// Head element qname → substitution-group member declarations, transitively
// closed (a member's own members substitute for the head as well).
const substitutionMembersByHead = (ir: XsdIr): Map<QName, ElementDef[]> => {
  const direct = new Map<QName, QName[]>();
  for (const element of Object.values(ir.elements)) {
    if (element.substitutionGroup === undefined) {
      continue;
    }
    const list = direct.get(element.substitutionGroup) ?? [];
    list.push(element.name);
    direct.set(element.substitutionGroup, list);
  }
  const result = new Map<QName, ElementDef[]>();
  for (const head of direct.keys()) {
    const members: ElementDef[] = [];
    const seen = new Set<QName>([head]);
    const walk = (current: QName): void => {
      for (const memberName of direct.get(current) ?? []) {
        if (seen.has(memberName)) {
          continue;
        }
        seen.add(memberName);
        const member = ir.elements[memberName];
        if (member !== undefined) {
          members.push(member);
        }
        walk(memberName);
      }
    };
    walk(head);
    result.set(head, members);
  }
  return result;
};

// ---------------------------------------------------------------------------
// xsi:type polymorphism: a slot (element field or root element) whose
// declared complex type is abstract or has known derived types is emitted as z.discriminatedUnion over per-type variant schemas, keyed on a
// synthetic xsiType property holding the type's Clark qname. The derivation
// index is built from the IR's complexContent extension (baseType) and
// restriction (restrictionBase) edges; schema sets without such edges (and
// without abstract types) emit exactly the same code as before.
// ---------------------------------------------------------------------------

// Known derivation bases of a complex type (extension or restriction where the
// base is a known complex type).
const knownDerivationBases = (type: ComplexTypeDef, ir: XsdIr): QName[] => {
  const bases: QName[] = [];
  for (const base of [type.baseType, type.restrictionBase]) {
    if (base !== undefined && ir.complexTypes[base] !== undefined && base !== type.name) {
      bases.push(base);
    }
  }
  return bases;
};

// Base type qname → direct derived type qnames, in declaration order. Only
// edges whose base is a known complex type count.
const derivationIndex = (ir: XsdIr): Map<QName, QName[]> => {
  const index = new Map<QName, QName[]>();
  for (const type of Object.values(ir.complexTypes)) {
    for (const base of knownDerivationBases(type, ir)) {
      const list = index.get(base) ?? [];
      if (!list.includes(type.name)) {
        list.push(type.name);
      }
      index.set(base, list);
    }
  }
  return index;
};

// All types derived from base, transitively, in breadth-first declaration
// order. Cycle-safe (invalid XSD with derivation cycles). The worklist array
// grows during iteration; JS array iterators observe appended elements.
const derivedClosure = (base: QName, index: ReadonlyMap<QName, QName[]>): QName[] => {
  const result: QName[] = [];
  const seen = new Set<QName>([base]);
  const worklist = [...(index.get(base) ?? [])];
  for (const current of worklist) {
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    result.push(current);
    worklist.push(...(index.get(current) ?? []));
  }
  return result;
};

// ---------------------------------------------------------------------------
// Small emitter layer — systematic codegen helpers instead of raw string
// concatenation.  Centralises schema-reference formatting, .register() calls,
// with-description wrapping, and reserved-keyword / forward-ref wiring so that
// the structural logic in irToZod stays readable (#84).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Static types (#146). Every named type becomes a standalone const so its
// inferred zod type survives; the old `schemas: Record<string, z.ZodTypeAny>`
// registry erased all of it (z.infer → any). Complex types additionally get
// an exported TS interface, and their schema const is annotated
// z.ZodType<Interface> — the annotation breaks the circular type inference
// that mutually recursive types would otherwise trigger.
// ---------------------------------------------------------------------------

// Parenthesize union type expressions when nested in an array.
const tsArrayOf = (type: string): string => `${type.includes(" | ") ? `(${type})` : type}[]`;

// TS output type for a type reference, mirroring the runtime output of the
// generated zod expression. Interfaces exist only for complex types; simple
// types are inlined structurally. `dt` is set in structured mode and collects
// the xsdDateTime type names the generated module must import.
const tsTypeOfTypeName = (
  typeName: QName,
  ir: XsdIr,
  ifaceName: ReadonlyMap<QName, string>,
  seen: Set<QName>,
  dt: { usedTypes: Set<string> } | undefined,
): string => {
  const parts = trySplitClark(typeName);
  if (!parts) {
    return "unknown";
  }
  if (parts.ns === XSD_NS) {
    if (XSD_BIGINT_TYPE_NAMES.has(parts.local)) {
      return "bigint";
    }
    if (XSD_SAFE_INTEGER_TYPE_NAMES.has(parts.local)) {
      return "number";
    }
    const st = dt ? structuredType(parts.local) : undefined;
    if (st) {
      dt?.usedTypes.add(st.tsType);
      return st.tsType;
    }
    switch (parts.local) {
      case "anyType":
        return "unknown";
      case "boolean":
        return "boolean";
      case "decimal":
      case "float":
      case "double":
        return "number";
      default:
        return "string";
    }
  }
  if (ir.complexTypes[typeName] !== undefined) {
    return ifaceName.get(typeName) ?? "unknown";
  }
  const simple = ir.simpleTypes[typeName];
  if (simple === undefined || seen.has(typeName)) {
    return "unknown";
  }
  seen.add(typeName);
  if (simple.kind === "list") {
    return tsArrayOf(tsTypeOfTypeName(simple.itemType, ir, ifaceName, seen, dt));
  }
  if (simple.kind === "union") {
    const members = simple.memberTypes.map((mt) => tsTypeOfTypeName(mt, ir, ifaceName, seen, dt));
    return members.length > 0 ? members.join(" | ") : "unknown";
  }
  // Restriction: a pure enumeration on a direct builtin base becomes a
  // literal union (mirrors withFacets); anything else has the base's type.
  const facets = simple.facets ?? [];
  const enumFacets = facets.filter((f) => f.kind === "enumeration");
  const otherFacets = facets.filter((f) => f.kind !== "enumeration" && f.kind !== "whiteSpace");
  const baseParts = trySplitClark(simple.baseType);
  if (
    enumFacets.length > 0 &&
    otherFacets.length === 0 &&
    baseParts?.ns === XSD_NS &&
    baseParts.local !== "anyType"
  ) {
    // Structured enums have no literal types (objects); the base type it is.
    const st = dt ? structuredType(baseParts.local) : undefined;
    if (st) {
      dt?.usedTypes.add(st.tsType);
      return st.tsType;
    }
    // Date/time builtins route the enum check to the runtime meta (value-space
    // compare), so the value keeps the builtin's string form.
    if (XSD_STRUCTURED_TYPES.has(baseParts.local)) {
      return "string";
    }
    const kind = resolvePrimitiveKind(simple.baseType, ir);
    return enumFacets.map((f) => typedLiteral(kind, f.value)).join(" | ");
  }
  return tsTypeOfTypeName(simple.baseType, ir, ifaceName, seen, dt);
};

// Escape `*/` and format a description as a JSDoc block.
// Single-line → `/** text */`, multi-line → `/**\n * line1\n * line2\n */`.
const formatJsDoc = (text: string, indent = 0): string => {
  const safe = text.replace(/\*\//g, "*\\/");
  const spaces = " ".repeat(indent);
  const lines = safe.split("\n");
  if (lines.length === 1) {
    return `${spaces}/** ${safe} */`;
  }
  return `${spaces}/**\n${lines.map((l) => `${spaces} * ${l}`).join("\n")}\n${spaces} */`;
};

// One interface property line for a field, mirroring withCardinality:
// optionality from minOccurs/choice, [] from maxOccurs, null from nillable,
// literal types for fixed values. Attribute defaults make the zod output
// non-optional (.default() fills absence).
const tsFieldLine = (
  field: IrField,
  ir: XsdIr,
  ifaceName: ReadonlyMap<QName, string>,
  forceOptional: boolean,
  dt: { usedTypes: Set<string> } | undefined,
  membersByHead: ReadonlyMap<QName, ElementDef[]>,
  polymorphicSlotType?: (field: IrField) => string | undefined,
): string => {
  let type: string;
  const polymorphicType = field.fixedValue === undefined ? polymorphicSlotType?.(field) : undefined;
  if (polymorphicType !== undefined) {
    type = polymorphicType;
  } else if (field.fixedValue === undefined) {
    const headType = tsTypeOfTypeName(field.typeName, ir, ifaceName, new Set(), dt);
    const substMembers = membersByHead.get(field.qname) ?? [];
    // The field accepts any substitution-group member: the TS type is the
    // union of the member types and the head type (deduped).
    const types = [
      ...new Set([
        ...substMembers.map((m) => tsTypeOfTypeName(m.typeName, ir, ifaceName, new Set(), dt)),
        headType,
      ]),
    ];
    type = types.join(" | ");
  } else if (resolveListItemType(field.typeName, ir) === undefined) {
    // Structured fixed values have no literal type; the base type it is.
    const st = dt ? structuredType(resolveBuiltinLocal(field.typeName, ir)) : undefined;
    if (st) {
      dt?.usedTypes.add(st.tsType);
      type = st.tsType;
    } else {
      type = typedLiteral(
        resolvePrimitiveKind(field.typeName, ir),
        wsProcessLiteral(
          field.fixedValue,
          resolvePrimitiveKind(field.typeName, ir) === "string"
            ? effectiveWhiteSpace(field.typeName, ir)
            : undefined,
        ),
      );
    }
  } else {
    // List-typed fixed: the schema keeps the list type (the constraint is a
    // refine, not a literal), so the interface does too.
    type = tsTypeOfTypeName(field.typeName, ir, ifaceName, new Set(), dt);
  }
  if (field.nillable) {
    type += " | null";
  }
  if (field.maxOccurs === "unbounded" || field.maxOccurs > 1) {
    type = tsArrayOf(type);
  }
  const hasAttributeDefault =
    field.kind === "attribute" &&
    field.defaultValue !== undefined &&
    field.fixedValue === undefined;
  const optional = (field.minOccurs === 0 || forceOptional) && !hasAttributeDefault;
  // `.optional()` yields `T | undefined` at runtime; the interface must say so
  // too or `z.ZodType<Iface>` assignments fail under exactOptionalPropertyTypes.
  if (optional) {
    type += " | undefined";
  }
  const prop = `  ${JSON.stringify(toFieldKey(field))}${optional ? "?" : ""}: ${type};`;
  if (!field.description) {
    return prop;
  }
  return `${formatJsDoc(field.description, 2)}\n${prop}`;
};

/**
 * Build a `.register(xmlRegistry, { … })` suffix with optional `.describe()`.
 * `metaBody` is the pre-formatted interior of the meta object literal (e.g.
 * `qname: "...", fields: { ... }`).
 */
const registered = (expr: string, description: string | undefined, metaBody: string): string =>
  `${withDescription(expr, description)}.register(xmlRegistry, { ${metaBody} })`;

// Names TS forbids as interface identifiers (primitive/literal type keywords).
// An XSD type named "boolean" or "any" gets a Type suffix instead.
const TS_TYPE_RESERVED = new Set([
  "any",
  "unknown",
  "never",
  "void",
  "undefined",
  "null",
  "string",
  "number",
  "boolean",
  "object",
  "symbol",
  "bigint",
  "true",
  "false",
  "this",
  "infer",
  "function",
  "intrinsic",
]);

export type IrToZodOptions = {
  // Emit plain JavaScript (no TS type annotations) so the output can be
  // imported directly as .mjs — used by the CLI validate subcommand.
  js?: boolean;
  // "structured" parses the XSD date/time builtins into plain objects
  // (xsdDateTime.ts) via a transform after the lexical check; "string"
  // (default) keeps them as validated strings.
  datatypes?: "string" | "structured";
};

export const irToZod = (ir: XsdIr, opts?: IrToZodOptions): { schemas: string } => {
  const structured = opts?.datatypes === "structured";
  const schemaLines: string[] = [];
  const definedTypes = new Set<string>([
    ...Object.keys(ir.simpleTypes),
    ...Object.keys(ir.complexTypes),
  ]);
  const usage: FacetUsage = { totalDigits: false, fractionDigits: false };
  const usedHelpers = new Set<string>();
  const usedTypes = new Set<string>();
  const dt = structured && !opts?.js ? { usedTypes } : undefined;
  // Merged lexical facets per emitted simple type (derivation-chain complete).
  const lexicalFacetsByType = new Map<QName, XmlLexicalFacets>();

  // Unique identifiers for the generated module, shared across value and type
  // space so an interface can never shadow a root export (public API of
  // generated modules — those names keep their historic shape).
  const exportNames = rootSchemaExportNames(ir.rootElements);
  const membersByHead = substitutionMembersByHead(ir);

  // xsi:type polymorphism. variantSets maps a polymorphic declared type
  // (abstract, or with known derived types) to [declared, ...derivedClosure].
  // familyTypes is every type appearing in any variant set — those get an
  // eager object const (the discriminatedUnion options must be real object
  // schemas) plus a variant const extended with the xsiType discriminant.
  const derivedIndex = derivationIndex(ir);
  const derivedTypeNames = new Set<QName>([...derivedIndex.values()].flat());
  const variantSets = new Map<QName, QName[]>();
  for (const type of Object.values(ir.complexTypes)) {
    const closure = derivedClosure(type.name, derivedIndex);
    if (closure.length > 0) {
      variantSets.set(type.name, [type.name, ...closure]);
    }
  }
  const familyTypes = new Set<QName>([...variantSets.values()].flat());
  const usedNames = new Set<string>(exportNames.values());
  const alloc = (base: string): string => {
    let name = base;
    let n = 2;
    while (usedNames.has(name)) {
      name = `${base}${n}`;
      n += 1;
    }
    usedNames.add(name);
    return name;
  };
  const constName = new Map<QName, string>();
  const ifaceName = new Map<QName, string>();
  const sortedSimpleTypes = sortSimpleTypes(ir);
  for (const t of sortedSimpleTypes) {
    constName.set(t.name, alloc(`${sanitizeIdentifier(clarkToLocal(t.name))}Schema`));
  }
  for (const t of Object.values(ir.complexTypes)) {
    const local = sanitizeIdentifier(clarkToLocal(t.name));
    constName.set(t.name, alloc(`${local}Schema`));
    ifaceName.set(t.name, alloc(TS_TYPE_RESERVED.has(local) ? `${local}Type` : local));
  }
  // Auxiliary consts for polymorphic families: the eager object (variant
  // option source), the xsiType-carrying variant, and the union per
  // polymorphic declared type.
  const objectConstName = new Map<QName, string>();
  const variantConstName = new Map<QName, string>();
  const unionConstName = new Map<QName, string>();
  for (const name of familyTypes) {
    const local = sanitizeIdentifier(clarkToLocal(name));
    objectConstName.set(name, alloc(`${local}ObjectSchema`));
    variantConstName.set(name, alloc(`${local}VariantSchema`));
  }
  for (const name of variantSets.keys()) {
    unionConstName.set(name, alloc(`${sanitizeIdentifier(clarkToLocal(name))}VariantsSchema`));
  }

  schemaLines.push("// AUTO-GENERATED — DO NOT EDIT");
  const importLineIndex = schemaLines.length;
  schemaLines.push(""); // import line, filled in at the end once facet usage is known

  // Simple and complex types share the generated module's value namespace —
  // a qname collision would silently reference the wrong const. Fail loud.
  const claimedTypeNames = new Set<string>();
  const claimTypeName = (qname: string): void => {
    if (claimedTypeNames.has(qname)) {
      throw new Xsd2ZodError(
        "type-name-collision",
        `type name collision: ${qname} is declared as both a simpleType and a complexType`,
      );
    }
    claimedTypeNames.add(qname);
  };

  // TS type of a polymorphic slot: the declared type plus its derived types,
  // each intersected with its xsiType discriminant. The discriminant is
  // optional on family roots (parsed plain occurrences carry none) and
  // required on derived types (parsed derived values always carry it; the
  // schema's .default() fills it for hand-built input).
  const tsVariantUnionType = (typeName: QName): string =>
    (variantSets.get(typeName) ?? [typeName])
      .map((variant) => {
        const iface = ifaceName.get(variant) ?? "unknown";
        const discriminant = JSON.stringify(variant);
        return derivedTypeNames.has(variant)
          ? `(${iface} & { "xsiType": ${discriminant} })`
          : `(${iface} & { "xsiType"?: ${discriminant} | undefined })`;
      })
      .join(" | ");

  // Polymorphic slot check, shared by the schema and the TS type emission. A
  // field that also references a substitution-group head keeps the
  // substitution union: tag-based member dispatch already covers it, and the
  // two mechanisms are not combined.
  const polymorphicVariants = (field: IrField): QName[] | undefined => {
    if (field.kind !== "element") {
      return undefined;
    }
    const variants = variantSets.get(field.typeName);
    if (variants === undefined) {
      return undefined;
    }
    const substMembers = membersByHead.get(field.qname);
    return substMembers === undefined || substMembers.length === 0 ? variants : undefined;
  };

  // Field value schema: the field's type, or — when the field references a
  // substitution-group head — a union of per-element options (head + all
  // members). Each option is a lazy wrapper registered with its element
  // qname (XmlMeta.substElement): the runtime matches the actual element tag
  // against these to read and serialize with the right type. Members come
  // first: they are the more specific types, so a validating member branch
  // is picked before the head's looser shape could strip member-only content.
  //
  // A polymorphic slot (xsi:type) instead references the discriminated union
  // of its declared type's variants. In eager context (family object consts,
  // evaluated at module init) every reference to a complex type or union
  // const is lazy-wrapped so declaration order and recursion cannot bite.
  const fieldTypeExpr = (field: IrField, eager: boolean): string => {
    const variants = polymorphicVariants(field);
    if (variants !== undefined) {
      const union = unionConstName.get(field.typeName) ?? "z.unknown()";
      if (!eager) {
        return union;
      }
      // The return-type annotation breaks circular type inference between
      // mutually recursive family object consts.
      return opts?.js
        ? `z.lazy(() => ${union})`
        : `z.lazy((): z.ZodType<${tsVariantUnionType(field.typeName)}> => ${union})`;
    }
    const headExpr = primitiveToZod(
      field.typeName,
      definedTypes,
      constName,
      usedHelpers,
      structured,
    );
    const eagerHeadExpr =
      eager && ir.complexTypes[field.typeName] !== undefined && definedTypes.has(field.typeName)
        ? `z.lazy(() => ${headExpr})`
        : headExpr;
    const substMembers = membersByHead.get(field.qname);
    if (substMembers === undefined || substMembers.length === 0) {
      return eagerHeadExpr;
    }
    const option = (expr: string, qname: QName): string =>
      `z.lazy(() => ${expr}).register(xmlRegistry, { substElement: ${JSON.stringify(qname)} })`;
    const options = [
      ...substMembers.map((m) =>
        option(
          primitiveToZod(m.typeName, definedTypes, constName, usedHelpers, structured),
          m.name,
        ),
      ),
      option(headExpr, field.qname),
    ];
    return `z.union([${options.join(", ")}])`;
  };

  // Object shape properties of a complex type. Eager mode is for the family
  // object consts; the main consts wrap their shape in z.lazy as before.
  const objectPropsExpr = (complexType: ComplexTypeDef, eager: boolean): string => {
    const multiBranch = choiceOptionalGroups(complexType);
    return dedupeEmissionFields(complexType)
      .map(
        (field) =>
          `${JSON.stringify(toFieldKey(field))}: ${withDescription(
            withCardinality(
              fieldTypeExpr(field, eager),
              field,
              ir,
              field.choiceGroup !== undefined && multiBranch.has(field.choiceGroup),
              structured,
              usedHelpers,
            ),
            field.description,
          )}`,
      )
      .join(", ");
  };

  // Interfaces first: exported so consumers can name the inferred types, and
  // the const annotations below refer to them. js mode has no type level.
  if (!opts?.js) {
    for (const complexType of Object.values(ir.complexTypes)) {
      claimTypeName(complexType.name);
      const multiBranch = choiceOptionalGroups(complexType);
      const props = dedupeEmissionFields(complexType)
        .map((field) =>
          tsFieldLine(
            field,
            ir,
            ifaceName,
            field.choiceGroup !== undefined && multiBranch.has(field.choiceGroup),
            dt,
            membersByHead,
            (f) =>
              polymorphicVariants(f) === undefined ? undefined : tsVariantUnionType(f.typeName),
          ),
        )
        .join("\n");
      const indexSignature =
        complexType.wildcards && complexType.wildcards.length > 0
          ? "\n  [key: string]: unknown;"
          : "";
      const jsDoc = complexType.description ? `${formatJsDoc(complexType.description, 0)}\n` : "";
      schemaLines.push(
        `${jsDoc}export interface ${ifaceName.get(complexType.name)} {\n${props}${indexSignature}\n}`,
      );
    }
  }

  for (const simpleType of sortedSimpleTypes) {
    claimTypeName(simpleType.name);
    let expr: string;
    if (simpleType.kind === "list") {
      const itemExpr = primitiveToZod(
        simpleType.itemType,
        definedTypes,
        constName,
        usedHelpers,
        structured,
      );
      expr = `z.preprocess((v) => typeof v === "string" ? v.trim().split(/\\s+/) : v, z.array(${itemExpr}))`;
    } else if (simpleType.kind === "union") {
      const memberExprs = simpleType.memberTypes.map((mt) =>
        primitiveToZod(mt, definedTypes, constName, usedHelpers, structured),
      );
      expr = `z.union([${memberExprs.join(", ")}])`;
    } else {
      const baseExpr = primitiveToZod(
        simpleType.baseType,
        definedTypes,
        constName,
        usedHelpers,
        structured,
      );
      const lexical: XmlLexicalFacets = {};
      expr = simpleType.facets
        ? withFacets(
            baseExpr,
            simpleType.facets,
            usage,
            resolvePrimitiveKind(simpleType.name, ir),
            resolveBuiltinLocal(simpleType.name, ir),
            structured,
            usedHelpers,
            resolveBaseStructure(simpleType.baseType, ir),
            lexical,
          )
        : baseExpr;
      const merged = mergeLexicalFacets(lexicalFacetsByType.get(simpleType.baseType), lexical);
      if (merged !== undefined) {
        lexicalFacetsByType.set(simpleType.name, merged);
        // .register mutates its receiver's registry entry: register the meta
        // on a fresh clone so a derived type never clobbers its base's.
        expr = `z.clone(${expr})`;
        schemaLines.push(
          `const ${constName.get(simpleType.name)} = ${registered(
            expr,
            simpleType.description,
            `qname: ${JSON.stringify(simpleType.name)}, facets: ${JSON.stringify(merged)}`,
          )};`,
        );
        continue;
      }
    }
    schemaLines.push(
      `const ${constName.get(simpleType.name)} = ${registered(expr, simpleType.description, `qname: ${JSON.stringify(simpleType.name)}`)};`,
    );
  }

  // Eager object consts for polymorphic-family types: discriminatedUnion
  // options must be object schemas, so the family members' shapes exist as
  // standalone consts (their fields lazy-wrap complex/union references).
  for (const complexType of Object.values(ir.complexTypes)) {
    if (!familyTypes.has(complexType.name)) {
      continue;
    }
    const objectCtor =
      complexType.wildcards && complexType.wildcards.length > 0 ? "z.looseObject" : "z.object";
    schemaLines.push(
      `const ${objectConstName.get(complexType.name)} = ${objectCtor}({${objectPropsExpr(complexType, true)}});`,
    );
  }

  for (const complexType of Object.values(ir.complexTypes)) {
    const annotation = opts?.js ? "" : `: z.ZodType<${ifaceName.get(complexType.name)}>`;
    if (familyTypes.has(complexType.name)) {
      // Family member: the object shape lives in its own const (shared with
      // the xsiType variant below); the named const stays a lazy wrapper.
      schemaLines.push(
        `const ${constName.get(complexType.name)}${annotation} = ${registered(
          `z.lazy(() => ${objectConstName.get(complexType.name)})`,
          complexType.description,
          fieldsMetaFor(complexType, ir, structured, membersByHead),
        )};`,
      );
      continue;
    }
    const multiBranch = choiceOptionalGroups(complexType);
    const props = dedupeEmissionFields(complexType)
      .map(
        (field) =>
          `${JSON.stringify(toFieldKey(field))}: ${withDescription(
            withCardinality(
              fieldTypeExpr(field, false),
              field,
              ir,
              field.choiceGroup !== undefined && multiBranch.has(field.choiceGroup),
              structured,
              usedHelpers,
            ),
            field.description,
          )}`,
      )
      .join(", ");

    schemaLines.push(
      `const ${constName.get(complexType.name)}${annotation} = ${registered(
        `z.lazy(() => ${complexType.wildcards && complexType.wildcards.length > 0 ? "z.looseObject" : "z.object"}({${props}}))`,
        complexType.description,
        fieldsMetaFor(complexType, ir, structured, membersByHead),
      )};`,
    );
  }

  // xsiType variant schemas (object shape + discriminant property, registered
  // with the type meta so the runtime can read occurrences through them) and
  // the discriminated union per polymorphic declared type. unionFallback lets
  // a discriminant-less value at a mid-chain slot (whose declared type's
  // variant carries a default, so undefined is not among its discriminator
  // values) still validate as the declared type.
  for (const complexType of Object.values(ir.complexTypes)) {
    if (!familyTypes.has(complexType.name)) {
      continue;
    }
    const discriminant = JSON.stringify(complexType.name);
    const xsiTypeProp = derivedTypeNames.has(complexType.name)
      ? `z.literal(${discriminant}).default(${discriminant})`
      : `z.literal(${discriminant}).optional()`;
    schemaLines.push(
      `const ${variantConstName.get(complexType.name)} = ${objectConstName.get(complexType.name)}.extend({ "xsiType": ${xsiTypeProp} }).register(xmlRegistry, { ${fieldsMetaFor(complexType, ir, structured, membersByHead)} });`,
    );
  }
  for (const [typeName, variants] of variantSets) {
    const options = variants.map((variant) => variantConstName.get(variant)).join(", ");
    schemaLines.push(
      `const ${unionConstName.get(typeName)} = z.discriminatedUnion("xsiType", [${options}], { unionFallback: true });`,
    );
  }

  for (const root of ir.rootElements) {
    const rootDef = ir.elements[root];
    if (!rootDef) {
      continue;
    }
    // Root exports are fresh wrapper objects: registry meta is keyed by schema
    // object identity, so registering { root } on the shared type schema would
    // clobber its type meta (and collide when two roots share one type). A
    // root whose type is polymorphic wraps the xsi:type variant union.
    const rootTypeExpr =
      variantSets.get(rootDef.typeName) === undefined
        ? primitiveToZod(rootDef.typeName, definedTypes, constName, usedHelpers, structured)
        : (unionConstName.get(rootDef.typeName) ?? "z.unknown()");
    const base = `z.lazy(() => ${rootTypeExpr})`;
    const expr = rootDef.nillable ? `${base}.nullable()` : base;
    const rootMeta = [`root: ${JSON.stringify(root)}`];
    if (rootDef.typeName === "{http://www.w3.org/2001/XMLSchema}anyType") {
      rootMeta.push("open: true");
    }
    const rootSt = structured ? structuredTypeOfTypeName(rootDef.typeName, ir) : undefined;
    if (rootSt) {
      rootMeta.push(`datatype: ${JSON.stringify(rootSt.name)}`);
    }
    if (isQNameTyped(rootDef.typeName, ir)) {
      rootMeta.push("qnameValue: true");
    }
    if (rootDef.defaultValue !== undefined) {
      rootMeta.push(
        ...defaultValueMetaParts(rootDef.typeName, rootDef.defaultValue, ir, structured),
      );
    }
    if (rootDef.fixedValue !== undefined) {
      rootMeta.push(
        ...fixedValueMetaParts(rootDef.typeName, rootDef.fixedValue, ir, structured, true),
      );
    }
    // JSDoc on the export so IDE hover shows the docs: the element's own
    // annotation wins, otherwise fall back to the annotated type.
    const description =
      rootDef.description ??
      ir.complexTypes[rootDef.typeName]?.description ??
      ir.simpleTypes[rootDef.typeName]?.description;
    const jsDoc = description ? `${formatJsDoc(description, 0)}\n` : "";
    schemaLines.push(
      `${jsDoc}export const ${exportNames.get(root)} = ${registered(expr, rootDef.description, rootMeta.join(", "))};`,
    );
  }

  const xsdImports = [
    usage.totalDigits ? "xsdTotalDigits" : undefined,
    usage.fractionDigits ? "xsdFractionDigits" : undefined,
    ...[...usedHelpers].sort(),
  ].filter((name): name is string => name !== undefined);
  const typeImport =
    usedTypes.size > 0
      ? `\nimport type { ${[...usedTypes].sort().join(", ")} } from 'xsd-to-zod';`
      : "";
  schemaLines[importLineIndex] =
    `import { z } from 'zod';\n` +
    `import { xmlRegistry${xsdImports.length > 0 ? `, ${xsdImports.join(", ")}` : ""} } from 'xsd-to-zod';${typeImport}`;

  return { schemas: `${schemaLines.join("\n")}\n` };
};

export const fieldKeyFromIr = toFieldKey;

// JS reserved words — an export/identifier matching one of these must be
// prefixed so the generated module is valid JavaScript (#70, #84).
const JS_RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "async",
  "await",
  "of",
  "from",
  "as",
  "get",
  "set",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
]);

// Generated export identifiers must be valid JS identifiers and unique across
// all roots — legal XSD names (unicode letters, or the same local name in two
// namespaces) otherwise produce invalid TypeScript (#70).
export const sanitizeIdentifier = (name: string): string => {
  const cleaned = name.replace(/[^\p{L}\p{N}_$]/gu, "_");
  const valid = /^[\p{L}_$]/u.test(cleaned) ? cleaned : `_${cleaned}`;
  return JS_RESERVED.has(valid) ? `_${valid}` : valid;
};

export const rootSchemaExportNames = (rootElements: QName[]): Map<string, string> => {
  const seen = new Map<string, number>();
  const names = new Map<string, string>();
  for (const root of rootElements) {
    const base = `${sanitizeIdentifier(clarkToLocal(root))}Schema`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    names.set(root, count === 0 ? base : `${base}${count + 1}`);
  }
  return names;
};
