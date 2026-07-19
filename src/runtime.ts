import XMLParser from '@nodable/flexible-xml-parser';
import { CompactBuilderFactory } from '@nodable/compact-builder';
import type { BaseOutputBuilderFactory } from '@nodable/base-output-builder';
import type { Facet, RuntimeFieldMetadata, RuntimeRootMetadata, RuntimeTypeMetadata } from './types.js';
import { XSD_INTEGER_TYPE_NAMES } from './xsdBuiltins.js';

const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
const XSD_NS = 'http://www.w3.org/2001/XMLSchema';

// Entity decoding is left to the parser; number/boolean coercion is disabled so
// that readValue sees the raw lexicals and parsePrimitive stays the single
// coercion point for elements and attributes (#65).
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

const validateFacets = (value: unknown, facets: Facet[], typeName: string): void => {
  const enumValues = facets.filter(f => f.kind === 'enumeration').map(f => f.value);
  if (enumValues.length > 0 && !enumValues.includes(String(value))) {
    throw new Error(`Value ${JSON.stringify(value)} is not one of the allowed values for ${typeName}`);
  }

  for (const facet of facets) {
    switch (facet.kind) {
      case 'pattern': {
        if (typeof value !== 'string' || !new RegExp(facet.value).test(value)) {
          throw new Error(`Value ${JSON.stringify(value)} does not match pattern ${facet.value} for ${typeName}`);
        }
        break;
      }
      case 'length':
        if (typeof value === 'string' && value.length !== facet.value) {
          throw new Error(`Value ${JSON.stringify(value)} length is not ${facet.value} for ${typeName}`);
        }
        break;
      case 'minLength':
        if (typeof value === 'string' && value.length < facet.value) {
          throw new Error(`Value ${JSON.stringify(value)} is shorter than minimum length ${facet.value} for ${typeName}`);
        }
        break;
      case 'maxLength':
        if (typeof value === 'string' && value.length > facet.value) {
          throw new Error(`Value ${JSON.stringify(value)} exceeds maximum length ${facet.value} for ${typeName}`);
        }
        break;
      case 'minInclusive':
        if (typeof value === 'number' && value < facet.value) {
          throw new Error(`Value ${value} is less than minimum ${facet.value} for ${typeName}`);
        }
        break;
      case 'maxInclusive':
        if (typeof value === 'number' && value > facet.value) {
          throw new Error(`Value ${value} exceeds maximum ${facet.value} for ${typeName}`);
        }
        break;
      case 'minExclusive':
        if (typeof value === 'number' && value <= facet.value) {
          throw new Error(`Value ${value} is not greater than ${facet.value} for ${typeName}`);
        }
        break;
      case 'maxExclusive':
        if (typeof value === 'number' && value >= facet.value) {
          throw new Error(`Value ${value} is not less than ${facet.value} for ${typeName}`);
        }
        break;
      case 'totalDigits': {
        if (typeof value === 'number' && Number.isFinite(value)) {
          if (countTotalDigits(value) > facet.value) {
            throw new Error(`Value ${value} has more than ${facet.value} total digits for ${typeName}`);
          }
        }
        break;
      }
      case 'fractionDigits': {
        const str = String(value);
        const frac = str.includes('.') ? str.split('.')[1].length : 0;
        if (frac > facet.value) {
          throw new Error(`Value ${value} has more than ${facet.value} fraction digits for ${typeName}`);
        }
        break;
      }
    }
  }
};

// Number of significant digits in the XSD canonical representation of a
// number: exponent form is expanded so neither 'e'/'-' nor leading zeros count.
const countTotalDigits = (value: number): number => {
  const abs = Math.abs(value);
  if (abs === 0) {
    return 1;
  }
  const [mantissa, exponent] = abs.toExponential(15).split('e');
  const digits = mantissa.replace('.', '').replace(/0+$/, '') || '0';
  const exp = Number(exponent);
  return exp >= 0 ? Math.max(digits.length, exp + 1) : digits.length;
};

const BOOLEAN_LEXICALS = new Set(['true', 'false', '0', '1']);

