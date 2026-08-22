import {
  type BaseOutputBuilder,
  BaseOutputBuilderFactory,
  BaseValueParser,
} from "@nodable/base-output-builder";
import { CompactBuilderFactory, type FactoryOptions } from "@nodable/compact-builder";
import XMLParser from "@nodable/flexible-xml-parser";
import { z } from "zod";
import { choiceGroupIssues } from "./choiceCheck.js";
import {
  type ClaimedOccurrence,
  type DocumentOrderEntry,
  documentOrderTracker,
  type ElementRead,
  OrderTrackingCompactBuilder,
} from "./documentOrder.js";
import { splitClark, splitQName, trySplitClark } from "./qname.js";
import type { QName } from "./types.js";
import { type XmlFieldMeta, type XmlLexicalFacets, type XmlMeta, xmlRegistry } from "./xmlMeta.js";
import { xsdDecimalCompare } from "./xsdChecks.js";
import {
  parseXsdDatatype,
  writeXsdDatatype,
  type XsdDatatypeName,
  type XsdStructuredValue,
} from "./xsdDateTime.js";
import { collapseWhiteSpace } from "./xsdLexicals.js";
import { xsdPattern } from "./xsdPattern.js";

const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";
// Synthetic discriminant field of polymorphic (xsi:type) slots. Codegen emits
// it into variant object shapes; the runtime injects it on parse and strips
// it (re-emitted as the xsi:type attribute) on serialize.
const XSI_TYPE_FIELD = "xsiType";
// Bound to the xml prefix by definition (Namespaces in XML §3); documents use
// it without ever declaring it.
const XML_NS = "http://www.w3.org/XML/1998/namespace";

type GetInstanceArgs = Parameters<BaseOutputBuilderFactory["getInstance"]>;
type RegisterArgs = Parameters<BaseOutputBuilderFactory["registerValueParser"]>;

// XML 1.0 §3.3.3: literal TAB/LF/CR in attribute values normalize to spaces
// before the app sees them; character references (&#9; etc.) keep the control
// character after entity expansion. The parser's AttributeProcessor already
// handles LF/CR; this pre-entity step covers literal TAB and preserves the
// &#9; vs literal distinction by running before "entity".
class AttributeWhitespaceNormalizer extends BaseValueParser {
  override parse(val: unknown): unknown {
    return typeof val === "string" ? val.replace(/[\t\n\r]/g, " ") : val;
  }
}

const attributeWhitespaceNormalizer = new AttributeWhitespaceNormalizer();

// Works around a declaration bug in @nodable/compact-builder@2.0.0 (#86):
// CompactBuilder.addElement is declared as addElement(tag, matcher) while the
// implementation — like BaseOutputBuilder.addElement — is addElement(tag),
// which makes CompactBuilderFactory structurally incompatible with
// BaseOutputBuilderFactory. The single upcast in getInstance follows the
// declared extends chain and is runtime-safe. Remove this wrapper once
// upstream ships fixed declarations.
class EntityCompactBuilderFactory extends BaseOutputBuilderFactory {
  // Entity decoding is left to the parser; number/boolean coercion is disabled
  // so that every value arrives as a raw lexical and coerceLexical stays the
  // single coercion point for elements and attributes (#65).
  private readonly inner = new CompactBuilderFactory({
    tags: { valueParsers: ["entity"] },
    attributes: { valueParsers: [attributeWhitespaceNormalizer, "entity"] },
  });

  override getInstance(...args: GetInstanceArgs): BaseOutputBuilder {
    return new OrderTrackingCompactBuilder(
      args[0],
      this.inner.builderOptions as FactoryOptions,
      args[1],
      this.inner.registry,
    ) as unknown as BaseOutputBuilder;
  }

  override registerValueParser(...args: RegisterArgs): void {
    this.inner.registerValueParser(...args);
  }
}

export const createOutputBuilder = (): BaseOutputBuilderFactory =>
  new EntityCompactBuilderFactory();

const parser = new XMLParser({
  skip: { attributes: false },
  attributes: { prefix: "@_" },
  // Keep CDATA under its own key: merged text passes through the entity value
  // parser, which would corrupt literal entity text inside CDATA sections (#64).
  nameFor: { cdata: "#cdata" },
  OutputBuilder: createOutputBuilder(),
});

const toArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

// Text content of a parsed node: character data plus verbatim CDATA sections.
// The builder concatenates an element's text segments, so their interleaving
// with child elements (mixed content) is not preserved; the common cases
// (text-only, CDATA-only) are exact.
const textOf = (node: Record<string, unknown>): unknown => {
  const text = node["#text"];
  const cdata = node["#cdata"];
  if (cdata === undefined) {
    return text;
  }
  const cdataText = Array.isArray(cdata) ? cdata.join("") : String(cdata);
  return `${text === undefined ? "" : String(text)}${cdataText}`;
};

const hasElementChildren = (node: Record<string, unknown>): boolean =>
  Object.keys(node).some((key) => !key.startsWith("@_") && key !== "#text" && key !== "#cdata");

const collectNamespaceDeclarations = (node: Record<string, unknown>): Record<string, string> => {
  const namespaces: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "@_xmlns") {
      namespaces[""] = String(value);
      continue;
    }
    if (!key.startsWith("@_xmlns:")) {
      continue;
    }
    namespaces[key.slice("@_xmlns:".length)] = String(value);
  }
  return namespaces;
};

const withNamespaceContext = (
  baseContext: Record<string, string>,
  node: Record<string, unknown>,
): Record<string, string> => ({
  xml: XML_NS,
  ...baseContext,
  ...collectNamespaceDeclarations(node),
});

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    // A literal CR never survives a parse round-trip (line-ending
    // normalization maps it to LF) — it must be a character reference.
    .replaceAll("\r", "&#xD;");

// Attribute-value normalization additionally maps literal TAB and LF to
// spaces, so attribute text needs those as character references too. Applied
// post-escape: escapeXml never introduces raw TAB/LF.
const escapeXmlAttrChars = (escaped: string): string =>
  escaped.replaceAll("\t", "&#x9;").replaceAll("\n", "&#xA;");

export const decodeXmlEntities = (xml: string): string =>
  xml
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));

const CDATA_SECTION = /<!\[CDATA\[[\s\S]*?\]\]>/g;
const TAG_NAME = /<\/?[^\s>/]+/g;
const NUMERIC_CHAR_REF = /&#(\d+);|&#x([0-9a-fA-F]+);/g;

// Some producers emit numeric character references inside tag names (not
// well-formed XML — libxml2 rejects it too), e.g. `<men&#249;>` for `<menù>`.
// Decode them scoped to tag names only; character data and CDATA stay untouched.
export const decodeTagNameCharRefs = (xml: string): string => {
  const cdataBlocks = xml.match(CDATA_SECTION) ?? [];
  return xml
    .split(CDATA_SECTION)
    .map((segment, i) => {
      const decoded = segment.replace(TAG_NAME, (tag) =>
        tag.replace(NUMERIC_CHAR_REF, (_, dec: string | undefined, hex: string | undefined) =>
          String.fromCodePoint(dec === undefined ? parseInt(hex ?? "0", 16) : Number(dec)),
        ),
      );
      return decoded + (cdataBlocks[i] ?? "");
    })
    .join("");
};

// ---------------------------------------------------------------------------
// zod def walking
// ---------------------------------------------------------------------------

type AnyDef = z.core.$ZodTypeDef;
type AnySchema = z.core.$ZodType;

const defAs = <T extends AnyDef>(def: AnyDef, type: T["type"]): T | undefined =>
  def.type === type ? (def as T) : undefined;

// Peel exactly one wrapper level (lazy/optional/nullable/default/readonly);
// returns the input unchanged when it is not a wrapper.
const peelOnce = (schema: AnySchema): AnySchema => {
  const def = schema._zod.def;
  const lazy = defAs<z.core.$ZodLazyDef>(def, "lazy");
  if (lazy) {
    return lazy.getter();
  }
  const wrapper =
    defAs<z.core.$ZodOptionalDef>(def, "optional") ??
    defAs<z.core.$ZodNullableDef>(def, "nullable") ??
    defAs<z.core.$ZodDefaultDef>(def, "default") ??
    defAs<z.core.$ZodReadonlyDef>(def, "readonly");
  return wrapper ? wrapper.innerType : schema;
};

// Peel all modifier wrappers down to the structural schema (leaf, object,
// array, pipe, …). Registry meta lives on specific layers (typically the lazy
// type schema), so callers that need meta look it up *before* unwrapping.
const unwrapModifiers = (schema: AnySchema): AnySchema => {
  let current = schema;
  for (;;) {
    const next = peelOnce(current);
    if (next === current) {
      return current;
    }
    current = next;
  }
};

const objectDefOf = (schema: AnySchema): z.core.$ZodObjectDef | undefined =>
  defAs<z.core.$ZodObjectDef>(unwrapModifiers(schema)._zod.def, "object");

const hasObjectShape = (schema: AnySchema): boolean => objectDefOf(schema) !== undefined;

const findMeta = (schema: AnySchema, pick: (meta: XmlMeta) => unknown): XmlMeta | undefined => {
  let current = schema;
  for (;;) {
    const meta = xmlRegistry.get(current);
    if (meta !== undefined && pick(meta)) {
      return meta;
    }
    const next = peelOnce(current);
    if (next === current) {
      return undefined;
    }
    current = next;
  }
};

const findRootMeta = (schema: AnySchema): XmlMeta | undefined => findMeta(schema, (m) => m.root);
const findObjectMeta = (schema: AnySchema): XmlMeta | undefined =>
  findMeta(schema, (m) => m.fields);
const findFieldsMeta = (schema: AnySchema): Record<string, XmlFieldMeta> | undefined =>
  findObjectMeta(schema)?.fields;
const findChoicesMeta = (schema: AnySchema): XmlMeta["choices"] | undefined =>
  findObjectMeta(schema)?.choices;

// Choice-validation context threaded through the parse walk: issues collected
// per object (choiceGroupIssues) with the object's property path, surfaced by
// safeParseXml as a ZodError. Undefined on the validate:false fast path.
type WalkCtx = {
  issues: z.core.$ZodIssue[];
  path: readonly (string | number)[];
};

const childWalk = (walk: WalkCtx | undefined, segment: string | number): WalkCtx | undefined =>
  walk === undefined ? undefined : { issues: walk.issues, path: [...walk.path, segment] };

type FieldAnalysis = {
  // Schema for one occurrence / the leaf. Lazy type schemas are kept intact:
  // their registry meta (the fields map) is keyed on the lazy object.
  itemSchema: AnySchema;
  isArray: boolean;
  hasDefault: boolean;
  defaultValue: unknown;
  hasFixed: boolean;
  fixedValue: unknown;
};

