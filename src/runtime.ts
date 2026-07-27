import { type BaseOutputBuilder, BaseOutputBuilderFactory } from "@nodable/base-output-builder";
import { CompactBuilderFactory } from "@nodable/compact-builder";
import XMLParser from "@nodable/flexible-xml-parser";
import type { z } from "zod";
import { splitClark, splitQName } from "./qname.js";
import { type XmlFieldMeta, type XmlMeta, xmlRegistry } from "./xmlMeta.js";

const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";

type GetInstanceArgs = Parameters<BaseOutputBuilderFactory["getInstance"]>;
type RegisterArgs = Parameters<BaseOutputBuilderFactory["registerValueParser"]>;

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
    attributes: { valueParsers: ["entity"] },
  });

  override getInstance(...args: GetInstanceArgs): BaseOutputBuilder {
    return this.inner.getInstance(...args) as BaseOutputBuilder;
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
// Interleaved order between text and CDATA is not preserved (mixed content is
// unsupported); the common cases (text-only, CDATA-only) are exact.
const textOf = (node: Record<string, unknown>): unknown => {
  const text = node["#text"];
  const cdata = node["#cdata"];
  if (cdata === undefined) {
    return text;
  }
  const cdataText = Array.isArray(cdata) ? cdata.join("") : String(cdata);
  return `${text === undefined ? "" : String(text)}${cdataText}`;
};

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
  ...baseContext,
  ...collectNamespaceDeclarations(node),
});

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

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
// zod def walking — the single place that touches zod internals. All wrapper
// unwrapping and def narrowing lives here, so a zod upgrade means one module
// to review, not a codebase to grep.
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

// Walk the wrapper chain until a schema carries registry meta with a `root`
// qname — root exports register it on their outermost wrapper.
const findRootMeta = (schema: AnySchema): XmlMeta | undefined => {
  let current = schema;
  for (;;) {
    const meta = xmlRegistry.get(current);
    if (meta?.root) {
      return meta;
    }
    const next = peelOnce(current);
    if (next === current) {
      return undefined;
    }
    current = next;
  }
};

// Walk the wrapper chain until a schema carries registry meta with a `fields`
// map — type schemas register it on the lazy wrapper, which may sit below a
// root export wrapper or array/optional cardinality wrappers.
const findFieldsMeta = (schema: AnySchema): Record<string, XmlFieldMeta> | undefined => {
  let current = schema;
  for (;;) {
    const meta = xmlRegistry.get(current);
    if (meta?.fields) {
      return meta.fields;
    }
    const next = peelOnce(current);
    if (next === current) {
      return undefined;
    }
    current = next;
  }
};

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
    const optional = defAs<z.core.$ZodOptionalDef>(def, "optional");
    if (optional) {
      current = optional.innerType;
      continue;
    }
    const nullable = defAs<z.core.$ZodNullableDef>(def, "nullable");
    if (nullable) {
      current = nullable.innerType;
      continue;
    }
    const readonly = defAs<z.core.$ZodReadonlyDef>(def, "readonly");
    if (readonly) {
      current = readonly.innerType;
      continue;
    }
    const array = defAs<z.core.$ZodArrayDef>(def, "array");
    if (array) {
      isArray = true;
      current = array.element;
      continue;
    }
    const dfault = defAs<z.core.$ZodDefaultDef>(def, "default");
    if (dfault) {
      hasDefault = true;
      defaultValue = dfault.defaultValue;
      current = dfault.innerType;
      continue;
    }
    const literal = defAs<z.core.$ZodLiteralDef<z.core.util.Literal>>(def, "literal");
    if (literal) {
      hasFixed = true;
      fixedValue = literal.values[0];
    }
    return {
      itemSchema: current,
      isArray,
      hasDefault,
      defaultValue,
      hasFixed,
      fixedValue,
    };
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

