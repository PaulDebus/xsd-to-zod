import XMLParser from '@nodable/flexible-xml-parser';
import { CompactBuilderFactory } from '@nodable/compact-builder';
import type { BaseOutputBuilderFactory } from '@nodable/base-output-builder';
import type { z } from 'zod';
import { xmlRegistry, type XmlFieldMeta, type XmlMeta } from './xmlMeta.js';

const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';

// Entity decoding is left to the parser; number/boolean coercion is disabled so
// that readValue sees the raw lexicals and schema-driven coercion stays the
// single coercion point for elements and attributes (#65).
// The cast works around a declaration bug in @nodable/compact-builder@2.0.0:
// its CompactBuilder.addElement(tag, matcher) is declared incompatible with
// BaseOutputBuilder.addElement(tag).
const outputBuilder = new CompactBuilderFactory({
  tags: { valueParsers: ['entity'] },
  attributes: { valueParsers: ['entity'] },
}) as unknown as BaseOutputBuilderFactory;

const parser = new XMLParser({
  skip: { attributes: false },
  attributes: { prefix: '@_' },
  // Keep CDATA under its own key: merged text passes through the entity value
  // parser, which would corrupt literal entity text inside CDATA sections (#64).
  nameFor: { cdata: '#cdata' },
  OutputBuilder: outputBuilder
});

const toArray = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

// Text content of a parsed node: character data plus verbatim CDATA sections.
// Interleaved order between text and CDATA is not preserved (mixed content is
// unsupported); the common cases (text-only, CDATA-only) are exact.
const textOf = (node: Record<string, unknown>): unknown => {
  const text = node['#text'];
  const cdata = node['#cdata'];
  if (cdata === undefined) {
    return text;
  }
  const cdataText = Array.isArray(cdata) ? cdata.join('') : String(cdata);
  return `${text === undefined ? '' : String(text)}${cdataText}`;
};

const splitClark = (qname: string): { namespace: string; local: string } => {
  if (!qname.startsWith('{')) {
    return { namespace: '', local: qname };
  }
  const boundary = qname.indexOf('}');
  if (boundary === -1) {
    return { namespace: '', local: qname };
  }
  return { namespace: qname.slice(1, boundary), local: qname.slice(boundary + 1) };
};

const splitXmlName = (name: string): { prefix: string; local: string } => {
  const idx = name.indexOf(':');
  return idx === -1 ? { prefix: '', local: name } : { prefix: name.slice(0, idx), local: name.slice(idx + 1) };
};

const collectNamespaceDeclarations = (node: Record<string, unknown>): Record<string, string> => {
  const namespaces: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '@_xmlns') {
      namespaces[''] = String(value);
      continue;
    }
    if (!key.startsWith('@_xmlns:')) {
      continue;
    }
    namespaces[key.slice('@_xmlns:'.length)] = String(value);
  }
  return namespaces;
};

const withNamespaceContext = (
  baseContext: Record<string, string>,
  node: Record<string, unknown>
): Record<string, string> => ({
  ...baseContext,
  ...collectNamespaceDeclarations(node)
});

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

export const decodeXmlEntities = (xml: string): string =>
  xml
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
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
          String.fromCodePoint(dec !== undefined ? Number(dec) : parseInt(hex!, 16))));
      return decoded + (cdataBlocks[i] ?? '');
    })
    .join('');
};

// ---------------------------------------------------------------------------
// zod def walking — the single place that touches zod internals. All wrapper
// unwrapping and def narrowing lives here, so a zod upgrade means one module
// to review, not a codebase to grep.
// ---------------------------------------------------------------------------

type AnyDef = z.core.$ZodTypeDef;
type AnySchema = z.core.$ZodType;

const defAs = <T extends AnyDef>(def: AnyDef, type: T['type']): T | undefined =>
  def.type === type ? (def as T) : undefined;