const analyzeField = (schema: AnySchema): FieldAnalysis => {
  let current = schema;
  let isArray = false;
  let hasDefault = false;
  let defaultValue: unknown;
  let hasFixed = false;
  let fixedValue: unknown;
  for (;;) {
    const def = current._zod.def;
    const as = <T extends AnyDef>(t: T["type"]): T | undefined => defAs<T>(def, t);
    const opt = as<z.core.$ZodOptionalDef>("optional");
    if (opt) {
      current = opt.innerType;
      continue;
    }
    const nul = as<z.core.$ZodNullableDef>("nullable");
    if (nul) {
      current = nul.innerType;
      continue;
    }
    const ro = as<z.core.$ZodReadonlyDef>("readonly");
    if (ro) {
      current = ro.innerType;
      continue;
    }
    const arr = as<z.core.$ZodArrayDef>("array");
    if (arr) {
      isArray = true;
      current = arr.element;
      continue;
    }
    const dflt = as<z.core.$ZodDefaultDef>("default");
    if (dflt) {
      hasDefault = true;
      defaultValue = dflt.defaultValue;
      current = dflt.innerType;
      continue;
    }
    const lit = as<z.core.$ZodLiteralDef<z.core.util.Literal>>("literal");
    if (lit) {
      hasFixed = true;
      fixedValue = lit.values[0];
    }
    return { itemSchema: current, isArray, hasDefault, defaultValue, hasFixed, fixedValue };
  }
};

// ---------------------------------------------------------------------------
// Schema-driven lexical coercion — the single coercion point. The schema's own
// def decides the conversion; there are no metadata typeNames anymore.
// ---------------------------------------------------------------------------

const BOOLEAN_LEXICALS = new Set(["true", "false", "0", "1"]);
const INTEGER_LEXICAL = /^[+-]?\d+$/;
const FLOAT_LEXICAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const INT_FORMATS = new Set(["safeint", "int32", "uint32", "int64", "uint64"]);

const isIntChecked = (def: z.core.$ZodNumberDef): boolean =>
  (def.checks ?? []).some((check) => {
    const checkDef = check._zod.def as { check?: string; format?: string };
    return checkDef.check === "number_format" && INT_FORMATS.has(checkDef.format ?? "");
  });

// XSD float/double special lexicals → JS values (#116).
const FLOAT_SPECIALS: Record<string, number> = {
  INF: Infinity,
  "-INF": -Infinity,
  NaN: NaN,
};

const coerceNumberValue = (trimmed: string): number => {
  // The specials are valid xs:float/xs:double lexicals; the generated schemas
  // for those types accept them via an explicit union (#116). For plain
  // numeric types the schema validation rejects the non-finite result, which
  // keeps decimal & co. rejecting "INF" coherently.
  const special = FLOAT_SPECIALS[trimmed];
  if (special !== undefined) {
    return special;
  }
  if (!FLOAT_LEXICAL.test(trimmed)) {
    throw new Error(`Invalid xs:double lexical: ${JSON.stringify(trimmed)}`);
  }
  return Number(trimmed);
};

const coerceNumber = (raw: string, def: z.core.$ZodNumberDef): number => {
  const trimmed = raw.trim();
  if (isIntChecked(def)) {
    if (!INTEGER_LEXICAL.test(trimmed)) {
      throw new Error(`Invalid xs:int lexical: ${JSON.stringify(trimmed)}`);
    }
    return Number(trimmed);
  }
  return coerceNumberValue(trimmed);
};

const coerceBigInt = (raw: string): bigint => {
  const trimmed = raw.trim();
  if (!INTEGER_LEXICAL.test(trimmed)) {
    throw new Error(`Invalid xs:integer lexical: ${JSON.stringify(trimmed)}`);
  }
  return BigInt(trimmed);
};

const coerceBoolean = (raw: string): boolean => {
  const trimmed = raw.trim();
  if (!BOOLEAN_LEXICALS.has(trimmed)) {
    throw new Error(`Invalid xs:boolean lexical: ${JSON.stringify(trimmed)}`);
  }
  return trimmed === "true" || trimmed === "1";
};

const coerceList = (raw: unknown, itemSchema: AnySchema): unknown[] =>
  String(raw)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((item) => coerceLexical(item, itemSchema));

const coerceLexical = (raw: unknown, schema: AnySchema, skipFacets = false): unknown => {
  if (raw === undefined || raw === null) {
    return raw;
  }
  if (!skipFacets) {
    const facets = findFacetsMeta(schema);
    if (facets !== undefined) {
      checkLexicalFacets(String(raw), schema, facets);
    }
  }
  const def = unwrapModifiers(schema)._zod.def;
  switch (def.type) {
    case "number":
      return coerceNumber(String(raw), def as z.core.$ZodNumberDef);
    case "bigint":
      return coerceBigInt(String(raw));
    case "boolean":
      return coerceBoolean(String(raw));
    case "string":
      return String(raw);
    case "literal": {
      const value = (def as z.core.$ZodLiteralDef<z.core.util.Literal>).values[0];
      if (typeof value === "number") {
        return coerceNumberValue(String(raw).trim());
      }
      if (typeof value === "bigint") {
        return coerceBigInt(String(raw));
      }
      if (typeof value === "boolean") {
        return coerceBoolean(String(raw));
      }
      return String(raw);
    }
    case "enum":
      return String(raw);
    case "nan":
      return NaN;
    case "union": {
      for (const option of (def as z.core.$ZodUnionDef).options) {
        try {
          const result = coerceLexical(raw, option);
          // A NaN produced for anything but the "NaN" lexical means the
          // numeric option was the wrong branch — try the next one (#116).
          if (typeof result === "number" && Number.isNaN(result) && String(raw).trim() !== "NaN") {
            continue;
          }
          // Branch agreement: zod's union selects the first VALIDATING
          // branch, so coercion must too. A refined string member (e.g.
          // xs:gMonth in a union with a list type) no longer swallows every
          // lexical as a passthrough string.
          if (!(option as z.ZodType).safeParse(result).success) {
            continue;
          }
          return result;
        } catch {
          // intentionally empty
        }
      }
      return String(raw);
    }
    case "pipe": {
      const pipe = def as z.core.$ZodPipeDef;
      const outDef = pipe.out._zod.def;
      if (outDef.type === "array") {
        // XSD list: whitespace-separated lexicals, coerced per item.
        return coerceList(raw, (outDef as z.core.$ZodArrayDef).element);
      }
      // Other pipes (e.g. a whiteSpace preprocess) coerce as their inner type.
      return coerceLexical(raw, pipe.out);
    }
    case "array":
      return coerceList(raw, (def as z.core.$ZodArrayDef).element);
    default:
      return raw;
  }
};

// ---------------------------------------------------------------------------
// Lexical preservation
// ---------------------------------------------------------------------------

const findFacetsMeta = (schema: AnySchema): XmlLexicalFacets | undefined =>
  findMeta(schema, (m) => m.facets)?.facets;

const applyWhiteSpace = (
  lexical: string,
  whiteSpace: "replace" | "collapse" | undefined,
): string => {
  if (whiteSpace === "replace") {
    return lexical.replace(/[\t\n\r]/g, " ");
  }
  if (whiteSpace === "collapse") {
    return collapseWhiteSpace(lexical);
  }
  return lexical;
};

const valuesEqual = (a: unknown, b: unknown): boolean => {
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => valuesEqual(item, b[i]));
  }
  return a === b;
};

// Enumeration membership is a value-space compare, both sides prepared the
// same way: date/time builtins canonicalize (-00:00 equals +00:00), anything
// else compares the coerced JS values (decimal 1.0 equals 1.00).
const enumValue = (lexical: string, schema: AnySchema, facets: XmlLexicalFacets): unknown => {
  if (facets.datatype !== undefined) {
    try {
      return writeXsdDatatype(facets.datatype, parseXsdDatatype(facets.datatype, lexical));
    } catch {
      return lexical;
    }
  }
  try {
    return coerceLexical(lexical, schema, true);
  } catch {
    return lexical;
  }
};

// Lexical-space facets cannot live in the generated schema (a zod refine only
// sees the coerced value), so the runtime enforces them at parse time.
const checkLexicalFacets = (raw: string, schema: AnySchema, facets: XmlLexicalFacets): void => {
  const lexical = applyWhiteSpace(raw, facets.whiteSpace);
  // Each derivation step contributes an alternative set: any one pattern per
  // set must match (XSD ORs within a step, ANDs across steps).
  for (const alternatives of facets.patterns ?? []) {
    if (!alternatives.some((source) => xsdPattern(source).test(lexical))) {
      throw new Error(`Invalid lexical ${JSON.stringify(raw)}: does not match the pattern facet`);
    }
  }
  const enumerations = facets.enumerations ?? [];
  if (enumerations.length > 0) {
    const value = enumValue(lexical, schema, facets);
    const member = enumerations.some((allowed) =>
      valuesEqual(enumValue(applyWhiteSpace(allowed, facets.whiteSpace), schema, facets), value),
    );
    if (!member) {
      throw new Error(`Invalid lexical ${JSON.stringify(raw)}: not one of the allowed values`);
    }
  }
  const orderChecks: [string | undefined, (cmp: number) => boolean][] = [
    [facets.minInclusive, (cmp) => cmp >= 0],
    [facets.maxInclusive, (cmp) => cmp <= 0],
    [facets.minExclusive, (cmp) => cmp > 0],
    [facets.maxExclusive, (cmp) => cmp < 0],
  ];
  for (const [boundary, inRange] of orderChecks) {
    if (boundary === undefined) {
      continue;
    }
    const cmp = xsdDecimalCompare(lexical, boundary);
    // NaN means an invalid xs:decimal lexical (e.g. exponent notation).
    if (Number.isNaN(cmp)) {
      throw new Error(`Invalid xs:decimal lexical: ${JSON.stringify(raw)}`);
    }
    if (!inRange(cmp)) {
      throw new Error(`Invalid lexical ${JSON.stringify(raw)}: value out of range`);
    }
  }
};

// Retained original lexicals, keyed by the containing data object (leaf
// primitives have no identity of their own): field key → lexical, or one
// lexical per occurrence (index-aligned) for repeated fields.
type LexicalRecord = Map<string, string | (string | undefined)[]>;
const lexicalStore = new WeakMap<object, LexicalRecord>();

// The substitution-group member qname each element occurrence was read as
// (only recorded when the actual tag differs from the field's head element):
// field key → member qname, index-aligned for repeated fields. The serializer
// re-emits the member tag instead of the head's.
const substQNameStore = new WeakMap<object, LexicalRecord>();

// Prefix→URI bindings in scope for QName/NOTATION-typed values (see
// XmlFieldMeta.qnameValue), keyed like the lexicals above: field key →
// bindings, or one entry per occurrence for repeated fields. The serializer
// re-declares these so a QName value's prefix is never dangling.
type QNameNsRecord = Map<string, Record<string, string> | (Record<string, string> | undefined)[]>;
const qnameNsStore = new WeakMap<object, QNameNsRecord>();