const coerceLexical = (raw: unknown, schema: AnySchema): unknown => {
  if (raw === undefined || raw === null) {
    return raw;
  }
  const def = unwrapModifiers(schema)._zod.def;
  switch (def.type) {
    case "number":
      return coerceNumber(String(raw), def as z.core.$ZodNumberDef);
    case "boolean":
      return coerceBoolean(String(raw));
    case "string":
      return String(raw);
    case "literal": {
      const value = (def as z.core.$ZodLiteralDef<z.core.util.Literal>).values[0];
      if (typeof value === "number") {
        return coerceNumberValue(String(raw).trim());
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
    const namespace = prefix ? (namespaceContext[prefix] ?? "") : "";
    if (local === expected.local && namespace === expected.namespace) {
      return value;
    }
  }
  return undefined;
};

const findElementValues = (
  node: Record<string, unknown>,
  qname: string,
  namespaceContext: Record<string, string>,
): unknown[] => {
  const expected = splitClark(qname);
  const matches: unknown[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_") || key === "#text" || key === "#cdata") {
      continue;
    }
    const { prefix, local } = splitQName(key);
    if (local !== expected.local) {
      continue;
    }
    // Match per item, with each item's own xmlns context — repeated elements
    // may redeclare namespaces per sibling (#67).
    for (const item of toArray(value)) {
      const itemNode =
        item !== null && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
      const itemContext = itemNode
        ? withNamespaceContext(namespaceContext, itemNode)
        : namespaceContext;
      const namespace = prefix ? (itemContext[prefix] ?? "") : (itemContext[""] ?? "");
      if (namespace === expected.namespace) {
        matches.push(item);
        continue;
      }
      // Unqualified local elements (elementFormDefault="unqualified") belong to
      // no namespace, yet real-world documents put them in the inherited
      // default namespace. Accommodate them: a field in no namespace also
      // matches unprefixed elements (lenient by design; the libxml2 tier is
      // the strict one).
      if (expected.namespace === "" && !prefix) {
        matches.push(item);
      }
    }
  }
  return matches;
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
    const namespace = prefix ? (namespaceContext[prefix] ?? "") : (namespaceContext[""] ?? "");
    return local === expected.local && namespace === expected.namespace;
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
): Record<string, unknown> => {
  const fields = findFieldsMeta(schema) ?? {};
  const shape = objectDefOf(schema)?.shape ?? {};
  // Null prototype: an XSD element named __proto__ must become an own property,
  // not a silent prototype mutation (#84).
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, fieldMeta] of Object.entries(fields)) {
    const fieldSchema = shape[key];
    if (!fieldSchema) {
      continue;
    }
    const { present, value } = readField(fieldMeta, fieldSchema, node, namespaceContext);
    if (present) {
      result[key] = value;
    }
  }
  const fieldList = Object.values(fields);
  const hasAny = fieldList.some((f) => f.kind === "any");
  const hasAnyAttribute = fieldList.some((f) => f.kind === "anyAttribute");
  if (hasAny || hasAnyAttribute) {
    sweepWildcards(result, node, fieldList, namespaceContext, {
      any: hasAny,
      anyAttribute: hasAnyAttribute,
    });
  }
  return result;
};