const DECIMAL_LEXICAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const INTEGER_LEXICAL = /^[+-]?\d+$/;
const FLOAT_LEXICAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

const parsePrimitive = (raw: unknown, typeName: string, facets?: Facet[]): unknown => {
  const { namespace: ns, local } = splitClark(typeName);
  if (ns !== XSD_NS) {
    if (facets) {
      validateFacets(raw, facets, typeName);
    }
    return raw;
  }

  if (raw === null || raw === undefined) {
    return raw;
  }

  const text = String(raw).trim();
  let value: unknown;
  if (XSD_INTEGER_TYPE_NAMES.has(local)) {
    if (!INTEGER_LEXICAL.test(text)) {
      throw new Error(`Invalid xs:${local} lexical: ${JSON.stringify(text)}`);
    }
    value = Number(text);
  } else if (local === 'boolean') {
    if (!BOOLEAN_LEXICALS.has(text)) {
      throw new Error(`Invalid xs:boolean lexical: ${JSON.stringify(text)}`);
    }
    value = text === 'true' || text === '1';
  } else if (local === 'decimal') {
    if (!DECIMAL_LEXICAL.test(text)) {
      throw new Error(`Invalid xs:decimal lexical: ${JSON.stringify(text)}`);
    }
    value = Number(text);
  } else if (local === 'double' || local === 'float') {
    if (text === 'INF' || text === '+INF') {
      value = Infinity;
    } else if (text === '-INF') {
      value = -Infinity;
    } else if (text === 'NaN') {
      value = NaN;
    } else {
      if (!FLOAT_LEXICAL.test(text)) {
        throw new Error(`Invalid xs:${local} lexical: ${JSON.stringify(text)}`);
      }
      value = Number(text);
    }
  } else {
    value = String(raw);
  }

  if (facets) {
    validateFacets(value, facets, typeName);
  }
  return value;
};

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
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') || key === '#text' || key === '#cdata') {
      continue;
    }
    const { prefix, local } = splitXmlName(key);
    const childNode = (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | undefined;
    const childNsContext = childNode && typeof childNode === 'object'
      ? withNamespaceContext(namespaceContext, childNode)
      : namespaceContext;
    const namespace = prefix ? (childNsContext[prefix] ?? '') : (childNsContext[''] ?? '');
    if (local === expected.local && namespace === expected.namespace) {
      return toArray(value);
    }
    if (local === expected.local && expected.namespace === '' && !prefix) {
      return toArray(value);
    }
  }
  return [];
};

const resolvePrimitiveType = (
  typeName: string,
  types: Record<string, RuntimeTypeMetadata>
): { primitive: string; facets: Facet[] } => {
  const collected: Facet[] = [];
  let current: string | undefined = typeName;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const { namespace } = splitClark(current);
    if (namespace === XSD_NS) {
      return { primitive: current, facets: collected };
    }
    const meta: RuntimeTypeMetadata | undefined = types[current];
    if (!meta) break;
    if (meta.facets) collected.unshift(...meta.facets);
    current = meta.baseType;
  }
  return { primitive: current ?? typeName, facets: collected };
};

const parseListValue = (
  raw: unknown,
  listItemType: string,
  types: Record<string, RuntimeTypeMetadata>
): unknown[] => {
  if (raw === undefined || raw === null) return [];
  const { primitive, facets } = resolvePrimitiveType(listItemType, types);
  return String(raw).trim().split(/\s+/).filter(Boolean)
    .map(item => parsePrimitive(item, primitive, facets.length > 0 ? facets : undefined));
};

const parseUnionValue = (
  raw: unknown,
  memberTypes: string[],
  types: Record<string, RuntimeTypeMetadata>
): unknown => {
  if (raw === undefined || raw === null) return raw;
  for (const mt of memberTypes) {
    const { primitive, facets } = resolvePrimitiveType(mt, types);
    try {
      const result = parsePrimitive(raw, primitive, facets.length > 0 ? facets : undefined);
      if (typeof result === 'number' && Number.isNaN(result)) {
        continue;
      }
      return result;
    } catch {
      continue;
    }
  }
  return String(raw);
};