// Lossless capture for xsi:type QNames outside the generated union (open
// world): the occurrence is read with the declared variant, and everything
// that variant would strip is kept here, keyed by the occurrence's value
// object. The serializer re-attaches the original xsi:type attribute and the
// captured content. The channel is deliberately opaque: it never shows up in
// the generated TS types, and the captured extras are the normalized open
// shape (same representation as the xs:any lax tier).
type XsiTypeCapture = {
  /** Original xsi:type of the occurrence, Clark notation. */
  typeQName: QName;
  /**
   * Declared-field entries and captured extras interleaved in document order:
   * [result field key | extra Clark key, occurrence index]. Empty when the
   * declared variant has wildcards (extras then live in the value itself via
   * the wildcard sweep) or carries mixed content (order not modeled there).
   */
  order: DocumentOrderEntry[];
  /** Captured extra child elements by Clark key, in occurrence order. */
  extras: Record<string, unknown[]>;
  /** Undeclared attributes of the slot element: [Clark qname, lexical]. */
  attributes: [string, string][];
};
const xsiCaptureStore = new WeakMap<object, XsiTypeCapture>();

// Prefixes used by a QName lexical (one per whitespace-separated token for
// list values), resolved against the in-scope namespace context.
const qnameBindingsOf = (
  lexical: string,
  namespaceContext: Record<string, string>,
): Record<string, string> | undefined => {
  let bindings: Record<string, string> | undefined;
  for (const token of lexical.trim().split(/\s+/)) {
    const prefix = splitQName(token).prefix;
    if (!prefix) {
      continue;
    }
    const uri = namespaceContext[prefix];
    if (uri === undefined) {
      continue;
    }
    bindings ??= {};
    bindings[prefix] = uri;
  }
  return bindings;
};

const recordQNameNs = (
  container: object,
  key: string,
  bindings: Record<string, string> | (Record<string, string> | undefined)[],
): void => {
  let record = qnameNsStore.get(container);
  if (record === undefined) {
    record = new Map();
    qnameNsStore.set(container, record);
  }
  record.set(key, bindings);
};

// Simple-typed roots have no containing object — keyed by the root schema,
// guarded by the parsed value so a stale entry can never attach to a
// different document.
const rootLexicals = new Map<
  AnySchema,
  { data: unknown; lexical: string; qnameNs?: Record<string, string> | undefined }
>();

const recordInto = (
  store: WeakMap<object, LexicalRecord>,
  container: object,
  key: string,
  entry: string | (string | undefined)[],
): void => {
  let record = store.get(container);
  if (record === undefined) {
    record = new Map();
    store.set(container, record);
  }
  record.set(key, entry);
};

const recordLexical = (
  container: object,
  key: string,
  lexical: string | (string | undefined)[],
): void => {
  recordInto(lexicalStore, container, key, lexical);
};

// zod's safeParse rebuilds the data tree, so entries keyed by the walked
// objects would be unreachable from the validated result. The two trees are
// structurally isomorphic — re-key by position.
const transferLexicals = (walked: unknown, parsed: unknown): void => {
  if (
    walked === null ||
    parsed === null ||
    typeof walked !== "object" ||
    typeof parsed !== "object"
  ) {
    return;
  }
  for (const store of [lexicalStore, substQNameStore]) {
    const record = store.get(walked);
    if (record !== undefined) {
      store.delete(walked);
      store.set(parsed, record);
    }
  }
  const qnameRecord = qnameNsStore.get(walked);
  if (qnameRecord !== undefined) {
    qnameNsStore.delete(walked);
    qnameNsStore.set(parsed, qnameRecord);
  }
  documentOrderTracker.transfer(walked, parsed);
  const xsiCapture = xsiCaptureStore.get(walked);
  if (xsiCapture !== undefined) {
    xsiCaptureStore.delete(walked);
    xsiCaptureStore.set(parsed, xsiCapture);
  }
  if (Array.isArray(walked) || Array.isArray(parsed)) {
    if (Array.isArray(walked) && Array.isArray(parsed)) {
      const n = Math.min(walked.length, parsed.length);
      for (let i = 0; i < n; i++) {
        transferLexicals(walked[i], parsed[i]);
      }
    }
    return;
  }
  for (const [key, value] of Object.entries(walked)) {
    transferLexicals(value, (parsed as Record<string, unknown>)[key]);
  }
};

// A retained lexical is only re-emitted when it still denotes the value being
// serialized — mutated or hand-built data falls back to canonical lexing.
const storedLexicalFor = (
  stored: string | undefined,
  value: unknown,
  itemSchema: AnySchema,
): string | undefined => {
  if (stored === undefined) {
    return undefined;
  }
  try {
    const whiteSpace = findFacetsMeta(itemSchema)?.whiteSpace;
    return valuesEqual(coerceLexical(applyWhiteSpace(stored, whiteSpace), itemSchema, true), value)
      ? stored
      : undefined;
  } catch {
    return undefined;
  }
};

// Serialize a leaf, preferring the lexical retained at parse time.
const serializeStoredLeaf = (
  fieldMeta: XmlFieldMeta,
  itemSchema: AnySchema,
  value: unknown,
  stored: string | undefined,
): string => {
  // Fixed constraints compare lexically — re-emit the declared fixed lexical.
  if (fieldMeta.fixedLexical !== undefined) {
    return escapeXml(fieldMeta.fixedLexical);
  }
  const lexical = storedLexicalFor(stored, value, itemSchema);
  return lexical === undefined
    ? serializeFieldLeaf(fieldMeta, itemSchema, value)
    : escapeXml(lexical);
};

// ---------------------------------------------------------------------------
// XML node lookup
// ---------------------------------------------------------------------------

const findAttributeValue = (
  node: Record<string, unknown>,
  qname: string,
  namespaceContext: Record<string, string>,
): unknown => {
  const expected = splitClark(qname);
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith("@_")) {
      continue;
    }
    const { prefix, local } = splitQName(key.slice(2));
    if (
      local === expected.local &&
      nsForAttribute(prefix, namespaceContext) === expected.namespace
    ) {
      return value;
    }
  }
  return undefined;
};

const findElementValues = (
  node: Record<string, unknown>,
  qname: string,
  namespaceContext: Record<string, string>,
  substitutes: readonly QName[] = [],
): { value: unknown; qname: QName; rawKey: string }[] => {
  const expected = [qname, ...substitutes].map((q) => splitClark(q));
  const matches: { value: unknown; qname: QName; rawKey: string }[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_") || key === "#text" || key === "#cdata") {
      continue;
    }
    const { prefix, local } = splitQName(key);
    for (const item of toArray(value)) {
      const namespace = nsForElement(prefix, contextFor(item, namespaceContext));
      const match = expected.find(
        (e) => e.local === local && (namespace === e.namespace || (e.namespace === "" && !prefix)),
      );
      if (match !== undefined) {
        matches.push({ value: item, qname: `{${match.namespace}}${match.local}`, rawKey: key });
      }
    }
  }
  return matches;
};

const findSubstElementMeta = (schema: AnySchema): QName | undefined =>
  findMeta(schema, (m) => m.substElement)?.substElement;

// The schema to read or serialize one element occurrence with. A
// substitution-group head field's schema is a union of per-element options,
// each tagged with its element qname (XmlMeta.substElement); the option
// whose qname matches the actual tag wins — head tags included, since the
// union itself is not the head's type. Any other field schema passes through
// unchanged.
const substitutionSchemaFor = (tagQName: string, headSchema: AnySchema): AnySchema => {
  const def = unwrapModifiers(headSchema)._zod.def;
  if (def.type !== "union") {
    return headSchema;
  }
  for (const option of (def as z.core.$ZodUnionDef).options) {
    if (findSubstElementMeta(option as AnySchema) === tagQName) {
      return option as AnySchema;
    }
  }
  return headSchema;
};

// ---------------------------------------------------------------------------
// xsi:type polymorphism. Codegen emits a slot (element field or root element)
// whose declared complex type is abstract or has known derived types as
// z.discriminatedUnion("xsiType", [declaredVariant, ...derivedVariants]).
// Each variant is the type's object schema extended with a synthetic xsiType
// literal property and registered with the type's qname. The runtime reads
// the xsi:type attribute to pick the variant, injects the xsiType field so
// validation dispatches, and never serializes that field as content.
// ---------------------------------------------------------------------------

const xsiTypeUnionDef = (schema: AnySchema): z.core.$ZodDiscriminatedUnionDef | undefined => {
  const def = unwrapModifiers(schema)._zod.def;
  if (def.type !== "union" || !("discriminator" in def)) {
    return undefined;
  }
  return def.discriminator === XSI_TYPE_FIELD
    ? (def as z.core.$ZodDiscriminatedUnionDef)
    : undefined;
};

// Type qname of a union variant, from its xmlRegistry entry.
const xsiTypeOptionQName = (option: AnySchema): QName | undefined => findObjectMeta(option)?.qname;

// The xsi:type attribute of an element node, resolved against the element's
// in-scope namespace map to Clark notation. Unresolvable prefixes yield
// undefined (treated as no xsi:type).
const readXsiTypeAttr = (
  node: Record<string, unknown>,
  namespaceContext: Record<string, string>,
): QName | undefined => {
  const raw = findAttributeValue(node, `{${XSI_NS}}type`, namespaceContext);
  if (typeof raw !== "string") {
    return undefined;
  }
  const { prefix, local } = splitQName(raw.trim());
  // An unprefixed value resolves through the default namespace; with none in
  // scope that is the empty namespace (Clark `{}local`), not "unresolvable".
  const namespace = prefix ? namespaceContext[prefix] : (namespaceContext[""] ?? "");
  return namespace === undefined ? undefined : `{${namespace}}${local}`;
};

// Read one occurrence of a polymorphic slot: dispatch on xsi:type to the
// matching variant schema (options[0] is the declared type). An absent or
// declared-type xsi:type reads as the declared type; the discriminant is
// injected only for known derived types. An unknown xsi:type also reads as
// the declared type, but the original QName and the content the declared
// variant strips are captured for lossless re-serialization (XsiTypeCapture).
const readXsiTypeOccurrence = (
  unionDef: z.core.$ZodDiscriminatedUnionDef,
  node: Record<string, unknown>,
  namespaceContext: Record<string, string>,
  walk?: WalkCtx,
): Record<string, unknown> => {
  const options = unionDef.options as readonly AnySchema[];
  const declared = options[0]!;
  const xsiType = readXsiTypeAttr(node, namespaceContext);
  const derived =
    xsiType === undefined
      ? undefined
      : options.slice(1).find((option) => xsiTypeOptionQName(option) === xsiType);
  // An unknown xsi:type captures what the declared variant strips, merging
  // extras into the variant's document-order recording — force it even where
  // the gate would otherwise skip (single-field declared types).
  const mayCapture =
    derived === undefined && xsiType !== undefined && xsiType !== xsiTypeOptionQName(declared);
  const value = readObject(derived ?? declared, node, namespaceContext, mayCapture, walk);
  if (derived !== undefined && xsiType !== undefined) {
    value[XSI_TYPE_FIELD] = xsiType;
    return value;
  }
  if (xsiType !== undefined && xsiType !== xsiTypeOptionQName(declared)) {
    captureUnknownXsiType(declared, node, namespaceContext, value, xsiType);
  }
  return value;
};