// xs:any / xs:anyAttribute (lax tier): unmatched child elements/attributes are
// captured in the normalized open shape (see openWalk). Namespace constraints
// and processContents are deliberately unenforced — the libxml2 tier is the
// conformance authority.
const sweepWildcards = (
  result: Record<string, unknown>,
  node: Record<string, unknown>,
  fieldList: XmlFieldMeta[],
  namespaceContext: Record<string, string>,
  wildcards: { any: boolean; anyAttribute: boolean },
): void => {
  const knownElements = new Set(fieldList.filter((f) => f.kind === "element").map((f) => f.qname));
  const knownAttributes = new Set(
    fieldList.filter((f) => f.kind === "attribute").map((f) => f.qname),
  );
  const context = withNamespaceContext(namespaceContext, node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "#text" || key === "#cdata" || key === "@_xmlns" || key.startsWith("@_xmlns:")) {
      continue;
    }
    if (key.startsWith("@_")) {
      if (!wildcards.anyAttribute) {
        continue;
      }
      const { prefix, local } = splitQName(key.slice(2));
      const namespace = prefix ? (context[prefix] ?? "") : "";
      // xsi:* directives are processor metadata, not content (see openWalk).
      if (namespace === XSI_NS || knownAttributes.has(`{${namespace}}${local}`)) {
        continue;
      }
      result[`@${namespace ? `{${namespace}}` : ""}${local}`] =
        value === undefined ? value : String(value);
      continue;
    }
    if (!wildcards.any) {
      continue;
    }
    const { prefix, local } = splitQName(key);
    for (const item of toArray(value)) {
      const itemNode =
        item !== null && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
      const itemContext = itemNode ? withNamespaceContext(context, itemNode) : context;
      const namespace = prefix ? (itemContext[prefix] ?? "") : (itemContext[""] ?? "");
      // Unqualified fields also match unprefixed elements in the inherited
      // default namespace (same leniency as findElementValues) — not extras.
      if (
        knownElements.has(`{${namespace}}${local}`) ||
        (knownElements.has(`{}${local}`) && !prefix)
      ) {
        continue;
      }
      const childKey = `{${namespace}}${local}`;
      const childValue = itemNode ? openWalk(itemNode, context) : item;
      const existing = result[childKey];
      if (existing === undefined) {
        result[childKey] = childValue;
      } else if (Array.isArray(existing)) {
        existing.push(childValue);
      } else {
        result[childKey] = [existing, childValue];
      }
    }
  }
};

// Present-but-empty element: XSD applies default/fixed here (#66).
const substituteEmpty = (
  field: FieldAnalysis,
  fieldMeta: XmlFieldMeta,
): { substituted: boolean; value?: unknown } => {
  if (field.hasFixed) {
    return { substituted: true, value: field.fixedValue };
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
): unknown => {
  if (entry !== null && typeof entry === "object") {
    const childNode = entry as Record<string, unknown>;
    const childContext = withNamespaceContext(namespaceContext, childNode);
    const nilValue = findAttributeValue(childNode, `{${XSI_NS}}nil`, childContext);
    if (nilValue === "true" || nilValue === "1") {
      return null;
    }
    if (fieldMeta.open) {
      // Element default/fixed applies to present-but-empty open fields too.
      const text = textOf(childNode);
      if (text === undefined || text === "") {
        const empty = substituteEmpty(field, fieldMeta);
        if (empty.substituted) {
          return empty.value;
        }
      }
      return openWalk(childNode, childContext);
    }
    if (hasObjectShape(field.itemSchema)) {
      return readObject(field.itemSchema, childNode, childContext);
    }
    const text = textOf(childNode);
    if (text === undefined || text === "") {
      const empty = substituteEmpty(field, fieldMeta);
      if (empty.substituted) {
        return empty.value;
      }
    }
    return coerceLexical(text, field.itemSchema);
  }

  // Scalar entry: the parser yields text-only elements as bare strings.
  if (entry === "") {
    const empty = substituteEmpty(field, fieldMeta);
    if (empty.substituted) {
      return empty.value;
    }
  }
  if (fieldMeta.open) {
    return entry;
  }
  if (hasObjectShape(field.itemSchema)) {
    return readObject(field.itemSchema, { "#text": entry }, namespaceContext);
  }
  return coerceLexical(entry, field.itemSchema);
};

type FieldRead = { present: boolean; value: unknown };

const readField = (
  fieldMeta: XmlFieldMeta,
  fieldSchema: AnySchema,
  node: Record<string, unknown>,
  namespaceContext: Record<string, string>,
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
      if (field.hasDefault) {
        return { present: true, value: field.defaultValue };
      }
      return { present: false, value: undefined };
    }
    return { present: true, value: coerceLexical(raw, field.itemSchema) };
  }

  if (fieldMeta.kind === "text") {
    const text = textOf(node);
    // A present element without character data has empty-string content: valid
    // for string-allowing types, and numeric coercion of '' still rejects.
    return {
      present: true,
      value: coerceLexical(text ?? "", field.itemSchema),
    };
  }

  const values = findElementValues(node, fieldMeta.qname, namespaceContext).map((entry) =>
    readOccurrence(field, fieldMeta, entry, namespaceContext),
  );
  if (field.isArray) {
    return { present: true, value: values };
  }
  if (values.length > 0) {
    return { present: true, value: values[0] };
  }
  // Absent element: no default/fixed substitution — XSD applies those to
  // present-but-empty elements, not absent ones (#66).
  return { present: false, value: undefined };
};