// Peel exactly one wrapper level (lazy/optional/nullable/default/readonly);
// returns the input unchanged when it is not a wrapper.
const peelOnce = (schema: AnySchema): AnySchema => {
  const def = schema._zod.def;
  const lazy = defAs<z.core.$ZodLazyDef>(def, 'lazy');
  if (lazy) {
    return lazy.getter();
  }
  const wrapper =
    defAs<z.core.$ZodOptionalDef>(def, 'optional') ??
    defAs<z.core.$ZodNullableDef>(def, 'nullable') ??
    defAs<z.core.$ZodDefaultDef>(def, 'default') ??
    defAs<z.core.$ZodReadonlyDef>(def, 'readonly');
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
  defAs<z.core.$ZodObjectDef>(unwrapModifiers(schema)._zod.def, 'object');

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
    const optional = defAs<z.core.$ZodOptionalDef>(def, 'optional');
    if (optional) {
      current = optional.innerType;
      continue;
    }
    const nullable = defAs<z.core.$ZodNullableDef>(def, 'nullable');
    if (nullable) {
      current = nullable.innerType;
      continue;
    }
    const readonly = defAs<z.core.$ZodReadonlyDef>(def, 'readonly');
    if (readonly) {
      current = readonly.innerType;
      continue;
    }
    const array = defAs<z.core.$ZodArrayDef>(def, 'array');
    if (array) {
      isArray = true;
      current = array.element;
      continue;
    }
    const dfault = defAs<z.core.$ZodDefaultDef>(def, 'default');
    if (dfault) {
      hasDefault = true;
      defaultValue = dfault.defaultValue;
      current = dfault.innerType;
      continue;
    }
    const literal = defAs<z.core.$ZodLiteralDef<z.core.util.Literal>>(def, 'literal');
    if (literal) {
      hasFixed = true;
      fixedValue = literal.values[0];
    }
    return { itemSchema: current, isArray, hasDefault, defaultValue, hasFixed, fixedValue };
  }
};

// ---------------------------------------------------------------------------
// Schema-driven lexical coercion — the single coercion point. The schema's own
// def decides the conversion; there are no metadata typeNames anymore.
// ---------------------------------------------------------------------------

const BOOLEAN_LEXICALS = new Set(['true', 'false', '0', '1']);
const INTEGER_LEXICAL = /^[+-]?\d+$/;
const FLOAT_LEXICAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const INT_FORMATS = new Set(['safeint', 'int32', 'uint32', 'int64', 'uint64']);

const isIntChecked = (def: z.core.$ZodNumberDef): boolean =>
  (def.checks ?? []).some((check) => {
    const checkDef = check._zod.def as { check?: string; format?: string };
    return checkDef.check === 'number_format' && INT_FORMATS.has(checkDef.format ?? '');
  });

const coerceNumberValue = (trimmed: string): number => {
  // The XSD float/double specials are valid lexicals, but zod's z.number()
  // rejects non-finite numbers at the base-type level — accepting them in the
  // walker would make the mandatory validation reject what the walker
  // produced. Reject coherently instead; the libxml2 tier is the place for
  // full float/double semantics (and zod cannot express them regardless).
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
  return trimmed === 'true' || trimmed === '1';
};

const coerceList = (raw: unknown, itemSchema: AnySchema): unknown[] =>
  String(raw).trim().split(/\s+/).filter(Boolean).map((item) => coerceLexical(item, itemSchema));

const coerceLexical = (raw: unknown, schema: AnySchema): unknown => {
  if (raw === undefined || raw === null) {
    return raw;
  }
  const def = unwrapModifiers(schema)._zod.def;
  switch (def.type) {
    case 'number':
      return coerceNumber(String(raw), def as z.core.$ZodNumberDef);
    case 'boolean':
      return coerceBoolean(String(raw));
    case 'string':
      return String(raw);
    case 'literal': {
      const value = (def as z.core.$ZodLiteralDef<z.core.util.Literal>).values[0];
      if (typeof value === 'number') {
        return coerceNumberValue(String(raw).trim());
      }
      if (typeof value === 'boolean') {
        return coerceBoolean(String(raw));
      }
      return String(raw);
    }
    case 'enum':
      return String(raw);
    case 'union': {
      for (const option of (def as z.core.$ZodUnionDef).options) {
        try {
          const result = coerceLexical(raw, option);
          if (typeof result === 'number' && Number.isNaN(result)) {
            continue;
          }
          return result;
        } catch {
          continue;
        }
      }
      return String(raw);
    }
    case 'pipe': {
      const pipe = def as z.core.$ZodPipeDef;
      const outDef = pipe.out._zod.def;
      if (outDef.type === 'array') {
        // XSD list: whitespace-separated lexicals, coerced per item.
        return coerceList(raw, (outDef as z.core.$ZodArrayDef).element);
      }
      // Other pipes (e.g. a whiteSpace preprocess) coerce as their inner type.
      return coerceLexical(raw, pipe.out);
    }
    case 'array':
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
  namespaceContext: Record<string, string>
): unknown => {
  const expected = splitClark(qname);
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith('@_')) {
      continue;
    }
    const { prefix, local } = splitXmlName(key.slice(2));
    const namespace = prefix ? (namespaceContext[prefix] ?? '') : '';
    if (local === expected.local && namespace === expected.namespace) {
      return value;
    }
  }
  return undefined;
};