// Capture what the declared variant stripped from an unknown-xsi:type
// occurrence (see XsiTypeCapture): undeclared attributes, and extra child
// elements in the normalized open shape, interleaved with the declared
// fields in document order. When the declared variant has wildcards, extras
// already live in the value via the wildcard sweep — capturing them again
// would double them, so only the xsi:type QName is recorded.
const captureUnknownXsiType = (
  declared: AnySchema,
  node: Record<string, unknown>,
  namespaceContext: Record<string, string>,
  value: Record<string, unknown>,
  typeQName: QName,
): void => {
  const fields = findFieldsMeta(declared) ?? {};
  const fieldList = Object.values(fields);
  if (fieldList.some((f) => f.kind === "any" || f.kind === "anyAttribute")) {
    xsiCaptureStore.set(value, { typeQName, order: [], extras: {}, attributes: [] });
    return;
  }
  const context = withNamespaceContext(namespaceContext, node);
  // The declared element field (result key) owning a raw child tag, with the
  // same leniency as findElementValues: an unqualified field also matches
  // unprefixed elements in the inherited default namespace.
  const elementFields = Object.entries(fields).filter(([, f]) => f.kind === "element");
  const fieldKeyFor = (clark: string, prefix: string): string | undefined => {
    const actual = splitClark(clark);
    for (const [key, fieldMeta] of elementFields) {
      for (const candidate of [fieldMeta.qname, ...(fieldMeta.substitutes ?? [])]) {
        const expected = splitClark(candidate);
        if (
          actual.local === expected.local &&
          (actual.namespace === expected.namespace || (expected.namespace === "" && prefix === ""))
        ) {
          return key;
        }
      }
    }
    return undefined;
  };

  const knownAttributes = new Set(
    fieldList.filter((f) => f.kind === "attribute").map((f) => f.qname),
  );
  const attributes: [string, string][] = [];
  for (const [key, raw] of Object.entries(node)) {
    if (!key.startsWith("@_") || key === "@_xmlns" || key.startsWith("@_xmlns:")) {
      continue;
    }
    const { prefix, local } = splitQName(key.slice(2));
    const namespace = prefix ? (context[prefix] ?? "") : "";
    // xsi:* attributes are processor directives; xsi:type is re-emitted from
    // typeQName.
    if (namespace === XSI_NS) {
      continue;
    }
    const clark = `{${namespace}}${local}`;
    if (!knownAttributes.has(clark as QName)) {
      attributes.push([clark, String(raw)]);
    }
  }

  // Merge the declared fields' document-order recording (a subsequence of the
  // node's children) with the captured extras into one sequence.
  const retained = documentOrderTracker.orderOf(value) ?? [];
  let retainedIndex = 0;
  const order: DocumentOrderEntry[] = [];
  const extras: Record<string, unknown[]> = {};
  for (const [rawKey, rawValue] of documentOrderTracker.childOrderOf(node) ??
    Object.entries(node)) {
    if (rawKey.startsWith("@_") || rawKey === "#text" || rawKey === "#cdata") {
      continue;
    }
    const { prefix } = splitQName(rawKey);
    for (const item of toArray(rawValue)) {
      const clark = rawChildClarkKey(rawKey, item, context);
      const key = fieldKeyFor(clark, prefix);
      if (key === undefined) {
        const list = extras[clark] ?? [];
        extras[clark] = list;
        const itemNode =
          item !== null && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
        list.push(itemNode === undefined ? item : openWalk(itemNode, contextFor(item, context)));
        order.push([clark, list.length - 1]);
        continue;
      }
      const retainedEntry = retained[retainedIndex];
      if (retainedEntry !== undefined && retainedEntry[0] === key) {
        order.push(retainedEntry);
        retainedIndex++;
      }
      // Otherwise the occurrence was claimed but dropped from the value
      // (e.g. overflow of a scalar field) — it stays dropped.
    }
  }
  xsiCaptureStore.set(value, { typeQName, order, extras, attributes });
};

const extractRoot = (
  parsed: Record<string, unknown>,
  expectedQName: string,
): {
  root: Record<string, unknown>;
  namespaceContext: Record<string, string>;
} => {
  const expected = splitClark(expectedQName);
  const entry = Object.entries(parsed).find(([key, value]) => {
    const node =
      value && typeof value === "object"
        ? ((Array.isArray(value) ? value[0] : value) as Record<string, unknown>)
        : {};
    const namespaceContext = withNamespaceContext({}, node);
    const { prefix, local } = splitQName(key);
    return (
      local === expected.local && nsForElement(prefix, namespaceContext) === expected.namespace
    );
  });
  if (!entry) {
    throw new Error(`Root element '${expectedQName}' not found in XML payload`);
  }
  if (Array.isArray(entry[1])) {
    // A repeated root tag parses to an array — treating its first item as the
    // root would silently drop siblings (#67).
    throw new Error(
      `XML payload contains ${entry[1].length} '${expectedQName}' root elements; expected exactly one`,
    );
  }
  if (entry[1] && typeof entry[1] === "object") {
    const root = entry[1] as Record<string, unknown>;
    return { root, namespaceContext: withNamespaceContext({}, root) };
  }
  return { root: { "#text": entry[1] }, namespaceContext: {} };
};

// ---------------------------------------------------------------------------
// Reading: XML nodes → data, driven by the schema + registry
// ---------------------------------------------------------------------------

const readObject = (
  schema: AnySchema,
  node: Record<string, unknown>,
  namespaceContext: Record<string, string>,
  forceOrderRecording = false,
  walk?: WalkCtx,
): Record<string, unknown> => {
  const fields = findFieldsMeta(schema) ?? {};
  const shape = objectDefOf(schema)?.shape ?? {};
  // Element qnames declared on this object: a tag that exactly names one of
  // them belongs to that field, not to a sibling head's substitution group
  // (the exact particle match wins over substitution-group membership).
  const exactElementQNames = new Set(
    Object.values(fields)
      .filter((f) => f.kind === "element")
      .map((f) => f.qname),
  );
  // Null prototype: an XSD element named __proto__ must become an own property,
  // not a silent prototype mutation (#84).
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const fieldList = Object.values(fields);
  const hasTextField = fieldList.some((f) => f.kind === "text");
  const hasAny = fieldList.some((f) => f.kind === "any");
  const hasAnyAttribute = fieldList.some((f) => f.kind === "anyAttribute");
  // Recording document order is dead work unless it can differ from schema
  // order: mixed content always takes the schema-order path, and a single
  // element field without wildcards or substitution members replays as its
  // value array either way (substitutes parse grouped by raw tag, so the
  // recording restores their interleaving). xsi:type slots are the exception
  // (forceOrderRecording): an unknown xsi:type capture merges extras into the
  // recording even for single-field declared variants.
  const recordOrder =
    !hasTextField &&
    (forceOrderRecording ||
      hasAny ||
      fieldList.filter((f) => f.kind === "element").length > 1 ||
      fieldList.some((f) => f.kind === "element" && (f.substitutes?.length ?? 0) > 0));
  const elementReads: ElementRead[] = [];
  for (const [key, fieldMeta] of Object.entries(fields)) {
    const fieldSchema = shape[key];
    if (!fieldSchema) {
      continue;
    }
    const { present, value, lexical, substQNames, qnameNs, claimed } = readField(
      fieldMeta,
      fieldSchema,
      node,
      namespaceContext,
      exactElementQNames,
      childWalk(walk, key),
    );
    if (recordOrder && claimed !== undefined && claimed.length > 0) {
      elementReads.push({ key, isArray: analyzeField(fieldSchema).isArray, claimed });
    }
    if (present) {
      result[key] = value;
      if (lexical !== undefined) {
        recordLexical(result, key, lexical);
      }
      if (substQNames !== undefined) {
        recordInto(substQNameStore, result, key, substQNames);
      }
      if (qnameNs !== undefined) {
        recordQNameNs(result, key, qnameNs);
      }
    }
  }
  if (hasAny || hasAnyAttribute) {
    // Scalar element fields hold exactly one occurrence (readField takes the
    // first); further occurrences of their qname are wildcard extras.
    const scalarElements = new Set(
      Object.entries(fields)
        .filter(
          ([key, f]) => f.kind === "element" && shape[key] && !analyzeField(shape[key]).isArray,
        )
        .map(([, f]) => f.qname),
    );
    sweepWildcards(result, node, fieldList, namespaceContext, {
      any: hasAny,
      anyAttribute: hasAnyAttribute,
      scalarElements,
    });
  }
  if (recordOrder) {
    const extraContext = hasAny ? withNamespaceContext(namespaceContext, node) : undefined;
    documentOrderTracker.record(
      result,
      node,
      elementReads,
      extraContext === undefined
        ? undefined
        : (rawKey, rawValue) => rawChildClarkKey(rawKey, rawValue, extraContext),
    );
  }
  if (walk !== undefined) {
    const choices = findChoicesMeta(schema);
    if (choices !== undefined) {
      for (const message of choiceGroupIssues(choices, result)) {
        walk.issues.push({ code: "custom", message, path: [...walk.path], input: result });
      }
    }
  }
  return result;
};

// Visitor gate for walkChildren: return false to skip the entry. The wildcard
// sweep excludes declared fields this way; openWalk accepts everything.
type ChildAccept = {
  attribute?: (namespace: string, local: string) => boolean;
  element?: (namespace: string, local: string, prefix: string) => boolean;
};

const nsForElement = (prefix: string, ctx: Record<string, string>): string =>
  prefix ? (ctx[prefix] ?? "") : (ctx[""] ?? "");
const nsForAttribute = (prefix: string, ctx: Record<string, string>): string =>
  prefix ? (ctx[prefix] ?? "") : "";

const contextFor = (rawValue: unknown, base: Record<string, string>): Record<string, string> => {
  const itemNode =
    rawValue !== null && typeof rawValue === "object"
      ? (rawValue as Record<string, unknown>)
      : undefined;
  return itemNode ? withNamespaceContext(base, itemNode) : base;
};

// Clark key of a raw child entry: per-item namespace context, since repeated
// siblings may redeclare prefixes.
const rawChildClarkKey = (
  rawKey: string,
  rawValue: unknown,
  context: Record<string, string>,
): string => {
  const { prefix, local } = splitQName(rawKey);
  return `{${nsForElement(prefix, contextFor(rawValue, context))}}${local}`;
};