const readValue = (
  field: RuntimeFieldMetadata,
  node: Record<string, unknown>,
  namespaceContext: Record<string, string>,
  types: Record<string, RuntimeTypeMetadata>
): unknown => {
  if (field.kind === 'text') {
    const typeMeta = types[field.typeName];
    if (typeMeta?.listItemType) {
      return parseListValue(textOf(node), typeMeta.listItemType, types);
    }
    if (typeMeta?.unionMemberTypes) {
      return parseUnionValue(textOf(node), typeMeta.unionMemberTypes, types);
    }
    const { primitive, facets } = resolvePrimitiveType(field.typeName, types);
    return parsePrimitive(textOf(node), primitive, facets.length > 0 ? facets : field.facets);
  }

  const isArray = field.maxOccurs === 'unbounded' || field.maxOccurs > 1;

  if (field.kind === 'attribute') {
    const value = findAttributeValue(node, field.qname, namespaceContext);
    const effective = value ?? field.fixedValue ?? field.defaultValue;
    if (effective === undefined) return undefined;
    const typeMeta = types[field.typeName];
    if (typeMeta?.listItemType) {
      return parseListValue(effective, typeMeta.listItemType, types);
    }
    if (typeMeta?.unionMemberTypes) {
      return parseUnionValue(effective, typeMeta.unionMemberTypes, types);
    }
    const { primitive, facets } = resolvePrimitiveType(field.typeName, types);
    return parsePrimitive(effective, primitive, facets.length > 0 ? facets : field.facets);
  }

  const typeMeta = types[field.typeName];
  // Only types with real content-model fields are complex; plain restriction
  // simple types carry no fields and parse to their base primitive (#71).
  const complexType = typeMeta && !typeMeta.listItemType && !typeMeta.unionMemberTypes && typeMeta.fields.length > 0 ? typeMeta : undefined;
  const resolved = resolvePrimitiveType(field.typeName, types);
  const resolvedFacets = resolved.facets.length > 0 ? resolved.facets : field.facets;

  const values = findElementValues(node, field.qname, namespaceContext).map((entry) => {
    if (entry && typeof entry === 'object') {
      const entryNode = entry as Record<string, unknown>;
      const entryNamespaceContext = withNamespaceContext(namespaceContext, entryNode);
      const nilValue = findAttributeValue(entryNode, `{${XSI_NS}}nil`, entryNamespaceContext);
      if (nilValue === 'true' || nilValue === true || nilValue === '1' || nilValue === 1) {
        return null;
      }
      if (complexType) {
        return parseTypeFields(entryNode, complexType, entryNamespaceContext, types);
      }
      const text = textOf(entryNode);
      if (typeMeta?.listItemType) {
        return parseListValue(text, typeMeta.listItemType, types);
      }
      if (typeMeta?.unionMemberTypes) {
        return parseUnionValue(text, typeMeta.unionMemberTypes, types);
      }
      return parsePrimitive(text, resolved.primitive, resolvedFacets);
    }
    if (complexType) {
      return parseTypeFields({ '#text': entry }, complexType, namespaceContext, types);
    }
    if (typeMeta?.listItemType) {
      return parseListValue(entry, typeMeta.listItemType, types);
    }
    if (typeMeta?.unionMemberTypes) {
      return parseUnionValue(entry, typeMeta.unionMemberTypes, types);
    }
    return parsePrimitive(entry, resolved.primitive, resolvedFacets);
  });

  if (isArray) {
    return values;
  }

  if (values.length === 0) {
    const fallback = field.fixedValue ?? field.defaultValue;
    if (fallback !== undefined) {
      const typeMeta = types[field.typeName];
      if (typeMeta?.listItemType) {
        return parseListValue(fallback, typeMeta.listItemType, types);
      }
      if (typeMeta?.unionMemberTypes) {
        return parseUnionValue(fallback, typeMeta.unionMemberTypes, types);
      }
      return parsePrimitive(fallback, resolved.primitive, resolvedFacets);
    }
  }

  return values[0];
};

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
  types: Record<string, RuntimeTypeMetadata>;
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

