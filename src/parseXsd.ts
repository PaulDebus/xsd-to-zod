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
type FormDefault = 'qualified' | 'unqualified';
type SchemaFormDefaults = {
  element: FormDefault;
  attribute: FormDefault;
};

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
  if (!qname.startsWith('{')) {
    return { namespace: '', local: qname };
  }
  const boundary = qname.indexOf('}');
  if (boundary === -1) {
    return { namespace: '', local: qname };
  }
  return { namespace: qname.slice(1, boundary), local: qname.slice(boundary + 1) };
};

const resolveTypeQName = (rawType: string | undefined, nsMap: Record<string, string>): QName => {
  if (!rawType) {
    return toClark(XSD_NS, 'string');
  }
  const { prefix, local } = splitQName(rawType);
  if (prefix === '') {
    return toClark(nsMap[''] ?? '', local);
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

const multiplyMaxOccurs = (left: Cardinality['maxOccurs'], right: Cardinality['maxOccurs']): Cardinality['maxOccurs'] => {
  if (left === 0 || right === 0) {
    return 0;
  }
  if (left === 'unbounded' || right === 'unbounded') {
    return 'unbounded';
  }
  return left * right;
};

const combineCardinality = (parent: Cardinality, own: Cardinality): Cardinality => ({
  minOccurs: parent.minOccurs * own.minOccurs,
  maxOccurs: multiplyMaxOccurs(parent.maxOccurs, own.maxOccurs)
});

const normalizeFormDefault = (raw: unknown, fallback: FormDefault): FormDefault =>
  raw === 'qualified' || raw === 'unqualified' ? raw : fallback;

const resolveDeclaredFieldNamespace = (
  ownerNs: string,
  fieldKind: 'attribute' | 'element',
  formValue: unknown,
  formDefaults: SchemaFormDefaults
): string => {
  const fallback = fieldKind === 'attribute' ? formDefaults.attribute : formDefaults.element;
  const effectiveForm = normalizeFormDefault(formValue, fallback);
  return effectiveForm === 'qualified' ? ownerNs : '';
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

const readSchema = (
  filePath: string
): { schemaNode: AnyNode; nsMap: Record<string, string>; targetNs: string; formDefaults: SchemaFormDefaults } => {
  const xml = fs.readFileSync(filePath, 'utf8');
  const parsed = parser.parse(xml) as Record<string, AnyNode>;
  const schemaEntry = Object.entries(parsed).find(([key]) => getNodeTagLocalName(key) === 'schema');
  if (!schemaEntry) {
    throw new Error(`No schema root found in ${filePath}`);
  }
  const schemaNode = schemaEntry[1];
  const nsMap = collectNamespaceMap(schemaNode);
  const targetNs = String(schemaNode['@_targetNamespace'] ?? '');
  const formDefaults: SchemaFormDefaults = {
    element: normalizeFormDefault(schemaNode['@_elementFormDefault'], 'unqualified'),
    attribute: normalizeFormDefault(schemaNode['@_attributeFormDefault'], 'unqualified')
  };
  return { schemaNode, nsMap, targetNs, formDefaults };
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
  formDefaults: SchemaFormDefaults,
  container: AnyNode,
  fields: IrField[],
  choiceGroup?: string,
  inheritedCardinality: Cardinality = { minOccurs: 1, maxOccurs: 1 },
  elements: Record<string, ElementDef> = {},
  choiceCounter?: { value: number },
  complexTypes?: Record<string, ComplexTypeDef>,
  syntheticTypeContext?: { targetNs: string; counter: { value: number } }
): void => {
  if (!choiceCounter) {
    choiceCounter = { value: 0 };
  }
  for (const [tag, child] of nodeChildren(container)) {
    const localTag = getNodeTagLocalName(tag);
    if (localTag === 'element') {
      const name = String(child['@_name'] ?? '');
      const ref = child['@_ref'] ? String(child['@_ref']) : '';
      if (!name && !ref) {
        continue;
      }

      if (ref) {
        const refQName = resolveTypeQName(ref, nsMap);
        const referenced = elements[refQName];
        if (referenced) {
          const effectiveCardinality = combineCardinality(inheritedCardinality, parseCardinality(child));
          fields.push({
            ...effectiveCardinality,
            kind: 'element',
            qname: refQName,
            typeName: referenced.typeName,
            nillable: child['@_nillable'] === true || child['@_nillable'] === 'true' || referenced.nillable === true,
            choiceGroup
          });
        }
        continue;
      }

      let typeName: QName;
      if (child['@_type']) {
        typeName = resolveTypeQName(String(child['@_type']), { ...nsMap, '': ownerNs });
      } else {
        const inlineComplex = nodeChildren(child).find(([key]) => getNodeTagLocalName(key) === 'complexType')?.[1];
        if (inlineComplex && complexTypes && syntheticTypeContext) {
          syntheticTypeContext.counter.value++;
          const syntheticName = toClark(syntheticTypeContext.targetNs, `anonymous_Type${syntheticTypeContext.counter.value}`);
          const inlineFields: IrField[] = [];
          collectFields(
            ownerNs, nsMap, formDefaults, inlineComplex, inlineFields,
            undefined, inheritedCardinality, elements, choiceCounter,
            complexTypes, syntheticTypeContext
          );
          complexTypes[syntheticName] = { name: syntheticName, fields: inlineFields };
          typeName = syntheticName;
        } else {
          typeName = resolveTypeQName(undefined, { ...nsMap, '': ownerNs });
        }
      }
      const effectiveCardinality = combineCardinality(inheritedCardinality, parseCardinality(child));
      fields.push({
        ...effectiveCardinality,
        kind: 'element',
        qname: toClark(resolveDeclaredFieldNamespace(ownerNs, 'element', child['@_form'], formDefaults), name),
        typeName,
        nillable: child['@_nillable'] === true || child['@_nillable'] === 'true',
        choiceGroup
      });
      continue;
    }

    if (localTag === 'attribute') {
      const name = String(child['@_name'] ?? '');
      const ref = child['@_ref'] ? String(child['@_ref']) : '';
      if (!name && !ref) {
        continue;
      }

      if (ref) {
        const refQName = resolveTypeQName(ref, nsMap);
        fields.push({
          ...combineCardinality(inheritedCardinality, {
            minOccurs: child['@_use'] === 'required' ? 1 : 0,
            maxOccurs: 1
          }),
          kind: 'attribute',
          qname: refQName,
          typeName: toClark(XSD_NS, 'string')
        });
        continue;
      }

      fields.push({
        ...combineCardinality(inheritedCardinality, {
          minOccurs: child['@_use'] === 'required' ? 1 : 0,
          maxOccurs: 1
        }),
        kind: 'attribute',
        qname: toClark(resolveDeclaredFieldNamespace(ownerNs, 'attribute', child['@_form'], formDefaults), name),
        typeName: resolveTypeQName(child['@_type'] ? String(child['@_type']) : undefined, nsMap)
      });
      continue;
    }

    if (localTag === 'sequence' || localTag === 'all') {
      collectFields(
        ownerNs,
        nsMap,
        formDefaults,
        child,
        fields,
        choiceGroup,
        combineCardinality(inheritedCardinality, parseCardinality(child)),
        elements,
        choiceCounter,
        complexTypes,
        syntheticTypeContext
      );
      continue;
    }

    if (localTag === 'choice') {
      const groupId = `${choiceCounter.value++}`;
      collectFields(
        ownerNs,
        nsMap,
        formDefaults,
        child,
        fields,
        groupId,
        combineCardinality(inheritedCardinality, parseCardinality(child)),
        elements,
        choiceCounter,
        complexTypes,
        syntheticTypeContext
      );
      continue;
    }

    if (localTag === 'simpleContent') {
      const extension = nodeChildren(child).find(([key]) => getNodeTagLocalName(key) === 'extension')?.[1];
      if (!extension) {
        continue;
      }
      const baseType = resolveTypeQName(extension['@_base'] ? String(extension['@_base']) : undefined, nsMap);
      fields.push({
        ...inheritedCardinality,
        kind: 'text',
        qname: toClark(ownerNs, '_text'),
        typeName: baseType
      });
      collectFields(ownerNs, nsMap, formDefaults, extension, fields, choiceGroup, inheritedCardinality, elements, choiceCounter, complexTypes, syntheticTypeContext);
      continue;
    }

    if (localTag === 'complexContent') {
      const extension = nodeChildren(child).find(([key]) => getNodeTagLocalName(key) === 'extension')?.[1];
      if (!extension) {
        continue;
      }
      collectFields(ownerNs, nsMap, formDefaults, extension, fields, choiceGroup, inheritedCardinality, elements, choiceCounter, complexTypes, syntheticTypeContext);
    }
  }
};

type DeferredInlineType = {
  typeName: QName;
  container: AnyNode;
  ownerNs: string;
  nsMap: Record<string, string>;
  formDefaults: SchemaFormDefaults;
};

export const parseXsd = (files: string[]): XsdIr => {
  const visited = new Set<string>();
  const queue = files.map((file) => path.resolve(file));

  const simpleTypes: Record<string, SimpleTypeDef> = {};
  const complexTypes: Record<string, ComplexTypeDef> = {};
  const elements: Record<string, ElementDef> = {};
  const rootElements: QName[] = [];
  const targetNamespaces = new Set<string>();
  const deferredInlineTypes: DeferredInlineType[] = [];
  const syntheticTypeCounter = { value: 0 };

  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || visited.has(file)) {
      continue;
    }
    visited.add(file);

    const { schemaNode, nsMap, targetNs, formDefaults } = readSchema(file);
    targetNamespaces.add(targetNs);
    const schemaChildren = nodeChildren(schemaNode);

    const elementNodes: Array<{ node: AnyNode }> = [];
    const complexTypeNodes: Array<{ node: AnyNode }> = [];

    // Pass 1: collect all declarations before processing fields
    for (const [tag, child] of schemaChildren) {
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
        complexTypeNodes.push({ node: child });
        continue;
      }

      if (localTag === 'element') {
        elementNodes.push({ node: child });
        continue;
      }
    }

    // Pass 2: process top-level elements (populates `elements` for ref resolution)
    for (const { node: child } of elementNodes) {
      const name = String(child['@_name'] ?? '');
      if (!name) continue;

      let typeName = child['@_type'] ? resolveTypeQName(String(child['@_type']), { ...nsMap, '': targetNs }) : undefined;

      if (!typeName) {
        const inlineComplex = nodeChildren(child).find(([key]) => getNodeTagLocalName(key) === 'complexType')?.[1];
        if (inlineComplex) {
          typeName = toClark(targetNs, `anonymous_${name}_Type`);
          complexTypes[typeName] = { name: typeName, fields: [] };
          deferredInlineTypes.push({ typeName, container: inlineComplex, ownerNs: targetNs, nsMap, formDefaults });
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

    // Pass 3: process complex types (elements now available for ref resolution)
    for (const { node: child } of complexTypeNodes) {
      const name = String(child['@_name'] ?? '');
      if (!name) continue;
      const qname = toClark(targetNs, name);
      const fields: IrField[] = [];
      collectFields(targetNs, nsMap, formDefaults, child, fields, undefined, undefined, elements, undefined, complexTypes, { targetNs, counter: syntheticTypeCounter });
      const extension = nodeChildren(child)
        .find(([key]) => getNodeTagLocalName(key) === 'complexContent')?.[1];
      const extensionNode = extension
        ? nodeChildren(extension).find(([key]) => getNodeTagLocalName(key) === 'extension')?.[1]
        : undefined;
      const baseType = extensionNode?.['@_base'] ? resolveTypeQName(String(extensionNode['@_base']), nsMap) : undefined;

      complexTypes[qname] = { name: qname, fields, baseType };
    }
  }

  // Process deferred inline types now that all elements are collected
  for (const { typeName, container, ownerNs, nsMap, formDefaults } of deferredInlineTypes) {
    const fields: IrField[] = [];
    collectFields(ownerNs, nsMap, formDefaults, container, fields, undefined, undefined, elements, undefined, complexTypes, { targetNs: ownerNs, counter: syntheticTypeCounter });
    complexTypes[typeName] = { name: typeName, fields };
  }

  const mergedComplexTypes: Record<string, ComplexTypeDef> = {};
  const resolveMergedFields = (typeName: QName, stack: Set<QName>): IrField[] => {
    const type = complexTypes[typeName];
    if (!type) {
      return [];
    }
    if (!type.baseType || !complexTypes[type.baseType]) {
      return type.fields;
    }
    if (stack.has(typeName)) {
      return type.fields;
    }
    const nextStack = new Set(stack);
    nextStack.add(typeName);
    return [...resolveMergedFields(type.baseType, nextStack), ...type.fields];
  };

  for (const [name, type] of Object.entries(complexTypes)) {
    mergedComplexTypes[name] = {
      ...type,
      fields: resolveMergedFields(name as QName, new Set())
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