// Shared walk over a parsed node's content entries, into the normalized open
// shape: character data and xmlns declarations are skipped, attributes resolve
// to '@'-prefixed clark keys, elements to clark keys with the namespace
// resolved per item (repeated siblings may redeclare prefixes, #67), and
// repeated child keys accumulate into arrays. Returns whether anything was
// written.
const walkChildren = (
  target: Record<string, unknown>,
  node: Record<string, unknown>,
  namespaceContext: Record<string, string>,
  accept: ChildAccept = {},
): boolean => {
  const context = withNamespaceContext(namespaceContext, node);
  let wrote = false;
  for (const [key, value] of Object.entries(node)) {
    if (key === "#text" || key === "#cdata" || key === "@_xmlns" || key.startsWith("@_xmlns:")) {
      continue;
    }
    if (key.startsWith("@_")) {
      const { prefix, local } = splitQName(key.slice(2));
      const ns = nsForAttribute(prefix, context);
      if (ns === XSI_NS || accept.attribute?.(ns, local) === false) {
        continue;
      }
      target[`@${ns ? `{${ns}}` : ""}${local}`] = value === undefined ? value : String(value);
      wrote = true;
      continue;
    }
    const { prefix, local } = splitQName(key);
    for (const item of toArray(value)) {
      if (
        accept.element?.(nsForElement(prefix, contextFor(item, context)), local, prefix) === false
      ) {
        continue;
      }
      const childKey = rawChildClarkKey(key, item, context);
      const itemNode =
        item !== null && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
      const childValue = itemNode ? openWalk(itemNode, context) : item;
      const existing = target[childKey];
      if (existing === undefined) {
        target[childKey] = childValue;
      } else if (Array.isArray(existing)) {
        existing.push(childValue);
      } else {
        target[childKey] = [existing, childValue];
      }
      wrote = true;
    }
  }
  return wrote;
};

// xs:any / xs:anyAttribute (lax tier): unmatched children captured in open shape.
const sweepWildcards = (
  result: Record<string, unknown>,
  node: Record<string, unknown>,
  fieldList: XmlFieldMeta[],
  namespaceContext: Record<string, string>,
  wildcards: { any: boolean; anyAttribute: boolean; scalarElements?: Set<string> },
): void => {
  const knownElements = new Set(
    fieldList
      .filter((f) => f.kind === "element")
      .flatMap((f) => [f.qname, ...(f.substitutes ?? [])]),
  );
  const knownAttributes = new Set(
    fieldList.filter((f) => f.kind === "attribute").map((f) => f.qname),
  );
  const consumed = new Map<string, number>();
  const scalarQNameOf = (ns: string, local: string, prefix: string): string | undefined => {
    if (wildcards.scalarElements === undefined) {
      return undefined;
    }
    const exact = `{${ns}}${local}`;
    if (wildcards.scalarElements.has(exact)) {
      return exact;
    }
    const unq = `{}${local}`;
    return prefix === "" && wildcards.scalarElements.has(unq) ? unq : undefined;
  };
  walkChildren(result, node, namespaceContext, {
    attribute: wildcards.anyAttribute
      ? (ns, local) => !knownAttributes.has(`{${ns}}${local}`)
      : () => false,
    element: wildcards.any
      ? (ns, local, prefix) => {
          const sq = scalarQNameOf(ns, local, prefix);
          if (sq !== undefined) {
            const seen = (consumed.get(sq) ?? 0) + 1;
            consumed.set(sq, seen);
            return seen > 1;
          }
          return (
            !knownElements.has(`{${ns}}${local}`) &&
            (prefix !== "" || !knownElements.has(`{}${local}`))
          );
        }
      : () => false,
  });
};

const substituteEmpty = (
  field: FieldAnalysis,
  fieldMeta: XmlFieldMeta,
): { substituted: boolean; value?: unknown } => {
  if (field.hasFixed) {
    return { substituted: true, value: field.fixedValue };
  }
  if (fieldMeta.fixedValue !== undefined) {
    return { substituted: true, value: fieldMeta.fixedValue };
  }
  if (fieldMeta.defaultValue !== undefined) {
    return { substituted: true, value: fieldMeta.defaultValue };
  }
  return { substituted: false };
};

const readOccurrence = (
  field: FieldAnalysis,
  fieldMeta: XmlFieldMeta,
  entry: unknown,
  namespaceContext: Record<string, string>,
  walk?: WalkCtx,
): {
  value: unknown;
  lexical?: string | undefined;
  qnameNs?: Record<string, string> | undefined;
} => {
  if (entry !== null && typeof entry === "object") {
    const childNode = entry as Record<string, unknown>;
    const childContext = withNamespaceContext(namespaceContext, childNode);
    const nilValue = findAttributeValue(childNode, `{${XSI_NS}}nil`, childContext);
    if (nilValue === "true" || nilValue === "1") {
      return { value: null };
    }
    const xsiUnion = xsiTypeUnionDef(field.itemSchema);
    if (xsiUnion !== undefined) {
      return { value: readXsiTypeOccurrence(xsiUnion, childNode, childContext, walk) };
    }
    if (fieldMeta.open) {
      // Element default/fixed applies to present-but-empty open fields too.
      const text = textOf(childNode);
      if (text === undefined || text === "") {
        const empty = substituteEmpty(field, fieldMeta);
        if (empty.substituted) {
          return { value: empty.value };
        }
      }
      return { value: openWalk(childNode, childContext) };
    }
    if (hasObjectShape(field.itemSchema)) {
      return { value: readObject(field.itemSchema, childNode, childContext, false, walk) };
    }
    const text = textOf(childNode);
    if (text === undefined || text === "") {
      const empty = substituteEmpty(field, fieldMeta);
      if (empty.substituted) {
        return { value: empty.value };
      }
    }
    // A present element without character data has empty-string content: valid
    // for string-allowing types, and numeric coercion of '' still rejects.
    // Element children under a simple type are not character data — keep the
    // absent value so validation rejects them.
    return {
      value:
        text === undefined && hasElementChildren(childNode)
          ? undefined
          : coerceLexical(text ?? "", field.itemSchema),
      lexical: text === undefined ? undefined : String(text),
      qnameNs:
        fieldMeta.qnameValue && text !== undefined && text !== ""
          ? qnameBindingsOf(String(text), childContext)
          : undefined,
    };
  }

  // Scalar entry: the parser yields text-only elements as bare strings.
  if (entry === "") {
    const empty = substituteEmpty(field, fieldMeta);
    if (empty.substituted) {
      return { value: empty.value };
    }
  }
  if (fieldMeta.open) {
    return { value: entry };
  }
  const scalarXsiUnion = xsiTypeUnionDef(field.itemSchema);
  if (scalarXsiUnion !== undefined) {
    // Empty element at a polymorphic slot: the parser yields it as a bare
    // string. A scalar node has no attributes, so no xsi:type — read it as
    // the declared type (options[0]).
    return {
      value: readObject(
        scalarXsiUnion.options[0] as AnySchema,
        { "#text": entry },
        namespaceContext,
        false,
        walk,
      ),
    };
  }
  if (hasObjectShape(field.itemSchema)) {
    return {
      value: readObject(field.itemSchema, { "#text": entry }, namespaceContext, false, walk),
    };
  }
  return {
    value: coerceLexical(entry, field.itemSchema),
    lexical: String(entry),
    qnameNs:
      fieldMeta.qnameValue && entry !== ""
        ? qnameBindingsOf(String(entry), namespaceContext)
        : undefined,
  };
};

type FieldRead = {
  present: boolean;
  value: unknown;
  lexical?: string | (string | undefined)[] | undefined;
  /** Member qname per occurrence — set only where it differs from the head. */
  substQNames?: string | (string | undefined)[] | undefined;
  qnameNs?: Record<string, string> | (Record<string, string> | undefined)[] | undefined;
  /**
   * Raw parser-node occurrences the field claimed, index-aligned with the
   * produced value(s) — readObject maps them onto document-order positions.
   */
  claimed?: ClaimedOccurrence[];
};

const readField = (
  fieldMeta: XmlFieldMeta,
  fieldSchema: AnySchema,
  node: Record<string, unknown>,
  namespaceContext: Record<string, string>,
  exactElementQNames?: ReadonlySet<string>,
  walk?: WalkCtx,
): FieldRead => {
  const field = analyzeField(fieldSchema);

  if (fieldMeta.kind === "attribute") {
    const raw = findAttributeValue(node, fieldMeta.qname, namespaceContext);
    if (raw === undefined) {
      // Absent attribute: XSD applies default/fixed on absence. Validation
      // normally fills these via zod (.default()/z.literal); on the
      // validate:false fast path the walker supplies them from the def.
      if (field.hasFixed) {
        return { present: true, value: field.fixedValue };
      }
      // Structured date/time fixed (no z.literal — see XmlFieldMeta.fixedValue).
      if (fieldMeta.fixedValue !== undefined) {
        return { present: true, value: fieldMeta.fixedValue };
      }
      // Structured date/time attribute default: the meta lexical, which
      // validation transforms (the def default is the transformed object and
      // would fail re-validation as a pipe input).
      if (fieldMeta.defaultValue !== undefined) {
        return { present: true, value: fieldMeta.defaultValue };
      }
      if (field.hasDefault) {
        return { present: true, value: field.defaultValue };
      }
      return { present: false, value: undefined };
    }
    return {
      present: true,
      value: coerceLexical(raw, field.itemSchema),
      lexical: String(raw),
      qnameNs: fieldMeta.qnameValue ? qnameBindingsOf(String(raw), namespaceContext) : undefined,
    };
  }

  if (fieldMeta.kind === "text") {
    const text = textOf(node);
    // Mixed content makes `_text` optional: absent character data means an
    // absent field. simpleContent's required `_text` still reads a
    // present-but-empty element as empty-string content.
    if (text === undefined && defAs<z.core.$ZodOptionalDef>(fieldSchema._zod.def, "optional")) {
      return { present: false, value: undefined };
    }
    // A present element without character data has empty-string content: valid
    // for string-allowing types, and numeric coercion of '' still rejects.
    return {
      present: true,
      value: coerceLexical(text ?? "", field.itemSchema),
      lexical: text === undefined ? "" : String(text),
    };
  }

  const matched = findElementValues(
    node,
    fieldMeta.qname,
    namespaceContext,
    fieldMeta.substitutes ?? [],
  ).filter((entry) => entry.qname === fieldMeta.qname || !exactElementQNames?.has(entry.qname));
  const occurrences = matched.map((entry, index) => {
    const itemSchema = substitutionSchemaFor(entry.qname, field.itemSchema);
    const occField = itemSchema === field.itemSchema ? field : { ...field, itemSchema };
    const occWalk = field.isArray ? childWalk(walk, index) : walk;
    return {
      ...readOccurrence(occField, fieldMeta, entry.value, namespaceContext, occWalk),
      qname: entry.qname,
    };
  });
  const qnames = occurrences.map((o) => (o.qname === fieldMeta.qname ? undefined : o.qname));
  const substituted = qnames.some((q) => q !== undefined);
  const claimed = matched.map((entry, index) => ({
    rawKey: entry.rawKey,
    rawValue: entry.value,
    index,
  }));
  if (field.isArray) {
    const lexicals = occurrences.map((o) => o.lexical);
    const qnameNs = occurrences.map((o) => o.qnameNs);
    return {
      present: true,
      value: occurrences.map((o) => o.value),
      lexical: lexicals.some((l) => l !== undefined) ? lexicals : undefined,
      substQNames: substituted ? qnames : undefined,
      qnameNs: qnameNs.some((n) => n !== undefined) ? qnameNs : undefined,
      claimed,
    };
  }
  if (occurrences.length > 0) {
    return {
      present: true,
      value: occurrences[0]?.value,
      lexical: occurrences[0]?.lexical,
      substQNames: qnames[0],
      qnameNs: occurrences[0]?.qnameNs,
      claimed,
    };
  }
  // Absent element: no default/fixed substitution — XSD applies those to
  // present-but-empty elements, not absent ones (#66).
  return { present: false, value: undefined };
};