const findElementValues = (
  node: Record<string, unknown>,
  qname: string,
  namespaceContext: Record<string, string>
): unknown[] => {
  const expected = splitClark(qname);
  const matches: unknown[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') || key === '#text' || key === '#cdata') {
      continue;
    }
    const { prefix, local } = splitXmlName(key);
    if (local !== expected.local) {
      continue;
    }
    // Match per item, with each item's own xmlns context — repeated elements
    // may redeclare namespaces per sibling (#67).
    for (const item of toArray(value)) {
      const itemNode = item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : undefined;
      const itemContext = itemNode ? withNamespaceContext(namespaceContext, itemNode) : namespaceContext;
      const namespace = prefix ? (itemContext[prefix] ?? '') : (itemContext[''] ?? '');
      if (namespace === expected.namespace) {
        matches.push(item);
        continue;
      }
      // Unqualified local elements (elementFormDefault="unqualified") belong to
      // no namespace, yet real-world documents put them in the inherited
      // default namespace. Accommodate them: a field in no namespace also
      // matches unprefixed elements (lenient by design; the libxml2 tier is
      // the strict one).
      if (expected.namespace === '' && !prefix) {
        matches.push(item);
      }
    }
  }
  return matches;
};

const extractRoot = (
  parsed: Record<string, unknown>,
  expectedQName: string
): { root: Record<string, unknown>; namespaceContext: Record<string, string> } => {
  const expected = splitClark(expectedQName);
  const entry = Object.entries(parsed).find(([key, value]) => {
    const node = value && typeof value === 'object' ? (Array.isArray(value) ? value[0] : value) as Record<string, unknown> : {};
    const namespaceContext = withNamespaceContext({}, node);
    const { prefix, local } = splitXmlName(key);
    const namespace = prefix ? (namespaceContext[prefix] ?? '') : (namespaceContext[''] ?? '');
    return local === expected.local && namespace === expected.namespace;
  });
  if (!entry) {
    throw new Error(`Root element '${expectedQName}' not found in XML payload`);
  }
  if (Array.isArray(entry[1])) {
    // A repeated root tag parses to an array — treating its first item as the
    // root would silently drop siblings (#67).
    throw new Error(`XML payload contains ${entry[1].length} '${expectedQName}' root elements; expected exactly one`);
  }
  if (entry[1] && typeof entry[1] === 'object') {
    const root = entry[1] as Record<string, unknown>;
    return { root, namespaceContext: withNamespaceContext({}, root) };
  }
  return { root: { '#text': entry[1] }, namespaceContext: {} };
};

// ---------------------------------------------------------------------------
// Reading: XML nodes → data, driven by the schema + registry
// ---------------------------------------------------------------------------

const readObject = (
  schema: AnySchema,
  node: Record<string, unknown>,
  namespaceContext: Record<string, string>
): Record<string, unknown> => {
  const fields = findFieldsMeta(schema) ?? {};
  const shape = objectDefOf(schema)?.shape ?? {};
  const result: Record<string, unknown> = {};
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
  return result;
};

const readOccurrence = (
  field: FieldAnalysis,
  fieldMeta: XmlFieldMeta,
  entry: unknown,
  namespaceContext: Record<string, string>
): unknown => {
  if (entry !== null && typeof entry === 'object') {
    const childNode = entry as Record<string, unknown>;
    const childContext = withNamespaceContext(namespaceContext, childNode);
    const nilValue = findAttributeValue(childNode, `{${XSI_NS}}nil`, childContext);
    if (nilValue === 'true' || nilValue === '1') {
      return null;
    }
    if (hasObjectShape(field.itemSchema)) {
      return readObject(field.itemSchema, childNode, childContext);
    }
    const text = textOf(childNode);
    if (text === undefined || text === '') {
      // Present-but-empty element: XSD applies default/fixed here (#66).
      if (field.hasFixed) return field.fixedValue;
      if (fieldMeta.defaultValue !== undefined) return fieldMeta.defaultValue;
    }
    return coerceLexical(text, field.itemSchema);
  }

  // Scalar entry: the parser yields text-only elements as bare strings.
  if (entry === '') {
    if (field.hasFixed) return field.fixedValue;
    if (fieldMeta.defaultValue !== undefined) return fieldMeta.defaultValue;
  }
  if (hasObjectShape(field.itemSchema)) {
    return readObject(field.itemSchema, { '#text': entry }, namespaceContext);
  }
  return coerceLexical(entry, field.itemSchema);
};

type FieldRead = { present: boolean; value: unknown };

