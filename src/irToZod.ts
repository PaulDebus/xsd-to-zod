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
import type { XmlLexicalFacets } from "./xmlMeta.js";
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

// Primitive builtins that map to a constant zod expression; anything absent
// falls back to z.string().
const XSD_PRIMITIVE_EMITTERS: ReadonlyMap<string, string> = new Map([
  // Open content: the runtime walks/serializes it generically (open shape);
  // zod stays permissive for this lax tier.
  ["anyType", "z.unknown()"],
  ["string", "z.string()"],
  ["token", "z.string()"],
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
  const seenNames = seen ?? new Set<string>();
  if (seenNames.has(typeName)) {
    return "string";
  }
  seenNames.add(typeName);
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
  return base ? resolvePrimitiveKind(base, ir, seenNames) : "string";
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
  const seenNames = seen ?? new Set<string>();
  if (seenNames.has(typeName)) {
    return undefined;
  }
  seenNames.add(typeName);
  const simple = ir.simpleTypes[typeName];
  if (simple?.kind !== "restriction") {
    return undefined;
  }
  return resolveBuiltinLocal(simple.baseType, ir, seenNames);
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
    const base = `z.string().refine(${validator}, { message: 'invalid xs:${parts.local} lexical' })`;
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

const toFieldKey = (field: IrField): string => {
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

// The structure a (possibly chained) restriction ultimately derives from.
// Enumeration facets on list and union bases cannot be checked by the
// generated schema (the value is an array / a union member), so they route to
// the runtime's lexical-facet meta.
const resolveBaseStructure = (
  typeName: QName,
  ir: XsdIr,
  seen?: Set<string>,
): "list" | "union" | undefined => {
  const seenNames = seen ?? new Set<string>();
  if (seenNames.has(typeName)) {
    return undefined;
  }
  seenNames.add(typeName);
  const simple = ir.simpleTypes[typeName];
  if (simple === undefined) {
    return undefined;
  }
  return simple.kind === "restriction"
    ? resolveBaseStructure(simple.baseType, ir, seenNames)
    : simple.kind;
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
  const enumLiterals = enumFacets.map((f) => typedLiteral(kind, f.value));

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
      result = `z.enum([${enumLiterals.join(", ")}])`;
    } else if (isNumberType(base) || isBigIntType(base) || base === "z.boolean()") {
      result = `z.union([${enumLiterals.map((lit) => `z.literal(${lit})`).join(", ")}])`;
    } else {
      // Base is a reference to another type's schema — keep it and constrain.
      result += `.refine((val) => [${enumLiterals.join(", ")}].includes(val), { message: 'value is not one of the allowed values' })`;
    }
  } else {
    for (const facet of otherFacets) {
      switch (facet.kind) {
        case "pattern":
          // Structured date/time values have no string form of their own; the
          // pattern applies to the canonical lexical.
          if (st !== undefined) {
            usedHelpers.add(st.writeFn);
            result += `.refine((val) => new RegExp(${JSON.stringify(facet.value)}).test(${st.writeFn}(val)), { message: 'value does not match the pattern' })`;
          } else if (isStringType(result)) {
            // The string value IS the (whiteSpace-processed) lexical, so the
            // schema can check it — with XSD regex semantics (anchored,
            // unicode-aware multi-character escapes).
            usedHelpers.add("xsdPattern");
            result += `.regex(xsdPattern(${JSON.stringify(facet.value)}))`;
          } else {
            // Non-string/list/union base: the pattern must be evaluated
            // against the original lexical, which the schema cannot see.
            ownPatterns.push(facet.value);
          }
          break;
        case "length":
        case "minLength":
        case "maxLength": {
          const op = facet.kind === "length" ? "===" : facet.kind === "minLength" ? ">=" : "<=";
          // XSD 1.0 vacuous rule: every QName/NOTATION value satisfies any
          // length facet — skip them (with a diagnostic) rather than reject
          // valid values (#124 review).
          if (builtinLocal === "NOTATION" || builtinLocal === "QName") {
            result += ` /* facet ${facet.kind} skipped: vacuous for xs:${builtinLocal} in XSD 1.0 */`;
          } else if (builtinLocal === "hexBinary") {
            // Length unit is octets: two hex digits per octet.
            result += `.refine((val) => typeof val === 'string' && val.length % 2 === 0 && val.length / 2 ${op} ${facet.value}, { message: 'octet length constraint violated' })`;
          } else if (builtinLocal === "base64Binary") {
            // Length unit is octets: four base64 chars per three octets, less padding.
            result += `.refine((val) => typeof val === 'string' && ((s) => Math.floor(s.length / 4) * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0))(val.replace(/\\s+/g, '')) ${op} ${facet.value}, { message: 'octet length constraint violated' })`;
          } else if (
            builtinLocal === "IDREFS" ||
            builtinLocal === "NMTOKENS" ||
            builtinLocal === "ENTITIES"
          ) {
            // Length unit is list items (whitespace-separated tokens).
            result += `.refine((val) => typeof val === 'string' && (val.trim() === '' ? 0 : val.trim().split(/\\s+/).length) ${op} ${facet.value}, { message: 'item count constraint violated' })`;
          } else if (st !== undefined) {
            // Structured date/time: the length facet applies to the lexical
            // space, so measure the canonical lexical of the parsed value.
            usedHelpers.add(st.writeFn);
            result += `.refine((val) => ${st.writeFn}(val).length ${op} ${facet.value}, { message: 'length constraint violated' })`;
          } else if (isStringType(result)) {
            result +=
              facet.kind === "length"
                ? `.length(${facet.value})`
                : facet.kind === "minLength"
                  ? `.min(${facet.value})`
                  : `.max(${facet.value})`;
          } else {
            // Non-string base (type reference, enum, list): the convenience
            // methods don't exist there — refine on the .length of strings
            // (characters) and arrays (list items) instead (#114).
            result += `.refine((val) => (typeof val === 'string' || Array.isArray(val)) && val.length ${op} ${facet.value}, { message: 'length constraint violated' })`;
          }
          break;
        }
        case "minInclusive":
        case "maxInclusive":
        case "minExclusive":
        case "maxExclusive": {
          if (isNumberType(result)) {
            const bound = String(Number(facet.value));
            result +=
              facet.kind === "minInclusive"
                ? `.min(${bound})`
                : facet.kind === "maxInclusive"
                  ? `.max(${bound})`
                  : facet.kind === "minExclusive"
                    ? `.gt(${bound})`
                    : `.lt(${bound})`;
          } else if (isBigIntType(result)) {
            const bound = typedLiteral("bigint", facet.value);
            result +=
              facet.kind === "minInclusive"
                ? `.min(${bound})`
                : facet.kind === "maxInclusive"
                  ? `.max(${bound})`
                  : facet.kind === "minExclusive"
                    ? `.gt(${bound})`
                    : `.lt(${bound})`;
          } else if (kind === "number" || kind === "bigint") {
            // Numeric user-type reference: compare via refine, which any
            // schema supports (#114).
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
            result += `.refine((val) => val ${op} ${bound}, { message: 'value out of range' })`;
          } else {
            // Order facets on non-numeric kinds (dates, durations) are
            // skipped: the coerced/string value cannot be compared soundly —
            // the libxml2 tier stays the conformance authority (#114).
            result += ` /* facet ${facet.kind} skipped: order facets unsupported on non-numeric types */`;
          }
          break;
        }
        case "totalDigits":
          if (kind === "bigint") {
            // BigInt's string form is canonical (no leading zeros), so the
            // digit count of the absolute value is exact at any precision.
            result += `.refine((val) => String(val < 0n ? -val : val).length <= ${facet.value}, { message: ${JSON.stringify(`expected at most ${facet.value} total digits`)} })`;
          } else {
            usage.totalDigits = true;
            result += `.refine(xsdTotalDigits(${facet.value}), { message: ${JSON.stringify(`expected at most ${facet.value} total digits`)} })`;
          }
          break;
        case "fractionDigits":
          if (kind === "bigint") {
            // Vacuous for integers: the fraction digit count is always 0.
            result += ` /* facet fractionDigits skipped: vacuous for integer types */`;
          } else {
            usage.fractionDigits = true;
            result += `.refine(xsdFractionDigits(${facet.value}), { message: ${JSON.stringify(`expected at most ${facet.value} fraction digits`)} })`;
          }
          break;
      }
    }

    if (enumFacets.length > 0 && !enumViaMeta) {
      result +=
        enumConstraint ??
        `.refine((val) => [${enumLiterals.join(", ")}].includes(val), { message: 'value is not one of the allowed values' })`;
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
  let result = schema;
  if (field.fixedValue !== undefined) {
    // Structured date/time fixed: z.literal compares objects by reference, so
    // constrain by canonical lexical equality instead. The value itself is in
    // the field meta (the runtime substitutes present-but-empty content).
    const st = structured ? structuredType(resolveBuiltinLocal(field.typeName, ir)) : undefined;
    if (st) {
      usedHelpers.add(st.writeFn);
      const canonical = writeXsdDatatype(st.name, parseXsdDatatype(st.name, field.fixedValue));
      result += `.refine((val) => ${st.writeFn}(val) === ${JSON.stringify(canonical)}, { message: 'value does not match the fixed value' })`;
    } else {
      result = `z.literal(${typedLiteral(kind, field.fixedValue)})`;
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
    const st = structured ? structuredType(resolveBuiltinLocal(field.typeName, ir)) : undefined;
    result += `.default(${st ? structuredLiteral(st.name, field.defaultValue) : typedLiteral(kind, field.defaultValue)})`;
  }
  return result;
};

// Choice groups with more than one branch: mutual exclusion is not expressible
// as a plain zod type (and discriminated unions only scale to one group per
// type), so branch fields become optional plus a refine per group (#73).
// Branches come from the IR's choiceBranch: a group ref or nested compositor
// keeps its fields together as one branch (ipo-style shipTo+billTo vs
// singleAddress). Single-branch groups need no check — exactly-one-of-one is
// the field cardinality itself.
//
// A branch may carry no fields of its own and consist only of a nested choice
// (the inner fields bear the inner group's tag, so the branch is invisible in
// the field list). The IR's choiceGroupGuards link such inner groups to their
// enclosing branch: the branch map below materializes those branches, and the
// inner group's own refine is gated on the branch actually being selected.
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

const choiceRefines = (type: ComplexTypeDef): string[] => {
  const keyOf = (field: IrField): string => `val[${JSON.stringify(toFieldKey(field))}]`;
  // A choice with a wildcard branch is always satisfiable through it: wildcard
  // content lands in the open shape, invisible to field presence checks.
  const wildcardGroups = new Set(
    (type.wildcards ?? []).flatMap((w) => (w.choiceGroup ? [w.choiceGroup] : [])),
  );

  // Emits one group's branch consts into `lines` and returns the group's check
  // plus a presence expression (any field of the whole subtree present) that
  // enclosing branches use for gating.
  const emitGroup = (lines: string[], group: string): { check: string; any: string } => {
    if (wildcardGroups.has(group)) {
      const keys = choiceSubtreeFields(type, group).map(keyOf);
      return { check: "true", any: keys.length > 0 ? `[${keys.join(", ")}].some(has)` : "false" };
    }
    const branches = [...choiceBranchMap(type, group).entries()];
    const flatFields = branches.flatMap(([, fields]) => fields);
    // A choice group is only required when it is not emptiable: a single
    // branch with minOccurs="0" makes the whole group match empty (verified
    // against libxml2). Field minOccurs already folds in the choice particle's
    // own minOccurs (combineCardinality multiplies); a group of only nested
    // choices has no own fields and falls back to its particle cardinality.
    const groupCard = type.choiceGroups?.[group];
    const requiredChoice =
      flatFields.length > 0
        ? flatFields.every((f) => f.minOccurs > 0)
        : groupCard === undefined || groupCard.minOccurs > 0;
    const repeatedChoice =
      groupCard !== undefined && (groupCard.maxOccurs === "unbounded" || groupCard.maxOccurs > 1);
    if (repeatedChoice && !requiredChoice) {
      return { check: "true", any: "false" };
    }

    const completeNames: string[] = [];
    const partialNames: string[] = [];
    const selExprs: string[] = [];
    const keySets: Set<string>[] = [];
    branches.forEach(([branchKey, fields], i) => {
      const id = `${group}g${i}`;
      const allKeys = fields.map(keyOf);
      const requiredKeys = fields.filter((f) => f.minOccurs > 0).map(keyOf);
      keySets.push(new Set(fields.map((f) => toFieldKey(f))));
      const children = choiceChildren(type, group, branchKey).map((child) =>
        emitGroup(lines, child),
      );
      const selParts = [
        ...(allKeys.length > 0 ? [`[${allKeys.join(", ")}].some(has)`] : []),
        ...children.map((child) => child.any).filter((expr) => expr !== "false"),
      ];
      const sel = selParts.length > 0 ? selParts.join(" || ") : "false";
      selExprs.push(sel);
      // A branch is complete when all its required fields are present (or, for
      // branches of only-optional fields, when any field is present) and every
      // nested choice hanging off it is satisfied. A branch without fields of
      // its own must additionally show up at all: an optional nested choice
      // that is absent must not count its branch as complete.
      const directOk =
        requiredKeys.length === 1 && fields.length === 1
          ? `has(${allKeys[0]})`
          : requiredKeys.length > 0
            ? `[${requiredKeys.join(", ")}].every(has)`
            : allKeys.length > 0
              ? `[${allKeys.join(", ")}].some(has)`
              : "true";
      const okParts = [
        ...(fields.length === 0 ? [`(${sel})`] : []),
        directOk,
        ...children.map((child) => child.check),
      ].filter((expr) => expr !== "true");
      lines.push(`const b${id} = ${okParts.length > 0 ? okParts.join(" && ") : "true"};`);
      completeNames.push(`b${id}`);
      // Partial presence — the branch shows up but is not complete — is always
      // rejected.
      if (
        (requiredKeys.length > 0 && fields.length > 1) ||
        children.some((child) => child.check !== "true")
      ) {
        lines.push(`const p${id} = !b${id} && (${sel});`);
        partialNames.push(`p${id}`);
      }
    });

    // Overlapping branches: when a complete branch's key set covers a smaller
    // complete branch's, the smaller match is fully explained by the larger
    // one and is not counted separately.
    const countedNames = completeNames.map((name, j) => {
      const keysJ = keySets[j] ?? new Set<string>();
      const absorbers = completeNames.filter((_, i) => {
        const keysI = keySets[i] ?? new Set<string>();
        return (
          i !== j &&
          keysJ.size > 0 &&
          keysJ.size <= keysI.size &&
          (keysJ.size < keysI.size || i < j) &&
          [...keysJ].every((key) => keysI.has(key))
        );
      });
      if (absorbers.length === 0) {
        return name;
      }
      const counted = `c${group}g${j}`;
      lines.push(`const ${counted} = ${name} && !(${absorbers.join(" || ")});`);
      return counted;
    });

    const countCheck = repeatedChoice ? "> 0" : requiredChoice ? "=== 1" : "<= 1";
    const partialCheck =
      partialNames.length > 0 ? ` && ![${partialNames.join(", ")}].some(Boolean)` : "";
    return {
      check: `[${countedNames.join(", ")}].filter(Boolean).length ${countCheck}${partialCheck}`,
      any:
        selExprs.filter((expr) => expr !== "false").length > 0
          ? selExprs.filter((expr) => expr !== "false").join(" || ")
          : "false",
    };
  };

  const refines: string[] = [];
  for (const group of multiBranchGroups(type)) {
    if (wildcardGroups.has(group)) {
      continue;
    }
    const branches = [...choiceBranchMap(type, group).values()];
    const flatFields = branches.flat();
    const groupCard = type.choiceGroups?.[group];
    const repeatedChoice =
      groupCard !== undefined && (groupCard.maxOccurs === "unbounded" || groupCard.maxOccurs > 1);
    const requiredChoice =
      flatFields.length > 0
        ? flatFields.every((f) => f.minOccurs > 0)
        : groupCard === undefined || groupCard.minOccurs > 0;
    if (repeatedChoice && !requiredChoice) {
      continue;
    }

    // Presence, not just definedness: the runtime materializes an absent
    // repeated field as [] (readField), and [] !== undefined would count the
    // branch as selected — an empty array is zero occurrences, i.e. absent.
    const lines: string[] = [
      `const has = (v: unknown): boolean => v !== undefined && !(Array.isArray(v) && v.length === 0);`,
    ];
    const { check } = emitGroup(lines, group);
    const guard = type.choiceGroupGuards?.[group];
    if (guard) {
      // A nested choice is enforced only when its enclosing branch is
      // actually selected.
      const gateKeys = choiceBranchSubtreeFields(type, guard.group, guard.branch).map(keyOf);
      const gate = gateKeys.length > 0 ? `[${gateKeys.join(", ")}].some(has)` : "false";
      lines.push(`return (${gate}) ? (${check}) : true;`);
    } else {
      lines.push(`return ${check};`);
    }

    const names = [...choiceBranchMap(type, group).entries()]
      .map(([branchKey, fields]) => {
        const display =
          fields.length > 0 ? fields : choiceBranchSubtreeFields(type, group, branchKey);
        return display.map((f) => clarkToLocal(f.qname)).join("+");
      })
      .join(", ");
    const message = repeatedChoice
      ? `choice requires at least one of: ${names}`
      : `${requiredChoice ? "choice requires exactly one of" : "choice allows at most one of"}: ${names}`;
    refines.push(
      `.refine((val) => {\n${lines.join("\n")}\n}, { message: ${JSON.stringify(message)} })`,
    );
  }
  return refines;
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

// Per-field XML knowledge lives on the containing object schema: a named type
// can be referenced by several elements with different qnames, so field-level
// meta on shared schemas would conflict.
const fieldsMetaFor = (
  type: ComplexTypeDef,
  ir: XsdIr,
  structured: boolean,
  membersByHead: ReadonlyMap<QName, ElementDef[]>,
): string => {
  const entries = type.fields.map((field) => {
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
    // The runtime substitutes meta defaults before validation, so even in
    // structured mode the meta holds the lexical — the schema's transform
    // turns it into the structured value. Attribute defaults only need the
    // meta in structured mode: string mode reads them from the zod def.
    if (
      field.defaultValue !== undefined &&
      field.fixedValue === undefined &&
      (field.kind === "element" || (structured && st && field.kind === "attribute"))
    ) {
      parts.push(
        `defaultValue: ${typedLiteral(resolvePrimitiveKind(field.typeName, ir), field.defaultValue)}`,
      );
    }
    if (structured && st && field.fixedValue !== undefined) {
      // Structured fixed values cannot ride a z.literal (reference equality on
      // objects): the constraint is a canonical-lexical refine and the runtime
      // substitutes the lexical from here (validation transforms it).
      parts.push(`fixedValue: ${JSON.stringify(field.fixedValue)}`);
    }
    if (!structured && field.fixedValue !== undefined) {
      // The serializer re-emits the declared fixed lexical (see XmlFieldMeta).
      parts.push(`fixedLexical: ${JSON.stringify(field.fixedValue)}`);
    }
    return `${JSON.stringify(toFieldKey(field))}: { ${parts.join(", ")} }`;
  });
  // Wildcard sentinels: '*' sweeps unmatched child elements, '@*' unmatched
  // attributes into the open shape.
  for (const wildcard of type.wildcards ?? []) {
    if (wildcard.kind === "any") {
      entries.push(`"*": { kind: "any", qname: "{}*" }`);
    } else {
      entries.push(`"@*": { kind: "anyAttribute", qname: "{}*" }`);
    }
  }
  return `qname: ${JSON.stringify(type.name)}, fields: { ${entries.join(", ")} }`;
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
): string => {
  let type: string;
  if (field.fixedValue === undefined) {
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
  } else {
    // Structured fixed values have no literal type; the base type it is.
    const st = dt ? structuredType(resolveBuiltinLocal(field.typeName, ir)) : undefined;
    if (st) {
      dt?.usedTypes.add(st.tsType);
      type = st.tsType;
    } else {
      type = typedLiteral(resolvePrimitiveKind(field.typeName, ir), field.fixedValue);
    }
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

  // Field value schema: the field's type, or — when the field references a
  // substitution-group head — a union of per-element options (head + all
  // members). Each option is a lazy wrapper registered with its element
  // qname (XmlMeta.substElement): the runtime matches the actual element tag
  // against these to read and serialize with the right type. Members come
  // first: they are the more specific types, so a validating member branch
  // is picked before the head's looser shape could strip member-only content.
  const fieldTypeExpr = (field: IrField): string => {
    const headExpr = primitiveToZod(
      field.typeName,
      definedTypes,
      constName,
      usedHelpers,
      structured,
    );
    const substMembers = membersByHead.get(field.qname);
    if (substMembers === undefined || substMembers.length === 0) {
      return headExpr;
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

  // Interfaces first: exported so consumers can name the inferred types, and
  // the const annotations below refer to them. js mode has no type level.
  if (!opts?.js) {
    for (const complexType of Object.values(ir.complexTypes)) {
      claimTypeName(complexType.name);
      const multiBranch = choiceOptionalGroups(complexType);
      const props = complexType.fields
        .map((field) =>
          tsFieldLine(
            field,
            ir,
            ifaceName,
            field.choiceGroup !== undefined && multiBranch.has(field.choiceGroup),
            dt,
            membersByHead,
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

  for (const complexType of Object.values(ir.complexTypes)) {
    const multiBranch = choiceOptionalGroups(complexType);
    const props = complexType.fields
      .map(
        (field) =>
          `${JSON.stringify(toFieldKey(field))}: ${withDescription(
            withCardinality(
              fieldTypeExpr(field),
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

    const annotation = opts?.js ? "" : `: z.ZodType<${ifaceName.get(complexType.name)}>`;
    schemaLines.push(
      `const ${constName.get(complexType.name)}${annotation} = ${registered(
        `z.lazy(() => ${complexType.wildcards && complexType.wildcards.length > 0 ? "z.looseObject" : "z.object"}({${props}})${choiceRefines(complexType).join("")})`,
        complexType.description,
        fieldsMetaFor(complexType, ir, structured, membersByHead),
      )};`,
    );
  }

  for (const root of ir.rootElements) {
    const rootDef = ir.elements[root];
    if (!rootDef) {
      continue;
    }
    // Root exports are fresh wrapper objects: registry meta is keyed by schema
    // object identity, so registering { root } on the shared type schema would
    // clobber its type meta (and collide when two roots share one type).
    const base = `z.lazy(() => ${primitiveToZod(rootDef.typeName, definedTypes, constName, usedHelpers, structured)})`;
    const expr = rootDef.nillable ? `${base}.nullable()` : base;
    const rootMeta = [`root: ${JSON.stringify(root)}`];
    if (rootDef.typeName === "{http://www.w3.org/2001/XMLSchema}anyType") {
      rootMeta.push("open: true");
    }
    const rootSt = structured ? structuredTypeOfTypeName(rootDef.typeName, ir) : undefined;
    if (rootSt) {
      rootMeta.push(`datatype: ${JSON.stringify(rootSt.name)}`);
    }
    if (rootDef.defaultValue !== undefined) {
      rootMeta.push(
        `defaultValue: ${typedLiteral(resolvePrimitiveKind(rootDef.typeName, ir), rootDef.defaultValue)}`,
      );
    }
    if (rootDef.fixedValue !== undefined) {
      rootMeta.push(
        `fixedValue: ${typedLiteral(resolvePrimitiveKind(rootDef.typeName, ir), rootDef.fixedValue)}`,
      );
      rootMeta.push(`fixedLexical: ${JSON.stringify(rootDef.fixedValue)}`);
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