const serializeField = (
  field: RuntimeFieldMetadata,
  value: unknown,
  ctx: SerializeCtx
): { attr?: string; elements: string[]; usesXsi: boolean } => {
  const localName = elementName(field.qname, ctx.prefixMap);
  const typeMeta = ctx.types[field.typeName];

  if (field.kind === 'attribute') {
    if (value === undefined) {
      return { elements: [], usesXsi: false };
    }
    if (field.defaultValue !== undefined && String(value) === field.defaultValue) {
      return { elements: [], usesXsi: false };
    }
    if (field.fixedValue !== undefined && String(value) === field.fixedValue) {
      return { elements: [], usesXsi: false };
    }
    if (typeMeta?.listItemType && Array.isArray(value)) {
      return { attr: `${localName}="${serializeListValue(value)}"`, elements: [], usesXsi: false };
    }
    return { attr: `${localName}="${serializePrimitive(value)}"`, elements: [], usesXsi: false };
  }

  if (field.kind === 'text') {
    if (typeMeta?.listItemType && Array.isArray(value)) {
      return { elements: [serializeListValue(value)], usesXsi: false };
    }
    return { elements: [serializePrimitive(value)], usesXsi: false };
  }

  if (field.maxOccurs !== 'unbounded' && field.maxOccurs <= 1) {
    if (field.defaultValue !== undefined && String(value) === field.defaultValue) {
      return { elements: [], usesXsi: false };
    }
    if (field.fixedValue !== undefined && String(value) === field.fixedValue) {
      return { elements: [], usesXsi: false };
    }
  }

  const values = field.maxOccurs === 'unbounded' || field.maxOccurs > 1 ? (Array.isArray(value) ? value : value === undefined ? [] : [value]) : [value];
  const pieces: string[] = [];
  let usesXsi = false;
  const complexType = typeMeta && !typeMeta.listItemType && !typeMeta.unionMemberTypes && typeMeta.fields.length > 0 ? typeMeta : undefined;

  for (const current of values) {
    if (current === undefined) {
      continue;
    }
    if (current === null) {
      usesXsi = true;
      pieces.push(`<${localName} xsi:nil="true"/>`);
      continue;
    }
    if (complexType && typeof current === 'object' && !Array.isArray(current)) {
      const inner = serializeTypeFields(current as Record<string, unknown>, complexType, ctx);
      usesXsi = usesXsi || inner.usesXsi;
      const attrStr = inner.attributes.length > 0 ? ` ${inner.attributes.join(' ')}` : '';
      pieces.push(`<${localName}${attrStr}>${inner.elements.join('')}</${localName}>`);
      continue;
    }
    if (typeMeta?.listItemType && Array.isArray(current)) {
      pieces.push(`<${localName}>${serializeListValue(current)}</${localName}>`);
      continue;
    }
    pieces.push(`<${localName}>${serializePrimitive(current)}</${localName}>`);
  }

  return { elements: pieces, usesXsi };
};

const parseTypeFields = (
  node: Record<string, unknown>,
  metadata: RuntimeTypeMetadata,
  namespaceContext: Record<string, string>,
  types: Record<string, RuntimeTypeMetadata>
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const field of metadata.fields) {
    const value = readValue(field, node, namespaceContext, types);
    const isArray = field.maxOccurs === 'unbounded' || field.maxOccurs > 1;
    if (value === undefined) {
      if (isArray) {
        result[field.key] = [];
      }
      continue;
    }
    result[field.key] = value;
    if (field.choiceGroup && value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0)) {
      result.__choice = field.key;
    }
  }
  return result;
};

