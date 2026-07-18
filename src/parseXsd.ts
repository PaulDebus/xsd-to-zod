import path from 'node:path';
import XMLParser from '@nodable/flexible-xml-parser';
import { readXmlFile } from './readXmlFile.js';
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
  const xml = readXmlFile(filePath);
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
  syntheticTypeContext?: { targetNs: string; counter: { value: number } },
  groups: Record<string, AnyNode> = {},
  attributeGroups: Record<string, [string, SchemaFormDefaults, AnyNode]> = {},
  deferredSyntheticTypes?: DeferredInlineType[]
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
          complexTypes[syntheticName] = { name: syntheticName, fields: [] };
          if (deferredSyntheticTypes) {
            deferredSyntheticTypes.push({ typeName: syntheticName, container: inlineComplex, ownerNs, nsMap, formDefaults, groups, attributeGroups });
          }
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
        syntheticTypeContext,
        groups,
        attributeGroups,
        deferredSyntheticTypes
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
        syntheticTypeContext,
        groups,
        attributeGroups,
        deferredSyntheticTypes
      );
      continue;
    }

    if (localTag === 'group') {
      const ref = child['@_ref'] ? String(child['@_ref']) : '';
      if (!ref) continue;
      const refQName = resolveTypeQName(ref, nsMap);
      const groupNode = groups[refQName];
      if (groupNode) {
        collectFields(
          ownerNs, nsMap, formDefaults, groupNode, fields,
          choiceGroup, combineCardinality(inheritedCardinality, parseCardinality(child)),
          elements, choiceCounter, complexTypes, syntheticTypeContext, groups, attributeGroups, deferredSyntheticTypes
        );
      }
      continue;
    }

    if (localTag === 'attributeGroup') {
      const ref = child['@_ref'] ? String(child['@_ref']) : '';
      if (!ref) continue;
      const refQName = resolveTypeQName(ref, nsMap);
      const attrEntry = attributeGroups[refQName];
      if (attrEntry) {
        collectFields(
          attrEntry[0], nsMap, attrEntry[1], attrEntry[2], fields,
          choiceGroup, inheritedCardinality,
          elements, choiceCounter, complexTypes, syntheticTypeContext, groups, attributeGroups, deferredSyntheticTypes
        );
      }
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
      collectFields(ownerNs, nsMap, formDefaults, extension, fields, choiceGroup, inheritedCardinality, elements, choiceCounter, complexTypes, syntheticTypeContext, groups, attributeGroups, deferredSyntheticTypes);
      continue;
    }

    if (localTag === 'complexContent') {
      const derivation = nodeChildren(child).find(([key]) => {
        const local = getNodeTagLocalName(key);
        return local === 'extension' || local === 'restriction';
      })?.[1];
      if (!derivation) {
        continue;
      }
      collectFields(ownerNs, nsMap, formDefaults, derivation, fields, choiceGroup, inheritedCardinality, elements, choiceCounter, complexTypes, syntheticTypeContext, groups, attributeGroups, deferredSyntheticTypes);
    }
  }
};

type DeferredInlineType = {
  typeName: QName;
  container: AnyNode;
  ownerNs: string;
  nsMap: Record<string, string>;
  formDefaults: SchemaFormDefaults;
  groups: Record<string, AnyNode>;
  attributeGroups: Record<string, [string, SchemaFormDefaults, AnyNode]>;
};

type QueueEntry = {
  file: string;
  inheritedTargetNs?: string;
};

type RedefineOverride = {
  kind: 'complexType' | 'simpleType' | 'group' | 'attributeGroup';
  qname: QName;
  node: AnyNode;
  nsMap: Record<string, string>;
  targetNs: string;
  formDefaults: SchemaFormDefaults;
};