const walkRoot = (schema: AnySchema, xml: string, walk?: WalkCtx): unknown => {
  const meta = findRootMeta(schema);
  if (!meta?.root) {
    throw new Error("schema is not an XML root: no root qname registered in xmlRegistry");
  }
  const parsed = parser.parse(decodeTagNameCharRefs(xml)) as Record<string, unknown>;
  const { root: rootNode, namespaceContext } = extractRoot(parsed, meta.root);

  const nilValue = findAttributeValue(rootNode, `{${XSI_NS}}nil`, namespaceContext);
  if (nilValue === "true" || nilValue === "1") {
    return null;
  }

  if (meta.open) {
    return openWalk(rootNode, namespaceContext);
  }

  const typeSchema = peelOnce(schema);
  const xsiUnion = xsiTypeUnionDef(typeSchema);
  if (xsiUnion !== undefined) {
    return readXsiTypeOccurrence(xsiUnion, rootNode, namespaceContext, walk);
  }
  if (hasObjectShape(typeSchema)) {
    return readObject(typeSchema, rootNode, namespaceContext, false, walk);
  }
  // Simple-typed root element: the document value is the root's text content.
  // XSD applies the root element's fixed/default to a present-but-empty root.
  const text = textOf(rootNode);
  if (text === undefined || text === "") {
    if (meta.fixedValue !== undefined) {
      return meta.fixedValue;
    }
    if (meta.defaultValue !== undefined) {
      return meta.defaultValue;
    }
  }
  // A present root without character data has empty-string content: valid for
  // string-allowing types, and numeric coercion of '' still rejects. Element
  // children under a simple type are not character data — keep the absent
  // value so validation rejects them.
  const value =
    text === undefined && hasElementChildren(rootNode)
      ? undefined
      : coerceLexical(text ?? "", typeSchema);
  if (text !== undefined) {
    rootLexicals.set(schema, {
      data: value,
      lexical: String(text),
      qnameNs: meta.qnameValue ? qnameBindingsOf(String(text), namespaceContext) : undefined,
    });
  }
  return value;
};

// Open content (xs:anyType, wildcards): schema-less walk into the normalized
// open shape — clark-keyed child elements, '@'-prefixed attribute keys,
// '_text' for character data next to attributes/children. A leaf element
// collapses to its text string.
const openWalk = (
  node: Record<string, unknown>,
  namespaceContext: Record<string, string>,
): unknown => {
  const out: Record<string, unknown> = {};
  const hasStructure = walkChildren(out, node, namespaceContext);
  const text = textOf(node);
  if (!hasStructure) {
    // An empty open element is empty-string content, not xsi:nil.
    return text === undefined ? "" : text;
  }
  if (text !== undefined && text !== "") {
    out["_text"] = text;
  }
  return out;
};

// ---------------------------------------------------------------------------
// Writing: data → XML, driven by the schema + registry
// ---------------------------------------------------------------------------

const choosePrefix = (
  uri: string,
  prefixMap: Map<string, string>,
  reserved?: ReadonlyMap<string, string>,
): string => {
  // The xml prefix is bound by definition — use it directly, undeclared.
  if (uri === XML_NS) {
    return "xml";
  }
  const existing = prefixMap.get(uri);
  if (existing) {
    return existing;
  }
  const used = new Set(prefixMap.values());
  let n = prefixMap.size;
  let next = `ns${n}`;
  while (used.has(next) || reserved?.has(next)) {
    next = `ns${++n}`;
  }
  prefixMap.set(uri, next);
  return next;
};

const elementName = (
  qname: string,
  prefixMap: Map<string, string>,
  reserved?: ReadonlyMap<string, string>,
): string => {
  const { namespace, local } = splitClark(qname);
  if (!namespace) {
    return local;
  }
  return `${choosePrefix(namespace, prefixMap, reserved)}:${local}`;
};

type SerializeCtx = {
  prefixMap: Map<string, string>;
  // Explicit prefix→URI declarations for QName/NOTATION value lexicals
  // (recorded at parse time), emitted at the root alongside prefixMap decls.
  qnameNs: Map<string, string>;
};

// Re-declare the prefix bindings a QName/NOTATION lexical relies on, returning
// the lexical untouched — or rewritten to a fresh prefix when the original
// prefix is already bound to a different URI in the output document.
const declareQNamePrefixes = (
  lexical: string,
  bindings: Record<string, string> | undefined,
  ctx: SerializeCtx,
): string => {
  if (bindings === undefined) {
    return lexical;
  }
  // choosePrefix reserves these prefixes (see the reserved argument), so only
  // prefixes already allocated — before the binding was seen — collide.
  const prefixTaken = (prefix: string): boolean =>
    ctx.qnameNs.has(prefix) || [...ctx.prefixMap.values()].includes(prefix);
  return lexical
    .split(/(\s+)/)
    .map((token) => {
      const { prefix, local } = splitQName(token);
      const uri = prefix ? bindings[prefix] : undefined;
      if (!prefix || uri === undefined) {
        return token;
      }
      // The xml prefix is bound by definition and must not be declared.
      if (prefix === "xml") {
        return token;
      }
      if (ctx.qnameNs.get(prefix) === uri) {
        return token;
      }
      if (!prefixTaken(prefix)) {
        ctx.qnameNs.set(prefix, uri);
        return token;
      }
      let fresh = `qns${ctx.qnameNs.size}`;
      while (prefixTaken(fresh)) {
        fresh = `${fresh}x`;
      }
      ctx.qnameNs.set(fresh, uri);
      return `${fresh}:${local}`;
    })
    .join("");
};

// XSD namespace-constraint check ('##any', '##other', '##targetNamespace',
// '##local', or explicit URIs). Lax tier: used to attribute extras to a
// wildcard at serialization time, never to reject content.
const wildcardAllows = (
  constraint: string,
  targetNamespace: string,
  namespace: string,
): boolean => {
  for (const token of constraint.trim().split(/\s+/)) {
    if (token === "##any") {
      return true;
    }
    if (token === "##other" && namespace !== targetNamespace && namespace !== "") {
      return true;
    }
    if (token === "##targetNamespace" && namespace === targetNamespace) {
      return true;
    }
    if (token === "##local" && namespace === "") {
      return true;
    }
    if (token === namespace && namespace !== "") {
      return true;
    }
  }
  return false;
};

// Serialize the normalized open shape (see openWalk): attributes, child
// elements (arrays repeat), '_text'. Leaf values serialize as text.
const openSerialize = (
  value: unknown,
  ctx: SerializeCtx,
): { attributes: string[]; body: string; usesXsi: boolean } => {
  if (value === null || typeof value !== "object") {
    return { attributes: [], body: serializePrimitive(value), usesXsi: false };
  }
  const attributes: string[] = [];
  const elements: string[] = [];
  let usesXsi = false;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) {
      continue;
    }
    if (key === "_text") {
      elements.push(serializePrimitive(entry));
      continue;
    }
    if (key.startsWith("@")) {
      attributes.push(
        `${elementName(key.slice(1), ctx.prefixMap, ctx.qnameNs)}="${escapeXmlAttrChars(serializePrimitive(entry))}"`,
      );
      continue;
    }
    const tag = elementName(key, ctx.prefixMap, ctx.qnameNs);
    usesXsi = pushOpenChildren(elements, tag, entry, ctx) || usesXsi;
  }
  return { attributes, body: elements.join(""), usesXsi };
};

// Emit one open-shape child element entry: arrays repeat the tag, null is nil.
// Returns whether xsi:nil was used.
const pushOpenChildren = (
  elements: string[],
  tag: string,
  value: unknown,
  ctx: SerializeCtx,
): boolean => {
  let usesXsi = false;
  for (const item of Array.isArray(value) ? value : [value]) {
    if (item === null) {
      usesXsi = true;
      elements.push(`<${tag} xsi:nil="true"/>`);
      continue;
    }
    const inner = openSerialize(item, ctx);
    usesXsi = usesXsi || inner.usesXsi;
    const attrStr = inner.attributes.length > 0 ? ` ${inner.attributes.join(" ")}` : "";
    elements.push(`<${tag}${attrStr}>${inner.body}</${tag}>`);
  }
  return usesXsi;
};

const serializePrimitive = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    // XSD lexicals for the float/double specials (#116).
    if (Number.isNaN(value)) {
      return "NaN";
    }
    if (value === Infinity) {
      return "INF";
    }
    if (value === -Infinity) {
      return "-INF";
    }
    // String(-0) is "0" — keep the sign so the round-trip preserves -0 (#117).
    if (Object.is(value, -0)) {
      return "-0";
    }
  }
  return escapeXml(String(value));
};

const serializeListValue = (value: unknown): string => {
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((item) => serializePrimitive(item)).join(" ");
};

const serializeLeaf = (schema: AnySchema, value: unknown): string => {
  // An array at a leaf is an XSD list value — also when it arrived through a
  // union member, where the schema's def does not say 'array'.
  if (Array.isArray(value)) {
    return serializeListValue(value);
  }
  const def = unwrapModifiers(schema)._zod.def;
  if (def.type === "pipe") {
    const outDef = (def as z.core.$ZodPipeDef).out._zod.def;
    if (outDef.type === "array") {
      return serializeListValue(value);
    }
  }
  if (def.type === "array") {
    return serializeListValue(value);
  }
  return serializePrimitive(value);
};

