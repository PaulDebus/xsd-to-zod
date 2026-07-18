import XMLParser from '@nodable/flexible-xml-parser';
import type { Facet, RuntimeFieldMetadata, RuntimeRootMetadata, RuntimeTypeMetadata } from './types.js';

const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';

const parser = new XMLParser({
  skip: { attributes: false },
  attributes: { prefix: '@_' }
});

const toArray = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

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
        const str = String(typeof value === 'number' ? Math.abs(value) : value);
        const digits = str.replace('.', '').replace('-', '').length;
        if (digits > facet.value) {
          throw new Error(`Value ${value} has more than ${facet.value} total digits for ${typeName}`);
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

const parsePrimitive = (raw: unknown, typeName: string, facets?: Facet[]): unknown => {
  const { namespace: ns, local } = splitClark(typeName);
  if (ns !== 'http://www.w3.org/2001/XMLSchema') {
    if (facets) {
      validateFacets(raw, facets, typeName);
    }
    return raw;
  }

  if (raw === null || raw === undefined) {
    return raw;
  }

  let value: unknown;
  switch (local) {
    case 'boolean':
      value = raw === true || raw === 1 || raw === 'true' || raw === '1';
      break;
    case 'int':
    case 'integer':
    case 'decimal':
    case 'double':
    case 'float':
      value = Number(raw);
      break;
    default:
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
    if (key.startsWith('@_') || key === '#text') {
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

const readValue = (
  field: RuntimeFieldMetadata,
  node: Record<string, unknown>,
  namespaceContext: Record<string, string>,
  types: Record<string, RuntimeTypeMetadata>
): unknown => {
  if (field.kind === 'text') {
    return parsePrimitive(node['#text'], field.typeName, field.facets);
  }

  const isArray = field.maxOccurs === 'unbounded' || field.maxOccurs > 1;

  if (field.kind === 'attribute') {
    const value = findAttributeValue(node, field.qname, namespaceContext);
    return value === undefined ? undefined : parsePrimitive(value, field.typeName, field.facets);
  }

  const complexType = types[field.typeName];

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
      return parsePrimitive(entryNode['#text'] ?? entry, field.typeName, field.facets);
    }
    if (complexType) {
      return parseTypeFields({ '#text': entry }, complexType, namespaceContext, types);
    }
    return parsePrimitive(entry, field.typeName, field.facets);
  });

  if (isArray) {
    return values;
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

const serializeField = (
  field: RuntimeFieldMetadata,
  value: unknown,
  ctx: SerializeCtx
): { attr?: string; elements: string[]; usesXsi: boolean } => {
  const localName = elementName(field.qname, ctx.prefixMap);
  if (field.kind === 'attribute') {
    if (value === undefined) {
      return { elements: [], usesXsi: false };
    }
    return { attr: `${localName}="${serializePrimitive(value)}"`, elements: [], usesXsi: false };
  }

  if (field.kind === 'text') {
    return { elements: [serializePrimitive(value)], usesXsi: false };
  }

  const values = field.maxOccurs === 'unbounded' || field.maxOccurs > 1 ? (Array.isArray(value) ? value : value === undefined ? [] : [value]) : [value];
  const pieces: string[] = [];
  let usesXsi = false;
  const complexType = ctx.types[field.typeName];

  for (const current of values) {
    if (current === undefined) {
      continue;
    }
    if (current === null) {
      usesXsi = true;
      pieces.push(`<${localName} xsi:nil="true"/>`);
      continue;
    }
    if (complexType && typeof current === 'object') {
      const inner = serializeTypeFields(current as Record<string, unknown>, complexType, ctx);
      usesXsi = usesXsi || inner.usesXsi;
      const attrStr = inner.attributes.length > 0 ? ` ${inner.attributes.join(' ')}` : '';
      pieces.push(`<${localName}${attrStr}>${inner.elements.join('')}</${localName}>`);
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
  const parsed = parser.parse(decodeXmlEntities(xml)) as Record<string, unknown>;
  const { root: rootNode, namespaceContext } = extractRoot(parsed, root.rootElement);

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
  const { attributes, elements, usesXsi } = serializeTypeFields(obj, root, ctx);

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
  const opening = attrs ? `<${rootTag} ${attrs}>` : `<${rootTag}>`;
  return `${opening}${elements.join('')}</${rootTag}>`;
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