export const parseXsd = (files: string[]): XsdIr => {
  const queue: QueueEntry[] = files.map((file) => ({ file: path.resolve(file) }));

  const simpleTypes: Record<string, SimpleTypeDef> = {};
  const complexTypes: Record<string, ComplexTypeDef> = {};
  const elements: Record<string, ElementDef> = {};
  const rootElements: QName[] = [];
  const targetNamespaces = new Set<string>();
  const deferredInlineTypes: DeferredInlineType[] = [];
  const deferredSyntheticTypes: DeferredInlineType[] = [];
  const syntheticTypeCounter = { value: 0 };
  const groups: Record<string, AnyNode> = {};
  const attributeGroups: Record<string, [string, SchemaFormDefaults, AnyNode]> = {};

  // Build import/include graph for topological sorting
  const depGraph: Map<string, string[]> = new Map();

  const addDependency = (from: string, to: string): void => {
    const resolvedFrom = path.resolve(from);
    const resolvedTo = path.resolve(to);
    if (!depGraph.has(resolvedFrom)) depGraph.set(resolvedFrom, []);
    depGraph.get(resolvedFrom)!.push(resolvedTo);
  };

  // First pass: collect all files and their dependencies
  const allFiles: Array<{ entry: QueueEntry; schemaNode: AnyNode; nsMap: Record<string, string>; targetNs: string; formDefaults: SchemaFormDefaults }> = [];

  // Helpers for composite scan keys (file + inherited namespace) so chameleon schemas
  // included by multiple schemas with different target namespaces are scanned once per
  // distinct inherited namespace rather than once globally.
  const scanKey = (file: string, inheritedTargetNs?: string): string =>
    file + '|' + (inheritedTargetNs ?? '');

  {
    const pending = new Map<string, QueueEntry>();
    for (const qe of queue) pending.set(scanKey(qe.file, qe.inheritedTargetNs), qe);
    const scanned = new Set<string>();

    while (pending.size > 0) {
      const firstKey = pending.keys().next().value as string;
      const entry = pending.get(firstKey)!;
      pending.delete(firstKey);
      const entryKey = scanKey(entry.file, entry.inheritedTargetNs);
      if (scanned.has(entryKey)) continue;
      scanned.add(entryKey);

      const { schemaNode, nsMap, targetNs, formDefaults } = readSchema(entry.file);
      allFiles.push({ entry, schemaNode, nsMap, targetNs, formDefaults });

      for (const [tag, child] of nodeChildren(schemaNode)) {
        const localTag = getNodeTagLocalName(tag);
        const schemaLocation = child['@_schemaLocation'] ? String(child['@_schemaLocation']) : '';
        if (!schemaLocation) continue;

        const resolved = path.resolve(path.dirname(entry.file), schemaLocation);
        addDependency(entry.file, resolved);

        if (localTag === 'import' || localTag === 'include' || localTag === 'redefine') {
          const ns = localTag === 'include' ? (targetNs || entry.inheritedTargetNs || '') : undefined;
          const depKey = scanKey(resolved, ns);
          if (scanned.has(depKey)) continue;

          if (!pending.has(depKey)) {
            pending.set(depKey, {
              file: resolved,
              inheritedTargetNs: ns,
            });
          }
        }
      }
    }
  }

  // Topological sort based on dependency graph
  const sorted: string[] = [];
  const permanent = new Set<string>();
  const temporary = new Set<string>();

  const visit = (node: string): void => {
    if (permanent.has(node)) return;
    if (temporary.has(node)) return;
    temporary.add(node);
    const deps = depGraph.get(node) || [];
    for (const dep of deps) {
      visit(dep);
    }
    temporary.delete(node);
    permanent.add(node);
    sorted.push(node);
  };

  for (const f of allFiles) {
    visit(f.entry.file);
  }

  // Re-order allFiles to match topological order
  allFiles.sort((a, b) => {
    const ai = sorted.indexOf(a.entry.file);
    const bi = sorted.indexOf(b.entry.file);
    return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi);
  });

  // Collect redefine overrides keyed by the included schema file path
  const redefineOverrides: Map<string, RedefineOverride[]> = new Map();

  for (const { entry, schemaNode, nsMap: fileNsMap, targetNs: fileTargetNs, formDefaults: fileFormDefaults } of allFiles) {
    const effectiveNs = fileTargetNs || entry.inheritedTargetNs || '';

    if (!fileNsMap[''] && entry.inheritedTargetNs) {
      fileNsMap[''] = entry.inheritedTargetNs;
    }

    const resolveNsMap = { ...fileNsMap, '': effectiveNs || fileNsMap[''] || '' };

    const schemaChildren = nodeChildren(schemaNode);
    const elementNodes: Array<{ node: AnyNode }> = [];
    const complexTypeNodes: Array<{ node: AnyNode }> = [];
    // Pass 1: collect all declarations before processing fields
    for (const [tag, child] of schemaChildren) {
      const localTag = getNodeTagLocalName(tag);

      if (localTag === 'import' || localTag === 'include' || localTag === 'redefine') {
        continue;
      }

      if (localTag === 'simpleType') {
        const name = String(child['@_name'] ?? '');
        if (!name) continue;
        const restriction = nodeChildren(child).find(([key]) => getNodeTagLocalName(key) === 'restriction')?.[1];
        const baseType = resolveTypeQName(restriction?.['@_base'] ? String(restriction['@_base']) : undefined, resolveNsMap);
        const qname = toClark(effectiveNs, name);
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

      if (localTag === 'group') {
        const name = String(child['@_name'] ?? '');
        if (!name) continue;
        const qname = toClark(effectiveNs, name);
        groups[qname] = child;
        continue;
      }

      if (localTag === 'attributeGroup') {
        const name = String(child['@_name'] ?? '');
        if (!name) continue;
        const qname = toClark(effectiveNs, name);
        attributeGroups[qname] = [effectiveNs, fileFormDefaults, child];
        continue;
      }
    }

    // Collect redefine overrides (children of xs:redefine elements)
    for (const [tag, child] of schemaChildren) {
      const localTag = getNodeTagLocalName(tag);
      if (localTag === 'redefine') {
        for (const [rtag, rchild] of nodeChildren(child)) {
          const rlocal = getNodeTagLocalName(rtag);
          const rname = String(rchild['@_name'] ?? '');
          if (!rname) continue;
          if (rlocal === 'complexType' || rlocal === 'simpleType' || rlocal === 'group' || rlocal === 'attributeGroup') {
            const rqname = toClark(effectiveNs, rname);
            const schemaLocation = child['@_schemaLocation'] ? String(child['@_schemaLocation']) : '';
            if (schemaLocation) {
              const resolved = path.resolve(path.dirname(entry.file), schemaLocation);
              if (!redefineOverrides.has(resolved)) redefineOverrides.set(resolved, []);
              redefineOverrides.get(resolved)!.push({
                kind: rlocal,
                qname: rqname,
                node: rchild,
                nsMap: resolveNsMap,
                targetNs: effectiveNs,
                formDefaults: fileFormDefaults,
              });
            }
          }
        }
      }
    }

    // Pass 2: process top-level elements
    for (const { node: child } of elementNodes) {
      const name = String(child['@_name'] ?? '');
      if (!name) continue;

      let typeName = child['@_type'] ? resolveTypeQName(String(child['@_type']), { ...resolveNsMap, '': effectiveNs }) : undefined;

      if (!typeName) {
        const inlineComplex = nodeChildren(child).find(([key]) => getNodeTagLocalName(key) === 'complexType')?.[1];
        if (inlineComplex) {
          typeName = toClark(effectiveNs, `anonymous_${name}_Type`);
          complexTypes[typeName] = { name: typeName, fields: [] };
          deferredInlineTypes.push({ typeName, container: inlineComplex, ownerNs: effectiveNs, nsMap: resolveNsMap, formDefaults: fileFormDefaults, groups, attributeGroups });
        }
      }

      if (!typeName) {
        typeName = toClark(XSD_NS, 'string');
      }

      const qname = toClark(effectiveNs, name);
      elements[qname] = {
        name: qname,
        typeName,
        cardinality: parseCardinality(child),
        nillable: child['@_nillable'] === true || child['@_nillable'] === 'true'
      };
      rootElements.push(qname);
    }

    // Pass 3: process complex types
    for (const { node: child } of complexTypeNodes) {
      const name = String(child['@_name'] ?? '');
      if (!name) continue;
      const qname = toClark(effectiveNs, name);
      const fields: IrField[] = [];
      collectFields(effectiveNs, resolveNsMap, fileFormDefaults, child, fields, undefined, undefined, elements, undefined, complexTypes, { targetNs: effectiveNs, counter: syntheticTypeCounter }, groups, attributeGroups, deferredSyntheticTypes);
      const extension = nodeChildren(child)
        .find(([key]) => getNodeTagLocalName(key) === 'complexContent')?.[1];
      const extensionNode = extension
        ? nodeChildren(extension).find(([key]) => getNodeTagLocalName(key) === 'extension')?.[1]
        : undefined;
      const baseType = extensionNode?.['@_base'] ? resolveTypeQName(String(extensionNode['@_base']), resolveNsMap) : undefined;

      complexTypes[qname] = { name: qname, fields, baseType };
    }
  }

  // Apply redefine overrides — replace or augment types in the included schemas
  for (const [, overrides] of redefineOverrides) {
    for (const override of overrides) {
      if (override.kind === 'complexType') {
        const fields: IrField[] = [];
        collectFields(override.targetNs, override.nsMap, override.formDefaults, override.node, fields, undefined, undefined, elements, undefined, complexTypes, { targetNs: override.targetNs, counter: syntheticTypeCounter }, groups, attributeGroups, deferredSyntheticTypes);
        const complexContent = nodeChildren(override.node)
          .find(([key]) => getNodeTagLocalName(key) === 'complexContent')?.[1];
        const derivationEntry = complexContent
          ? nodeChildren(complexContent).find(([key]) => {
              const local = getNodeTagLocalName(key);
              return local === 'extension' || local === 'restriction';
            })
          : undefined;
        const derivationKind = derivationEntry ? getNodeTagLocalName(derivationEntry[0]) : undefined;
        const derivationNode = derivationEntry?.[1];
        const baseType = derivationNode?.['@_base'] ? resolveTypeQName(String(derivationNode['@_base']), override.nsMap) : undefined;
        if (baseType === override.qname && derivationKind === 'extension') {
          const original = complexTypes[override.qname];
          if (original) {
            complexTypes[override.qname] = { name: override.qname, fields: [...original.fields, ...fields], baseType: original.baseType };
          } else {
            complexTypes[override.qname] = { name: override.qname, fields, baseType: undefined };
          }
        } else if (baseType === override.qname && derivationKind === 'restriction') {
          complexTypes[override.qname] = { name: override.qname, fields, baseType: undefined };
        } else {
          complexTypes[override.qname] = { name: override.qname, fields, baseType };
        }
      } else if (override.kind === 'simpleType') {
        const restriction = nodeChildren(override.node).find(([key]) => getNodeTagLocalName(key) === 'restriction')?.[1];
        const baseType = resolveTypeQName(restriction?.['@_base'] ? String(restriction['@_base']) : undefined, override.nsMap);
        simpleTypes[override.qname] = { name: override.qname, baseType };
      } else if (override.kind === 'group') {
        groups[override.qname] = override.node;
      } else if (override.kind === 'attributeGroup') {
        attributeGroups[override.qname] = [override.targetNs, override.formDefaults, override.node];
      }
    }
  }

  // Process deferred inline types now that all elements are collected
  const processDeferredType = (typeName: QName, container: AnyNode, ownerNs: string, nsMap: Record<string, string>, formDefaults: SchemaFormDefaults, groups: Record<string, AnyNode>, attributeGroups: Record<string, [string, SchemaFormDefaults, AnyNode]>) => {
    const fields: IrField[] = [];
    collectFields(ownerNs, nsMap, formDefaults, container, fields, undefined, undefined, elements, undefined, complexTypes, { targetNs: ownerNs, counter: syntheticTypeCounter }, groups, attributeGroups, deferredSyntheticTypes);
    complexTypes[typeName] = { name: typeName, fields };
  };

  for (const { typeName, container, ownerNs, nsMap, formDefaults, groups, attributeGroups } of deferredInlineTypes) {
    processDeferredType(typeName, container, ownerNs, nsMap, formDefaults, groups, attributeGroups);
  }

  // Process synthetic types created during field collection (deferred so all attributeGroups are available)
  while (deferredSyntheticTypes.length > 0) {
    const entry = deferredSyntheticTypes.shift()!;
    processDeferredType(entry.typeName, entry.container, entry.ownerNs, entry.nsMap, entry.formDefaults, entry.groups, entry.attributeGroups);
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