// Structured date/time value → canonical XSD lexical. Strings pass through
// unchanged (back-compat for hand-written schemas and mixed usage).
const serializeDatatypeValue = (datatype: XsdDatatypeName, value: unknown): string =>
  escapeXml(
    typeof value === "string" ? value : writeXsdDatatype(datatype, value as XsdStructuredValue),
  );

// Pick the variant schema to serialize a polymorphic-slot value with, plus
// the xsi:type attribute to emit — omitted when the discriminant is absent or
// matches the declared type (options[0]). A discriminant naming no known
// variant serializes with the declared type but keeps its xsi:type attribute:
// the value claims a type outside the closed union.
const xsiTypeVariantFor = (
  unionDef: z.core.$ZodDiscriminatedUnionDef,
  value: Record<string, unknown>,
  ctx: SerializeCtx,
): { option: AnySchema; xsiTypeAttr?: string } => {
  const options = unionDef.options as readonly AnySchema[];
  const declared = options[0]!;
  const raw = value[XSI_TYPE_FIELD];
  const xsiType =
    typeof raw === "string" && trySplitClark(raw) !== undefined ? (raw as QName) : undefined;
  if (xsiType === undefined || xsiType === xsiTypeOptionQName(declared)) {
    return { option: declared };
  }
  const match = options.slice(1).find((option) => xsiTypeOptionQName(option) === xsiType);
  return {
    option: match ?? declared,
    xsiTypeAttr: `xsi:type="${elementName(xsiType, ctx.prefixMap, ctx.qnameNs)}"`,
  };
};

// The xsi:type attribute re-attaching an unknown-xsi:type capture (undefined
// when there is no capture): the original QName, prefixed for the output
// document.
const xsiTypeAttrFor = (
  capture: XsiTypeCapture | undefined,
  ctx: SerializeCtx,
): string | undefined =>
  capture === undefined
    ? undefined
    : `xsi:type="${elementName(capture.typeQName, ctx.prefixMap, ctx.qnameNs)}"`;

// Leaf serialization honoring the field's structured datatype meta; list
// values canonicalize per item.
const serializeFieldLeaf = (fieldMeta: XmlFieldMeta, schema: AnySchema, value: unknown): string => {
  const datatype = fieldMeta.datatype;
  if (datatype === undefined) {
    return serializeLeaf(schema, value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeDatatypeValue(datatype, item)).join(" ");
  }
  return serializeDatatypeValue(datatype, value);
};

const writeObjectFields = (
  schema: AnySchema,
  obj: Record<string, unknown>,
  ctx: SerializeCtx,
): { attributes: string[]; elements: string[]; usesXsi: boolean } => {
  const fields = findFieldsMeta(schema) ?? {};
  const shape = objectDefOf(schema)?.shape ?? {};
  const attributes: string[] = [];
  const elements: string[] = [];
  let usesXsi = false;
  // Synthetic xsi:type discriminant: never serialized, invisible to the
  // document-order correspondence check.
  const isSyntheticKey = (key: string): boolean =>
    key === XSI_TYPE_FIELD && XSI_TYPE_FIELD in shape;
  const lexicals = lexicalStore.get(obj);
  const substQNames = substQNameStore.get(obj);
  // Unknown-xsi:type capture (XsiTypeCapture): re-attach the undeclared
  // attributes here; the xsi:type attribute itself is added by the caller,
  // which knows the slot.
  const xsiCapture = xsiCaptureStore.get(obj);
  if (xsiCapture !== undefined) {
    for (const [clark, lexical] of xsiCapture.attributes) {
      attributes.push(
        `${elementName(clark, ctx.prefixMap, ctx.qnameNs)}="${escapeXmlAttrChars(escapeXml(lexical))}"`,
      );
    }
  }

  // Wildcard extras: data keys captured by the wildcard sweep that no declared
  // field owns. Attribute extras ride anyAttribute; element extras flush at
  // their wildcard's position among the declared element fields (see
  // XmlFieldMeta.position), so sequence order survives the round-trip.
  const fieldList = Object.values(fields);
  const anyWildcards = fieldList.filter((f) => f.kind === "any");
  const hasAnyAttribute = fieldList.some((f) => f.kind === "anyAttribute");
  const extraElements: [string, unknown][] = [];
  if (anyWildcards.length > 0 || hasAnyAttribute) {
    for (const [key, value] of Object.entries(obj)) {
      if (key in fields || value === undefined) {
        continue;
      }
      // The synthetic xsi:type discriminant is never content — not even a
      // wildcard extra.
      if (isSyntheticKey(key)) {
        continue;
      }
      if (key.startsWith("@")) {
        if (hasAnyAttribute) {
          attributes.push(
            `${elementName(key.slice(1), ctx.prefixMap, ctx.qnameNs)}="${escapeXmlAttrChars(serializePrimitive(value))}"`,
          );
        }
        continue;
      }
      if (anyWildcards.length > 0) {
        extraElements.push([key, value]);
      }
    }
  }

  // Bucket each extra under its wildcard: the first whose namespace
  // constraint allows the extra's namespace (single-wildcard types need no
  // matching; leniency: unmatched extras go to the first wildcard).
  const wildcardBuckets = new Map<XmlFieldMeta, [string, unknown][]>();
  const firstAny = anyWildcards[0];
  if (extraElements.length > 0 && firstAny !== undefined) {
    const targetNamespace = splitClark(findObjectMeta(schema)?.qname ?? "{}").namespace;
    for (const extra of extraElements) {
      const namespace = splitClark(extra[0]).namespace;
      const wildcard =
        anyWildcards.length === 1
          ? firstAny
          : (anyWildcards.find((candidate) =>
              wildcardAllows(candidate.namespaceConstraint ?? "##any", targetNamespace, namespace),
            ) ?? firstAny);
      const bucket = wildcardBuckets.get(wildcard) ?? [];
      bucket.push(extra);
      wildcardBuckets.set(wildcard, bucket);
    }
  }
  const flushWildcard = (wildcard: XmlFieldMeta): void => {
    const bucket = wildcardBuckets.get(wildcard);
    if (bucket === undefined) {
      return;
    }
    wildcardBuckets.delete(wildcard);
    for (const [key, value] of bucket) {
      usesXsi =
        pushOpenChildren(elements, elementName(key, ctx.prefixMap, ctx.qnameNs), value, ctx) ||
        usesXsi;
    }
  };

  // Emit one attribute field (order-insignificant).
  const emitAttribute = (key: string, fieldMeta: XmlFieldMeta, fieldSchema: AnySchema): void => {
    const value = obj[key];
    if (value === undefined) {
      return;
    }
    const field = analyzeField(fieldSchema);
    // XSD: an attribute equal to its default need not be written.
    if (field.hasDefault && value === field.defaultValue) {
      return;
    }
    const stored = lexicals?.get(key);
    const storedSingle = typeof stored === "string" ? stored : undefined;
    const leaf = serializeStoredLeaf(fieldMeta, field.itemSchema, value, storedSingle);
    const qnameNs = fieldMeta.qnameValue ? qnameNsStore.get(obj)?.get(key) : undefined;
    const declared = declareQNamePrefixes(
      leaf,
      typeof qnameNs === "object" && !Array.isArray(qnameNs) ? qnameNs : undefined,
      ctx,
    );
    attributes.push(
      `${elementName(fieldMeta.qname, ctx.prefixMap, ctx.qnameNs)}="${escapeXmlAttrChars(declared)}"`,
    );
  };

  // Build one element-field occurrence (index i into the field's value
  // array), honoring retained lexicals and substitution-group member tags.
  // Returns the element string, or undefined for a hole in the value array.
  const emitElementOccurrence = (
    key: string,
    fieldMeta: XmlFieldMeta,
    fieldSchema: AnySchema,
    i: number,
  ): string | undefined => {
    const field = analyzeField(fieldSchema);
    const value = obj[key];
    const values = field.isArray ? (Array.isArray(value) ? value : [value]) : [value];
    const item = values[i];
    if (item === undefined) {
      return undefined;
    }
    const stored = lexicals?.get(key);
    const storedSingle = typeof stored === "string" ? stored : undefined;
    const storedQNames = substQNames?.get(key);
    // A substituted occurrence re-emits its member tag and serializes with
    // the member's own type schema; head occurrences use the field qname.
    const occurrenceQName =
      (Array.isArray(storedQNames) ? storedQNames[i] : storedQNames) ?? fieldMeta.qname;
    const itemSchema = substitutionSchemaFor(occurrenceQName, field.itemSchema);
    const localName = elementName(occurrenceQName, ctx.prefixMap, ctx.qnameNs);
    if (item === null) {
      usesXsi = true;
      return `<${localName} xsi:nil="true"/>`;
    }
    if (fieldMeta.open) {
      const inner = openSerialize(item, ctx);
      usesXsi = usesXsi || inner.usesXsi;
      const attrStr = inner.attributes.length > 0 ? ` ${inner.attributes.join(" ")}` : "";
      return `<${localName}${attrStr}>${inner.body}</${localName}>`;
    }
    const xsiUnion = xsiTypeUnionDef(itemSchema);
    if (xsiUnion !== undefined && typeof item === "object" && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      const { option, xsiTypeAttr } = xsiTypeVariantFor(xsiUnion, record, ctx);
      // Unknown-xsi:type capture: re-attach the original xsi:type.
      const captureAttr =
        xsiTypeAttr === undefined ? xsiTypeAttrFor(xsiCaptureStore.get(record), ctx) : undefined;
      const typeAttr = xsiTypeAttr ?? captureAttr;
      const inner = writeObjectFields(option, record, ctx);
      usesXsi = usesXsi || inner.usesXsi || typeAttr !== undefined;
      const attrs = typeAttr === undefined ? inner.attributes : [...inner.attributes, typeAttr];
      const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
      return `<${localName}${attrStr}>${inner.elements.join("")}</${localName}>`;
    }
    if (hasObjectShape(itemSchema) && typeof item === "object" && !Array.isArray(item)) {
      const inner = writeObjectFields(itemSchema, item as Record<string, unknown>, ctx);
      usesXsi = usesXsi || inner.usesXsi;
      const attrStr = inner.attributes.length > 0 ? ` ${inner.attributes.join(" ")}` : "";
      return `<${localName}${attrStr}>${inner.elements.join("")}</${localName}>`;
    }
    const storedItem = Array.isArray(stored) ? stored[i] : storedSingle;
    const leaf = serializeStoredLeaf(fieldMeta, itemSchema, item, storedItem);
    const qnameNs = fieldMeta.qnameValue ? qnameNsStore.get(obj)?.get(key) : undefined;
    const bindings = Array.isArray(qnameNs) ? qnameNs[i] : qnameNs;
    return `<${localName}>${declareQNamePrefixes(leaf, bindings, ctx)}</${localName}>`;
  };

  // Parsed data that still matches its parse-time recording replays the
  // children in document order (wildcard extras included) so interleaved
  // repeated compositors survive the round-trip. Mutated or hand-built data
  // falls back to schema-order emission below.
  const documentOrder =
    xsiCapture === undefined
      ? documentOrderTracker.usable(obj, fields, anyWildcards.length > 0, isSyntheticKey)
      : documentOrderTracker.usableCapture(xsiCapture.order, xsiCapture.extras, obj, fields);
  if (documentOrder !== undefined) {
    // Occurrences are built in schema order and only assembled in document
    // order, so namespace prefix allocation observes the same field sequence
    // as the schema-order path.
    const buffered = new Map<string, (string | undefined)[]>();
    for (const [key, fieldMeta] of Object.entries(fields)) {
      const fieldSchema = shape[key];
      if (!fieldSchema) {
        continue;
      }
      if (fieldMeta.kind === "attribute") {
        emitAttribute(key, fieldMeta, fieldSchema);
        continue;
      }
      if (fieldMeta.kind !== "element") {
        continue;
      }
      const value = obj[key];
      if (value === undefined) {
        continue;
      }
      const field = analyzeField(fieldSchema);
      const values = field.isArray ? (Array.isArray(value) ? value : [value]) : [value];
      buffered.set(
        key,
        values.map((_, i) => emitElementOccurrence(key, fieldMeta, fieldSchema, i)),
      );
    }
    documentOrderTracker.replay(
      documentOrder,
      buffered,
      // Wildcard extra (or unknown-xsi:type capture), recorded under its
      // clark key.
      (key) => obj[key] ?? xsiCapture?.extras[key],
      (xml) => elements.push(xml),
      (key, item) => {
        usesXsi =
          pushOpenChildren(elements, elementName(key, ctx.prefixMap, ctx.qnameNs), item, ctx) ||
          usesXsi;
      },
    );
    return { attributes, elements, usesXsi };
  }

  let elementOrdinal = 0;
  for (const [key, fieldMeta] of Object.entries(fields)) {
    const fieldSchema = shape[key];
    const value = obj[key];
    if (!fieldSchema) {
      continue;
    }
    if (fieldMeta.kind === "element") {
      // Extras of a wildcard sitting at this ordinal precede the field.
      for (const wildcard of anyWildcards) {
        if (wildcard.position === elementOrdinal) {
          flushWildcard(wildcard);
        }
      }
      elementOrdinal++;
    }
    if (fieldMeta.kind === "attribute") {
      emitAttribute(key, fieldMeta, fieldSchema);
      continue;
    }

    if (fieldMeta.kind === "text") {
      if (value === undefined) {
        continue;
      }
      const field = analyzeField(fieldSchema);
      const stored = lexicals?.get(key);
      const storedSingle = typeof stored === "string" ? stored : undefined;
      elements.push(serializeStoredLeaf(fieldMeta, field.itemSchema, value, storedSingle));
      continue;
    }

    if (value === undefined) {
      continue;
    }
    // Elements are always written when present in the data — even when equal
    // to their default/fixed, which are parse-time concerns only (#66).
    const field = analyzeField(fieldSchema);
    const values = field.isArray ? (Array.isArray(value) ? value : [value]) : [value];
    for (let i = 0; i < values.length; i++) {
      const emitted = emitElementOccurrence(key, fieldMeta, fieldSchema, i);
      if (emitted !== undefined) {
        elements.push(emitted);
      }
    }
  }

  // Wildcards trailing all declared element fields (or without a position,
  // e.g. hand-written schemas): their extras serialize last.
  for (const wildcard of anyWildcards) {
    flushWildcard(wildcard);
  }

  // Unknown-xsi:type capture whose recorded order does not match the value
  // (mutated data, or no order was recorded): extras append after the
  // declared content rather than being dropped.
  if (xsiCapture !== undefined) {
    for (const [clark, values] of Object.entries(xsiCapture.extras)) {
      for (const extra of values) {
        usesXsi =
          pushOpenChildren(elements, elementName(clark, ctx.prefixMap, ctx.qnameNs), extra, ctx) ||
          usesXsi;
      }
    }
  }

  return { attributes, elements, usesXsi };
};

