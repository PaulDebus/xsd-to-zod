import fs from 'node:fs';
import path from 'node:path';
import XMLParser from '@nodable/flexible-xml-parser';
import type {
  Cardinality,
  ComplexTypeDef,
  ElementDef,
  IrField,
  QName,
  SimpleTypeDef,
  XsdIr
} from './types.js';

const XSD_NS = 'http://www.w3.org/2001/XMLSchema';

const parser = new XMLParser({
  skip: { attributes: false },
  attributes: { prefix: '@_' }
});

type AnyNode = Record<string, unknown>;

const asArray = <T>(value: T | T[] | undefined): T[] => {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
};

const splitQName = (name: string): { prefix: string; local: string } => {
  const idx = name.indexOf(':');
  return idx === -1 ? { prefix: '', local: name } : { prefix: name.slice(0, idx), local: name.slice(idx + 1) };
};

const toClark = (nsUri: string | undefined, local: string): QName => `{${nsUri ?? ''}}${local}`;

const fromClark = (qname: QName): { namespace: string; local: string } => {
  const match = qname.match(/^\{(.*)}(.*)$/);
  if (!match) {
    return { namespace: '', local: qname };
  }
  return { namespace: match[1], local: match[2] };
};

const resolveTypeQName = (rawType: string | undefined, nsMap: Record<string, string>): QName => {
  if (!rawType) {
    return toClark(XSD_NS, 'string');
  }
  const { prefix, local } = splitQName(rawType);
  if (prefix === '') {
    return toClark('', local);
  }
  return toClark(nsMap[prefix] ?? '', local);
};

const parseCardinality = (node: AnyNode): Cardinality => {
  const rawMin = node['@_minOccurs'];
  const rawMax = node['@_maxOccurs'];
  return {
    minOccurs: rawMin === undefined ? 1 : Number(rawMin),
    maxOccurs: rawMax === undefined ? 1 : rawMax === 'unbounded' ? 'unbounded' : Number(rawMax)
  };
};

const collectNamespaceMap = (schemaNode: AnyNode): Record<string, string> => {
  const nsMap: Record<string, string> = {};
  for (const [key, value] of Object.entries(schemaNode)) {
    if (!key.startsWith('@_xmlns')) {
      continue;
    }
    const suffix = key.slice('@_xmlns'.length);
    const prefix = suffix.startsWith(':') ? suffix.slice(1) : '';
    nsMap[prefix] = String(value);
  }
  if (!nsMap.xs) {
    nsMap.xs = XSD_NS;
  }
  return nsMap;
};

const getNodeTagLocalName = (tag: string): string => splitQName(tag).local;

const readSchema = (filePath: string): { schemaNode: AnyNode; nsMap: Record<string, string>; targetNs: string } => {
  const xml = fs.readFileSync(filePath, 'utf8');
  const parsed = parser.parse(xml) as Record<string, AnyNode>;
  const schemaEntry = Object.entries(parsed).find(([key]) => getNodeTagLocalName(key) === 'schema');
  if (!schemaEntry) {
    throw new Error(`No schema root found in ${filePath}`);
  }
  const schemaNode = schemaEntry[1];
  const nsMap = collectNamespaceMap(schemaNode);
  const targetNs = String(schemaNode['@_targetNamespace'] ?? '');
  return { schemaNode, nsMap, targetNs };
};

const nodeChildren = (node: AnyNode): Array<[string, AnyNode]> => {
  const children: Array<[string, AnyNode]> = [];
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') || key === '#text') {
      continue;
    }
    for (const entry of asArray(value as AnyNode | AnyNode[])) {
      if (entry && typeof entry === 'object') {
        children.push([key, entry as AnyNode]);
      }
    }
  }
  return children;
};

const collectFields = (
  ownerNs: string,
  nsMap: Record<string, string>,
  container: AnyNode,
  fields: IrField[],
  choiceGroup?: string
): void => {
  for (const [tag, child] of nodeChildren(container)) {
    const localTag = getNodeTagLocalName(tag);
    if (localTag === 'element') {
      const name = String(child['@_name'] ?? '');
      if (!name) {
        continue;
      }
      const typeName = resolveTypeQName(child['@_type'] ? String(child['@_type']) : undefined, {
        ...nsMap,
        '': ownerNs
      });
      fields.push({
        ...parseCardinality(child),
        kind: 'element',
        qname: toClark(ownerNs, name),
        typeName,
        nillable: child['@_nillable'] === true || child['@_nillable'] === 'true',
        choiceGroup
      });
      continue;
    }

    if (localTag === 'attribute') {
      const name = String(child['@_name'] ?? '');
      if (!name) {
        continue;
      }
      fields.push({
        minOccurs: child['@_use'] === 'required' ? 1 : 0,
        maxOccurs: 1,
        kind: 'attribute',
        qname: toClark(ownerNs, name),
        typeName: resolveTypeQName(child['@_type'] ? String(child['@_type']) : undefined, nsMap)
      });
      continue;
    }

    if (localTag === 'sequence' || localTag === 'all') {
      collectFields(ownerNs, nsMap, child, fields, choiceGroup);
      continue;
    }

    if (localTag === 'choice') {
      const groupId = `${fields.length}`;
      collectFields(ownerNs, nsMap, child, fields, groupId);
      continue;
    }

    if (localTag === 'simpleContent') {
      const extension = nodeChildren(child).find(([key]) => getNodeTagLocalName(key) === 'extension')?.[1];
      if (!extension) {
        continue;
      }
      const baseType = resolveTypeQName(extension['@_base'] ? String(extension['@_base']) : undefined, nsMap);
      fields.push({
        minOccurs: 1,
        maxOccurs: 1,
        kind: 'text',
        qname: toClark(ownerNs, '_text'),
        typeName: baseType
      });
      collectFields(ownerNs, nsMap, extension, fields, choiceGroup);
      continue;
    }

    if (localTag === 'complexContent') {
      const extension = nodeChildren(child).find(([key]) => getNodeTagLocalName(key) === 'extension')?.[1];
      if (!extension) {
        continue;
      }
      collectFields(ownerNs, nsMap, extension, fields, choiceGroup);
    }
  }
};