const serializeTypeFields = (
  obj: Record<string, unknown>,
  metadata: RuntimeTypeMetadata,
  ctx: SerializeCtx
): { attributes: string[]; elements: string[]; usesXsi: boolean } => {
  const attributes: string[] = [];
  const elements: string[] = [];
  let usesXsi = false;
  for (const field of metadata.fields) {
    const fieldResult = serializeField(field, obj[field.key], ctx);
    if (fieldResult.attr) {
      attributes.push(fieldResult.attr);
    }
    elements.push(...fieldResult.elements);
    usesXsi = usesXsi || fieldResult.usesXsi;
  }
  return { attributes, elements, usesXsi };
};

const extractRoot = (
  parsed: Record<string, unknown>,
  expectedQName: string
): { root: Record<string, unknown>; namespaceContext: Record<string, string> } => {
  const expected = splitClark(expectedQName);
  const entry = Object.entries(parsed).find(([key, value]) => {
    const node = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const namespaceContext = withNamespaceContext({}, node);
    const { prefix, local } = splitXmlName(key);
    const namespace = prefix ? (namespaceContext[prefix] ?? '') : (namespaceContext[''] ?? '');
    return local === expected.local && namespace === expected.namespace;
  });
  if (!entry) {
    throw new Error(`Root element '${expectedQName}' not found in XML payload`);
  }
  if (entry[1] && typeof entry[1] === 'object') {
    const root = entry[1] as Record<string, unknown>;
    return { root, namespaceContext: withNamespaceContext({}, root) };
  }
  return { root: { '#text': entry[1] }, namespaceContext: {} };
};

export const parseXmlWithMetadata = <T>(
  xml: string,
  root: RuntimeRootMetadata,
  types: Record<string, RuntimeTypeMetadata>
): T => {
  const parsed = parser.parse(decodeTagNameCharRefs(xml)) as Record<string, unknown>;
  const { root: rootNode, namespaceContext } = extractRoot(parsed, root.rootElement);

  const nilValue = findAttributeValue(rootNode, `{${XSI_NS}}nil`, namespaceContext);
  if (nilValue === 'true' || nilValue === '1') {
    return null as T;
  }

  if (root.fields.length === 0) {
    // Simple-typed root element: the document value is the root's text content (#71).
    const textField: RuntimeFieldMetadata = {
      key: '_text',
      kind: 'text',
      qname: '{}_text' as RuntimeFieldMetadata['qname'],
      typeName: root.typeName,
      minOccurs: 1,
      maxOccurs: 1
    };
    return readValue(textField, rootNode, namespaceContext, types) as T;
  }

  return parseTypeFields(rootNode, root, namespaceContext, types) as T;
};

export const serializeXmlWithMetadata = <T extends Record<string, unknown>>(
  obj: T,
  root: RuntimeRootMetadata,
  types: Record<string, RuntimeTypeMetadata>
): string => {
  const rootInfo = splitClark(root.rootElement);
  const ctx: SerializeCtx = {
    prefixMap: new Map<string, string>(),
    types,
  };

  let body: string;
  let attributes: string[] = [];
  let usesXsi = false;
  if (obj === null || obj === undefined) {
    usesXsi = true;
    body = '';
  } else if (root.fields.length === 0) {
    const typeMeta = types[root.typeName];
    body = typeMeta?.listItemType ? serializeListValue(obj) : serializePrimitive(obj);
  } else {
    const inner = serializeTypeFields(obj, root, ctx);
    attributes = inner.attributes;
    usesXsi = inner.usesXsi;
    body = inner.elements.join('');
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
  if (obj === null || obj === undefined) {
    const nilAttrs = [...nsDecls, 'xsi:nil="true"'].join(' ');
    return `<${rootTag} ${nilAttrs}/>`;
  }
  const opening = attrs ? `<${rootTag} ${attrs}>` : `<${rootTag}>`;
  return `${opening}${body}</${rootTag}>`;
};

export const createRootHelpers = <T>(
  root: RuntimeRootMetadata,
  types: Record<string, RuntimeTypeMetadata>
): {
  parseXml: (xml: string) => T;
  serializeXml: (obj: T) => string;
} => ({
  parseXml: (xml) => parseXmlWithMetadata<T>(xml, root, types),
  serializeXml: (obj) => serializeXmlWithMetadata(obj as Record<string, unknown>, root, types)
});