const readField = (
  fieldMeta: XmlFieldMeta,
  fieldSchema: AnySchema,
  node: Record<string, unknown>,
  namespaceContext: Record<string, string>
): FieldRead => {
  const field = analyzeField(fieldSchema);

  if (fieldMeta.kind === 'attribute') {
    const raw = findAttributeValue(node, fieldMeta.qname, namespaceContext);
    if (raw === undefined) {
      // Absent attribute: XSD applies default/fixed on absence. Validation
      // normally fills these via zod (.default()/z.literal); on the
      // validate:false fast path the walker supplies them from the def.
      if (field.hasFixed) return { present: true, value: field.fixedValue };
      if (field.hasDefault) return { present: true, value: field.defaultValue };
      return { present: false, value: undefined };
    }
    return { present: true, value: coerceLexical(raw, field.itemSchema) };
  }

  if (fieldMeta.kind === 'text') {
    const text = textOf(node);
    if (text === undefined) {
      return { present: false, value: undefined };
    }
    return { present: true, value: coerceLexical(text, field.itemSchema) };
  }

  const values = findElementValues(node, fieldMeta.qname, namespaceContext).map((entry) =>
    readOccurrence(field, fieldMeta, entry, namespaceContext)
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
    throw new Error('schema is not an XML root: no root qname registered in xmlRegistry');
  }
  const parsed = parser.parse(decodeTagNameCharRefs(xml)) as Record<string, unknown>;
  const { root: rootNode, namespaceContext } = extractRoot(parsed, meta.root);

  const nilValue = findAttributeValue(rootNode, `{${XSI_NS}}nil`, namespaceContext);
  if (nilValue === 'true' || nilValue === '1') {
    return null;
  }

  const typeSchema = peelOnce(schema);
  if (hasObjectShape(typeSchema)) {
    return readObject(typeSchema, rootNode, namespaceContext);
  }
  // Simple-typed root element: the document value is the root's text content.
  return coerceLexical(textOf(rootNode), typeSchema);
};

// ---------------------------------------------------------------------------
// Writing: data → XML, driven by the schema + registry
// ---------------------------------------------------------------------------

const choosePrefix = (uri: string, prefixMap: Map<string, string>): string => {
  if (prefixMap.has(uri)) {
    return prefixMap.get(uri)!;
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

const serializePrimitive = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return escapeXml(String(value));
};

const serializeListValue = (value: unknown): string => {
  const arr = Array.isArray(value) ? value : [value];
  return arr.map(item => serializePrimitive(item)).join(' ');
};

const serializeLeaf = (schema: AnySchema, value: unknown): string => {
  const def = unwrapModifiers(schema)._zod.def;
  if (def.type === 'pipe') {
    const outDef = (def as z.core.$ZodPipeDef).out._zod.def;
    if (outDef.type === 'array') {
      return serializeListValue(value);
    }
  }
  if (def.type === 'array') {
    return serializeListValue(value);
  }
  return serializePrimitive(value);
};

const writeObjectFields = (
  schema: AnySchema,
  obj: Record<string, unknown>,
  ctx: SerializeCtx
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

    if (fieldMeta.kind === 'attribute') {
      if (value === undefined) {
        continue;
      }
      // XSD: an attribute equal to its default need not be written.
      if (field.hasDefault && value === field.defaultValue) {
        continue;
      }
      attributes.push(`${elementName(fieldMeta.qname, ctx.prefixMap)}="${serializeLeaf(field.itemSchema, value)}"`);
      continue;
    }

    if (fieldMeta.kind === 'text') {
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
      if (hasObjectShape(field.itemSchema) && typeof item === 'object' && !Array.isArray(item)) {
        const inner = writeObjectFields(field.itemSchema, item as Record<string, unknown>, ctx);
        usesXsi = usesXsi || inner.usesXsi;
        const attrStr = inner.attributes.length > 0 ? ` ${inner.attributes.join(' ')}` : '';
        elements.push(`<${localName}${attrStr}>${inner.elements.join('')}</${localName}>`);
        continue;
      }
      elements.push(`<${localName}>${serializeLeaf(field.itemSchema, item)}</${localName}>`);
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
  opts?: ParseXmlOptions
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
export const parseXml = <S extends z.ZodType>(schema: S, xml: string, opts?: ParseXmlOptions): z.output<S> => {
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
    throw new Error('schema is not an XML root: no root qname registered in xmlRegistry');
  }
  const rootInfo = splitClark(meta.root);
  const ctx: SerializeCtx = {
    prefixMap: new Map<string, string>(),
  };

  const typeSchema = peelOnce(schema);
  let body = '';
  let attributes: string[] = [];
  let usesXsi = false;
  if (data === null || data === undefined) {
    usesXsi = true;
  } else if (hasObjectShape(typeSchema)) {
    const inner = writeObjectFields(typeSchema, data as Record<string, unknown>, ctx);
    attributes = inner.attributes;
    usesXsi = inner.usesXsi;
    body = inner.elements.join('');
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

  const attrs = [...nsDecls, ...attributes].join(' ');
  if (data === null || data === undefined) {
    const nilAttrs = [...nsDecls, 'xsi:nil="true"'].join(' ');
    return `<${rootTag} ${nilAttrs}/>`;
  }
  const opening = attrs ? `<${rootTag} ${attrs}>` : `<${rootTag}>`;
  return `${opening}${body}</${rootTag}>`;
};