export const parseXsd = (files: string[]): XsdIr => {
  const visited = new Set<string>();
  const queue = files.map((file) => path.resolve(file));

  const simpleTypes: Record<string, SimpleTypeDef> = {};
  const complexTypes: Record<string, ComplexTypeDef> = {};
  const elements: Record<string, ElementDef> = {};
  const rootElements: QName[] = [];
  const targetNamespaces = new Set<string>();

  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || visited.has(file)) {
      continue;
    }
    visited.add(file);

    const { schemaNode, nsMap, targetNs } = readSchema(file);
    targetNamespaces.add(targetNs);

    for (const [tag, child] of nodeChildren(schemaNode)) {
      const localTag = getNodeTagLocalName(tag);

      if (localTag === 'import' || localTag === 'include') {
        const schemaLocation = child['@_schemaLocation'] ? String(child['@_schemaLocation']) : '';
        if (schemaLocation) {
          queue.push(path.resolve(path.dirname(file), schemaLocation));
        }
        continue;
      }

      if (localTag === 'simpleType') {
        const name = String(child['@_name'] ?? '');
        if (!name) {
          continue;
        }
        const restriction = nodeChildren(child).find(([key]) => getNodeTagLocalName(key) === 'restriction')?.[1];
        const baseType = resolveTypeQName(restriction?.['@_base'] ? String(restriction['@_base']) : undefined, nsMap);
        const qname = toClark(targetNs, name);
        simpleTypes[qname] = { name: qname, baseType };
        continue;
      }

      if (localTag === 'complexType') {
        const name = String(child['@_name'] ?? '');
        if (!name) {
          continue;
        }
        const qname = toClark(targetNs, name);
        const fields: IrField[] = [];
        collectFields(targetNs, nsMap, child, fields);
        const extension = nodeChildren(child)
          .find(([key]) => getNodeTagLocalName(key) === 'complexContent')?.[1];
        const extensionNode = extension
          ? nodeChildren(extension).find(([key]) => getNodeTagLocalName(key) === 'extension')?.[1]
          : undefined;
        const baseType = extensionNode?.['@_base'] ? resolveTypeQName(String(extensionNode['@_base']), nsMap) : undefined;

        complexTypes[qname] = { name: qname, fields, baseType };
        continue;
      }

      if (localTag === 'element') {
        const name = String(child['@_name'] ?? '');
        if (!name) {
          continue;
        }

        let typeName = child['@_type'] ? resolveTypeQName(String(child['@_type']), { ...nsMap, '': targetNs }) : undefined;

        if (!typeName) {
          const inlineComplex = nodeChildren(child).find(([key]) => getNodeTagLocalName(key) === 'complexType')?.[1];
          if (inlineComplex) {
            typeName = toClark(targetNs, `${name}Type`);
            const fields: IrField[] = [];
            collectFields(targetNs, nsMap, inlineComplex, fields);
            complexTypes[typeName] = { name: typeName, fields };
          }
        }

        if (!typeName) {
          typeName = toClark(XSD_NS, 'string');
        }

        const qname = toClark(targetNs, name);
        elements[qname] = {
          name: qname,
          typeName,
          cardinality: parseCardinality(child),
          nillable: child['@_nillable'] === true || child['@_nillable'] === 'true'
        };
        rootElements.push(qname);
      }
    }
  }

  const mergedComplexTypes: Record<string, ComplexTypeDef> = {};
  for (const [name, type] of Object.entries(complexTypes)) {
    if (!type.baseType || !complexTypes[type.baseType]) {
      mergedComplexTypes[name] = type;
      continue;
    }
    mergedComplexTypes[name] = {
      ...type,
      fields: [...complexTypes[type.baseType].fields, ...type.fields]
    };
  }

  return {
    targetNamespaces: [...targetNamespaces],
    simpleTypes,
    complexTypes: mergedComplexTypes,
    elements,
    rootElements
  };
};

export const clarkToLocal = (qname: QName): string => fromClark(qname).local;