const walkRoot = (schema: AnySchema, xml: string): unknown => {
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
  if (hasObjectShape(typeSchema)) {
    return readObject(typeSchema, rootNode, namespaceContext);
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
  return coerceLexical(text, typeSchema);
};

// Open content (xs:anyType, wildcards): schema-less walk into the normalized
// open shape — clark-keyed child elements, '@'-prefixed attribute keys,
// '_text' for character data next to attributes/children. A leaf element
// collapses to its text string.
const openWalk = (
  node: Record<string, unknown>,
  namespaceContext: Record<string, string>,
): unknown => {
  const context = withNamespaceContext(namespaceContext, node);
  const out: Record<string, unknown> = {};
  let hasStructure = false;
  for (const [key, value] of Object.entries(node)) {
    if (key === "#text" || key === "#cdata" || key === "@_xmlns" || key.startsWith("@_xmlns:")) {
      continue;
    }
    if (key.startsWith("@_")) {
      const { prefix, local } = splitQName(key.slice(2));
      const namespace = prefix ? (context[prefix] ?? "") : "";
      // xsi:* attributes are processor directives (nil/type/schemaLocation),
      // not content; the typed walker drops them too, and their QName values
      // could not be re-serialized without declaring the value's prefix.
      if (namespace === XSI_NS) {
        continue;
      }
      out[`@${namespace ? `{${namespace}}` : ""}${local}`] =
        value === undefined ? value : String(value);
      hasStructure = true;
      continue;
    }
    const { prefix, local } = splitQName(key);
    for (const item of toArray(value)) {
      hasStructure = true;
      // Namespace per item — repeated siblings may redeclare prefixes (#67).
      const itemNode =
        item !== null && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
      const itemContext = itemNode ? withNamespaceContext(context, itemNode) : context;
      const namespace = prefix ? (itemContext[prefix] ?? "") : (itemContext[""] ?? "");
      const childKey = `{${namespace}}${local}`;
      const childValue = itemNode ? openWalk(itemNode, context) : item;
      const existing = out[childKey];
      if (existing === undefined) {
        out[childKey] = childValue;
      } else if (Array.isArray(existing)) {
        existing.push(childValue);
      } else {
        out[childKey] = [existing, childValue];
      }
    }
  }
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

const choosePrefix = (uri: string, prefixMap: Map<string, string>): string => {
  if (prefixMap.has(uri)) {
    const existing = prefixMap.get(uri);
    if (existing) {
      return existing;
    }
  }
  const next = `ns${prefixMap.size}`;
  prefixMap.set(uri, next);
  return next;
};

const elementName = (qname: string, prefixMap: Map<string, string>): string => {
  const { namespace, local } = splitClark(qname);
  if (!namespace) {
    return local;
  }
  return `${choosePrefix(namespace, prefixMap)}:${local}`;
};

type SerializeCtx = {
  prefixMap: Map<string, string>;
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
      attributes.push(`${elementName(key.slice(1), ctx.prefixMap)}="${serializePrimitive(entry)}"`);
      continue;
    }
    const tag = elementName(key, ctx.prefixMap);
    for (const item of Array.isArray(entry) ? entry : [entry]) {
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
  }
  return { attributes, body: elements.join(""), usesXsi };
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

  for (const [key, fieldMeta] of Object.entries(fields)) {
    const fieldSchema = shape[key];
    const value = obj[key];
    if (!fieldSchema) {
      continue;
    }
    const field = analyzeField(fieldSchema);

    if (fieldMeta.kind === "attribute") {
      if (value === undefined) {
        continue;
      }
      // XSD: an attribute equal to its default need not be written.
      if (field.hasDefault && value === field.defaultValue) {
        continue;
      }
      attributes.push(
        `${elementName(fieldMeta.qname, ctx.prefixMap)}="${serializeLeaf(field.itemSchema, value)}"`,
      );
      continue;
    }

    if (fieldMeta.kind === "text") {
      elements.push(serializeLeaf(field.itemSchema, value));
      continue;
    }

    if (value === undefined) {
      continue;
    }
    // Elements are always written when present in the data — even when equal
    // to their default/fixed, which are parse-time concerns only (#66).
    const localName = elementName(fieldMeta.qname, ctx.prefixMap);
    const values = field.isArray ? (Array.isArray(value) ? value : [value]) : [value];
    for (const item of values) {
      if (item === undefined) {
        continue;
      }
      if (item === null) {
        usesXsi = true;
        elements.push(`<${localName} xsi:nil="true"/>`);
        continue;
      }
      if (fieldMeta.open) {
        const inner = openSerialize(item, ctx);
        usesXsi = usesXsi || inner.usesXsi;
        const attrStr = inner.attributes.length > 0 ? ` ${inner.attributes.join(" ")}` : "";
        elements.push(`<${localName}${attrStr}>${inner.body}</${localName}>`);
        continue;
      }
      if (hasObjectShape(field.itemSchema) && typeof item === "object" && !Array.isArray(item)) {
        const inner = writeObjectFields(field.itemSchema, item as Record<string, unknown>, ctx);
        usesXsi = usesXsi || inner.usesXsi;
        const attrStr = inner.attributes.length > 0 ? ` ${inner.attributes.join(" ")}` : "";
        elements.push(`<${localName}${attrStr}>${inner.elements.join("")}</${localName}>`);
        continue;
      }
      elements.push(`<${localName}>${serializeLeaf(field.itemSchema, item)}</${localName}>`);
    }
  }

  // Wildcard extras: data keys captured by the wildcard sweep that no declared
  // field owns. Written after the declared fields (see sweepWildcards).
  const fieldList = Object.values(fields);
  const hasAny = fieldList.some((f) => f.kind === "any");
  const hasAnyAttribute = fieldList.some((f) => f.kind === "anyAttribute");
  if (hasAny || hasAnyAttribute) {
    for (const [key, value] of Object.entries(obj)) {
      if (key in fields || value === undefined) {
        continue;
      }
      if (key.startsWith("@")) {
        if (hasAnyAttribute) {
          attributes.push(
            `${elementName(key.slice(1), ctx.prefixMap)}="${serializePrimitive(value)}"`,
          );
        }
        continue;
      }
      if (!hasAny) {
        continue;
      }
      const tag = elementName(key, ctx.prefixMap);
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
  try {
    data = walkRoot(schema, xml);
  } catch (error) {
    return { success: false, error };
  }
  if (opts?.validate === false) {
    return { success: true, data: data as z.output<S> };
  }
  const result = schema.safeParse(data);
  return result.success
    ? { success: true, data: result.data as z.output<S> }
    : { success: false, error: result.error };
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
  };

  const typeSchema = peelOnce(schema);
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
  } else if (hasObjectShape(typeSchema)) {
    const inner = writeObjectFields(typeSchema, data as Record<string, unknown>, ctx);
    attributes = inner.attributes;
    usesXsi = inner.usesXsi;
    body = inner.elements.join("");
  } else {
    body = serializeLeaf(typeSchema, data);
  }

  const nsDecls: string[] = [];
  let rootTag = rootInfo.local;
  if (rootInfo.namespace) {
    const rootPrefix = choosePrefix(rootInfo.namespace, ctx.prefixMap);
    rootTag = `${rootPrefix}:${rootInfo.local}`;
    nsDecls.push(`xmlns:${rootPrefix}="${rootInfo.namespace}"`);
  }
  for (const [uri, prefix] of ctx.prefixMap.entries()) {
    if (!uri || uri === rootInfo.namespace) {
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