// ---------------------------------------------------------------------------
// Public API — mirrors zod: parseXml throws, safeParseXml returns a result.
// ---------------------------------------------------------------------------

export type ParseXmlOptions = {
  // Skip the final schema validation. Fast path for input already checked by
  // the libxml2 conformance tier (xsd-to-zod/validate).
  validate?: false;
};

/**
 * Parse XML against a generated root schema. Returns the walked data validated
 * by `schema.safeParse` (validation is enforced by construction), or a failure
 * result carrying the ZodError — or the plain Error for structural problems
 * (root not found, invalid lexicals).
 */
export const safeParseXml = <S extends z.ZodType>(
  schema: S,
  xml: string,
  opts?: ParseXmlOptions,
): { success: true; data: z.output<S> } | { success: false; error: unknown } => {
  let data: unknown;
  // Choice groups are validated during the walk (registry-meta driven); the
  // validate:false fast path skips them, exactly as it skipped the refines.
  const walk: WalkCtx | undefined = opts?.validate === false ? undefined : { issues: [], path: [] };
  try {
    data = walkRoot(schema, xml, walk);
  } catch (error) {
    return { success: false, error };
  }
  if (opts?.validate === false) {
    return { success: true, data: data as z.output<S> };
  }
  const result = schema.safeParse(data);
  const choiceIssues = walk?.issues ?? [];
  if (!result.success) {
    return {
      success: false,
      error:
        choiceIssues.length > 0
          ? new z.ZodError([...result.error.issues, ...choiceIssues])
          : result.error,
    };
  }
  if (choiceIssues.length > 0) {
    return { success: false, error: new z.ZodError(choiceIssues) };
  }
  // zod rebuilt the tree during validation — re-key the retained lexicals.
  transferLexicals(data, result.data);
  const rootEntry = rootLexicals.get(schema);
  if (rootEntry !== undefined) {
    rootEntry.data = result.data;
  }
  return { success: true, data: result.data as z.output<S> };
};

/**
 * Parse XML against a generated root schema; throws ZodError on validation
 * failure (and plain Errors for structural problems). Use safeParseXml for a
 * result-object variant.
 */
export const parseXml = <S extends z.ZodType>(
  schema: S,
  xml: string,
  opts?: ParseXmlOptions,
): z.output<S> => {
  const result = safeParseXml(schema, xml, opts);
  if (!result.success) {
    throw result.error;
  }
  return result.data;
};

/** Serialize data back to XML against the same generated root schema. */
export const serializeXml = <S extends z.ZodType>(schema: S, data: z.output<S>): string => {
  const meta = findRootMeta(schema);
  if (!meta?.root) {
    throw new Error("schema is not an XML root: no root qname registered in xmlRegistry");
  }
  const rootInfo = splitClark(meta.root);
  const ctx: SerializeCtx = {
    prefixMap: new Map<string, string>(),
    qnameNs: new Map<string, string>(),
  };

  const typeSchema = peelOnce(schema);
  const xsiUnion =
    data !== null && data !== undefined && typeof data === "object" && !Array.isArray(data)
      ? xsiTypeUnionDef(typeSchema)
      : undefined;
  let body = "";
  let attributes: string[] = [];
  let usesXsi = false;
  if (data === null || data === undefined) {
    usesXsi = true;
  } else if (meta.open) {
    const inner = openSerialize(data, ctx);
    attributes = inner.attributes;
    usesXsi = inner.usesXsi;
    body = inner.body;
  } else if (xsiUnion !== undefined) {
    const { option, xsiTypeAttr } = xsiTypeVariantFor(
      xsiUnion,
      data as Record<string, unknown>,
      ctx,
    );
    // Unknown-xsi:type capture at the root: re-attach the original xsi:type.
    const typeAttr =
      xsiTypeAttr ?? xsiTypeAttrFor(xsiCaptureStore.get(data as Record<string, unknown>), ctx);
    const inner = writeObjectFields(option, data as Record<string, unknown>, ctx);
    attributes = inner.attributes;
    usesXsi = inner.usesXsi || typeAttr !== undefined;
    body = inner.elements.join("");
    if (typeAttr !== undefined) {
      attributes.push(typeAttr);
    }
  } else if (hasObjectShape(typeSchema)) {
    const inner = writeObjectFields(typeSchema, data as Record<string, unknown>, ctx);
    attributes = inner.attributes;
    usesXsi = inner.usesXsi;
    body = inner.elements.join("");
  } else if (meta.fixedLexical !== undefined) {
    // Fixed root: re-emit the declared fixed lexical (see XmlFieldMeta).
    body = escapeXml(meta.fixedLexical);
    if (meta.qnameValue) {
      body = declareQNamePrefixes(body, rootLexicals.get(schema)?.qnameNs, ctx);
    }
  } else if (meta.datatype === undefined) {
    const entry = rootLexicals.get(schema);
    const stored = storedLexicalFor(entry?.lexical, data, typeSchema);
    body = stored === undefined ? serializeLeaf(typeSchema, data) : escapeXml(stored);
    if (meta.qnameValue && stored !== undefined) {
      body = declareQNamePrefixes(body, entry?.qnameNs, ctx);
    }
  } else {
    // List-typed root: whitespace-joined canonical lexicals, one per item.
    const rootDatatype = meta.datatype;
    body = Array.isArray(data)
      ? data.map((item) => serializeDatatypeValue(rootDatatype, item)).join(" ")
      : serializeDatatypeValue(rootDatatype, data);
  }

  const nsDecls: string[] = [];
  let rootTag = rootInfo.local;
  if (rootInfo.namespace) {
    const rootPrefix = choosePrefix(rootInfo.namespace, ctx.prefixMap, ctx.qnameNs);
    rootTag = `${rootPrefix}:${rootInfo.local}`;
    nsDecls.push(`xmlns:${rootPrefix}="${rootInfo.namespace}"`);
  }
  for (const [uri, prefix] of ctx.prefixMap.entries()) {
    if (!uri || uri === rootInfo.namespace) {
      continue;
    }
    nsDecls.push(`xmlns:${prefix}="${uri}"`);
  }
  for (const [prefix, uri] of ctx.qnameNs.entries()) {
    // The xml prefix is bound by definition and must not be declared.
    if (prefix === "xml") {
      continue;
    }
    nsDecls.push(`xmlns:${prefix}="${uri}"`);
  }
  if (usesXsi) {
    nsDecls.push('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
  }

  const attrs = [...nsDecls, ...attributes].join(" ");
  if (data === null || data === undefined) {
    const nilAttrs = [...nsDecls, 'xsi:nil="true"'].join(" ");
    return `<${rootTag} ${nilAttrs}/>`;
  }
  const opening = attrs ? `<${rootTag} ${attrs}>` : `<${rootTag}>`;
  return `${opening}${body}</${rootTag}>`;
};
