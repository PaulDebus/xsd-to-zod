import path from 'node:path';
import XMLParser from '@nodable/flexible-xml-parser';
import { readXmlFile } from './readXmlFile.js';
import { createOutputBuilder } from './runtime.js';
import type {
  Cardinality,
  ComplexTypeDef,
  ElementDef,
  Facet,
  IrField,
  QName,
  SimpleTypeDef,
  XsdIr
} from './types.js';

const XSD_NS = 'http://www.w3.org/2001/XMLSchema';

const parser = new XMLParser({
  skip: { attributes: false },
  attributes: { prefix: '@_' },
  // Decode entities but keep attribute/text lexicals verbatim: default number
  // coercion would corrupt schema values like fixed="1.0" or enum values (#68).
  OutputBuilder: createOutputBuilder()
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

const NUMBER_FACETS = new Set(['length', 'minLength', 'maxLength', 'minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive', 'totalDigits', 'fractionDigits']);

const parseFacets = (restrictionNode: AnyNode): Facet[] => {
  const facets: Facet[] = [];
  for (const [tag, child] of nodeChildren(restrictionNode)) {
    const localTag = getNodeTagLocalName(tag);
    if (localTag === 'enumeration') {
      const val = child['@_value'];
      if (val !== undefined) facets.push({ kind: 'enumeration', value: String(val) });
    } else if (NUMBER_FACETS.has(localTag)) {
      const val = child['@_value'];
      if (val !== undefined) facets.push({ kind: localTag as Facet['kind'], value: Number(val) } as Facet);
    } else if (localTag === 'pattern') {
      const val = child['@_value'];
      if (val !== undefined) facets.push({ kind: 'pattern', value: String(val) });
    } else if (localTag === 'whiteSpace') {
      const val = child['@_value'];
      if (val === 'preserve' || val === 'replace' || val === 'collapse') {
        facets.push({ kind: 'whiteSpace', value: val });
      }
    }
  }
  return facets;
};

const resolveTypeQName = (rawType: string | undefined, nsMap: Record<string, string>, diagnostics: Set<string>): QName => {
  if (!rawType) {
    return toClark(XSD_NS, 'string');
  }
  const { prefix, local } = splitQName(rawType);
  if (prefix !== '' && nsMap[prefix] === undefined) {
    diagnostics.add(`unknown namespace prefix "${prefix}" in QName "${rawType}"`);
  }
  if (prefix === '') {
    return toClark(nsMap[''] ?? '', local);
  }
  return toClark(nsMap[prefix] ?? '', local);
};

// Parse the body of an xs:simpleType declaration (restriction / list / union)
// into a SimpleTypeDef. Inline item/member types are registered in simpleTypes
// under synthetic names derived from qname.
const parseSimpleTypeDef = (
  qname: QName,
  node: AnyNode,
  nsMap: Record<string, string>,
  simpleTypes: Record<string, SimpleTypeDef>,
  diagnostics: Set<string>
): SimpleTypeDef => {
  const description = extractDocumentation(node);
  const listChild = nodeChildren(node).find(([key]) => getNodeTagLocalName(key) === 'list')?.[1];
  if (listChild) {
    const itemTypeRaw = listChild['@_itemType'];
    let itemType: QName;
    if (itemTypeRaw) {
      itemType = resolveTypeQName(String(itemTypeRaw), nsMap, diagnostics);
    } else {
      const inlineSimple = nodeChildren(listChild).find(([key]) => getNodeTagLocalName(key) === 'simpleType')?.[1];
      itemType = inlineSimple
        ? resolveInlineSimpleType(inlineSimple, nsMap, simpleTypes, `${qname}_itemType` as QName, diagnostics)
        : toClark(XSD_NS, 'string');
    }
    return { name: qname, baseType: itemType, itemType, description };
  }

  const unionChild = nodeChildren(node).find(([key]) => getNodeTagLocalName(key) === 'union')?.[1];
  if (unionChild) {
    const memberTypesRaw = unionChild['@_memberTypes'];
    let memberTypes: QName[];
    if (memberTypesRaw) {
      memberTypes = String(memberTypesRaw).split(/\s+/).map(mt => resolveTypeQName(mt, nsMap, diagnostics));
    } else {
      memberTypes = nodeChildren(unionChild)
        .filter(([key]) => getNodeTagLocalName(key) === 'simpleType')
        .map(([, stNode], idx) => resolveInlineSimpleType(stNode, nsMap, simpleTypes, `${qname}_member${idx}` as QName, diagnostics));
    }
    const baseType = memberTypes[0] ?? toClark(XSD_NS, 'string');
    return { name: qname, baseType, memberTypes, description };
  }

  const restriction = nodeChildren(node).find(([key]) => getNodeTagLocalName(key) === 'restriction')?.[1];
  const baseType = resolveTypeQName(restriction?.['@_base'] ? String(restriction['@_base']) : undefined, nsMap, diagnostics);
  const facets = restriction ? parseFacets(restriction) : [];
  return { name: qname, baseType, facets: facets.length > 0 ? facets : undefined, description };
};

const resolveInlineSimpleType = (
  node: AnyNode,
  nsMap: Record<string, string>,
  simpleTypes: Record<string, SimpleTypeDef>,
  syntheticName: QName,
  diagnostics: Set<string>
): QName => {
  simpleTypes[syntheticName] = parseSimpleTypeDef(syntheticName, node, nsMap, simpleTypes, diagnostics);
  return syntheticName;
};

type SyntheticTypeContext = {
  targetNs: string;
  counter: { value: number };
  simpleTypes: Record<string, SimpleTypeDef>;
};

// Register an inline xs:simpleType under a synthetic name. nameHint (an
// element/attribute name) gives readable names at schema level, where names
// are unique; nested occurrences get a counter-based name instead.
const synthesizeInlineSimpleType = (
  inlineSimple: AnyNode,
  nsMap: Record<string, string>,
  ctx: SyntheticTypeContext,
  nameHint: string | undefined,
  diagnostics: Set<string>
): QName => {
  const local = nameHint === undefined
    ? `anonymous_SimpleType${++ctx.counter.value}`
    : `anonymous_${nameHint}_SimpleType`;
  const syntheticName = toClark(ctx.targetNs, local);
  return resolveInlineSimpleType(inlineSimple, nsMap, ctx.simpleTypes, syntheticName, diagnostics);
};

const OCCURS_LEXICAL = /^\d+$/;

const parseOccursValue = (raw: unknown, attr: 'minOccurs' | 'maxOccurs'): number => {
  const text = String(raw).trim();
  if (!OCCURS_LEXICAL.test(text)) {
    throw new Error(`Invalid ${attr} value ${JSON.stringify(text)}: expected a non-negative integer`);
  }
  return Number(text);
};

const parseCardinality = (node: AnyNode): Cardinality => {
  const rawMin = node['@_minOccurs'];
  const rawMax = node['@_maxOccurs'];
  return {
    minOccurs: rawMin === undefined ? 1 : parseOccursValue(rawMin, 'minOccurs'),
    maxOccurs: rawMax === undefined ? 1 : rawMax === 'unbounded' ? 'unbounded' : parseOccursValue(rawMax, 'maxOccurs')
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
  // The xml prefix is implicitly bound and need not be declared (XML Namespaces spec).
  if (!nsMap.xml) {
    nsMap.xml = 'http://www.w3.org/XML/1998/namespace';
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

// Human-readable text from xs:annotation/xs:documentation children, emitted as
// .describe() in the generated schemas (#25). A documentation node parses to a
// plain string when it has no attributes, or an object with #text when it has
// (e.g. xml:lang) — both shapes are handled, multiple entries are joined.
const extractDocumentation = (node: AnyNode): string | undefined => {
  const annotation = nodeChildren(node).find(([key]) => getNodeTagLocalName(key) === 'annotation')?.[1];
  if (!annotation) {
    return undefined;
  }
  const docs: string[] = [];
  for (const [key, value] of Object.entries(annotation)) {
    if (getNodeTagLocalName(key) !== 'documentation') {
      continue;
    }
    for (const entry of asArray(value)) {
      const text = entry && typeof entry === 'object' ? (entry as AnyNode)['#text'] : entry;
      const trimmed = String(text ?? '').trim();
      if (trimmed.length > 0) {
        docs.push(trimmed);
      }
    }
  }
  return docs.length > 0 ? docs.join('\n') : undefined;
};

// A named group/attributeGroup definition plus the namespace context of the
// schema document that defined it: members are resolved and namespaced with
// the defining file's nsMap, target namespace and form defaults, not the
// referencing file's (#94).
type GroupEntry = {
  ownerNs: string;
  formDefaults: SchemaFormDefaults;
  nsMap: Record<string, string>;
  node: AnyNode;
};

/** A global attribute declaration: its type plus documentation (#25). */
type GlobalAttributeDecl = {
  typeName: QName;
  description?: string;
};

// Shared state threaded through field collection — one object instead of a
// dozen positional parameters.
type FieldCollectionContext = {
  nsMap: Record<string, string>;
  formDefaults: SchemaFormDefaults;
  elements: Record<string, ElementDef>;
  choiceCounter: { value: number };
  complexTypes: Record<string, ComplexTypeDef>;
  syntheticTypes: SyntheticTypeContext;
  groups: Record<string, GroupEntry>;
  attributeGroups: Record<string, GroupEntry>;
  deferredSyntheticTypes: DeferredInlineType[];
  /** Global attribute declarations, mapped to their type and documentation. */
  attributes: Record<string, GlobalAttributeDecl>;
  diagnostics: Set<string>;
};

const collectFields = (
  ownerNs: string,
  container: AnyNode,
  fields: IrField[],
  ctx: FieldCollectionContext,
  choiceGroup?: string,
  inheritedCardinality: Cardinality = { minOccurs: 1, maxOccurs: 1 },
  choiceBranch?: string
): void => {
  const { nsMap, formDefaults, elements, complexTypes, syntheticTypes, groups, attributeGroups, deferredSyntheticTypes, attributes, diagnostics } = ctx;
  for (const [tag, child] of nodeChildren(container)) {
    const localTag = getNodeTagLocalName(tag);
    if (localTag === 'element') {
      const name = String(child['@_name'] ?? '');
      const ref = child['@_ref'] ? String(child['@_ref']) : '';
      if (!name && !ref) {
        continue;
      }

      if (ref) {
        const refQName = resolveTypeQName(ref, nsMap, diagnostics);
        const referenced = elements[refQName];
        if (referenced) {
          const effectiveCardinality = combineCardinality(inheritedCardinality, parseCardinality(child));
          const description = extractDocumentation(child) ?? referenced.description;
          fields.push({
            ...effectiveCardinality,
            kind: 'element',
            qname: refQName,
            typeName: referenced.typeName,
            nillable: child['@_nillable'] === true || child['@_nillable'] === 'true' || referenced.nillable === true,
            choiceGroup,
            ...(choiceBranch ? { choiceBranch } : {}),
            ...(child['@_default'] !== undefined ? { defaultValue: String(child['@_default']) } : {}),
            ...(child['@_fixed'] !== undefined ? { fixedValue: String(child['@_fixed']) } : {}),
            ...(description !== undefined ? { description } : {})
          });
        } else {
          diagnostics.add(`unresolved element ref "${refQName}"`);
        }
        continue;
      }

      let typeName: QName;
      if (child['@_type']) {
        // nsMap already maps '' to the declared default xmlns, falling back to
        // the target namespace only when none is declared (#94).
        typeName = resolveTypeQName(String(child['@_type']), nsMap, diagnostics);
      } else {
        const inlineComplex = nodeChildren(child).find(([key]) => getNodeTagLocalName(key) === 'complexType')?.[1];
        const inlineSimple = nodeChildren(child).find(([key]) => getNodeTagLocalName(key) === 'simpleType')?.[1];
        if (inlineComplex) {
          syntheticTypes.counter.value++;
          const syntheticName = toClark(syntheticTypes.targetNs, `anonymous_Type${syntheticTypes.counter.value}`);
          complexTypes[syntheticName] = { name: syntheticName, fields: [] };
          deferredSyntheticTypes.push({ typeName: syntheticName, container: inlineComplex, ownerNs, nsMap, formDefaults });
          typeName = syntheticName;
        } else if (inlineSimple) {
          typeName = synthesizeInlineSimpleType(inlineSimple, nsMap, syntheticTypes, undefined, diagnostics);
        } else {
          typeName = resolveTypeQName(undefined, nsMap, diagnostics);
        }
      }
      const effectiveCardinality = combineCardinality(inheritedCardinality, parseCardinality(child));
      const description = extractDocumentation(child);
      fields.push({
        ...effectiveCardinality,
        kind: 'element',
        qname: toClark(resolveDeclaredFieldNamespace(ownerNs, 'element', child['@_form'], formDefaults), name),
        typeName,
        nillable: child['@_nillable'] === true || child['@_nillable'] === 'true',
        choiceGroup,
        ...(choiceBranch ? { choiceBranch } : {}),
        ...(child['@_default'] !== undefined ? { defaultValue: String(child['@_default']) } : {}),
        ...(child['@_fixed'] !== undefined ? { fixedValue: String(child['@_fixed']) } : {}),
        ...(description !== undefined ? { description } : {})
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
        const refQName = resolveTypeQName(ref, nsMap, diagnostics);
        const referenced = attributes[refQName];
        if (!referenced) {
          diagnostics.add(`unresolved attribute ref "${refQName}"`);
        }
        const description = extractDocumentation(child) ?? referenced?.description;
        fields.push({
          ...combineCardinality(inheritedCardinality, {
            minOccurs: child['@_use'] === 'required' ? 1 : 0,
            maxOccurs: 1
          }),
          kind: 'attribute',
          qname: refQName,
          typeName: referenced?.typeName ?? toClark(XSD_NS, 'string'),
          ...(child['@_default'] !== undefined ? { defaultValue: String(child['@_default']) } : {}),
          ...(child['@_fixed'] !== undefined ? { fixedValue: String(child['@_fixed']) } : {}),
          ...(description !== undefined ? { description } : {})
        });
        continue;
      }

      let attrTypeName: QName;
      if (child['@_type']) {
        attrTypeName = resolveTypeQName(String(child['@_type']), nsMap, diagnostics);
      } else {
        const inlineSimple = nodeChildren(child).find(([key]) => getNodeTagLocalName(key) === 'simpleType')?.[1];
        if (inlineSimple) {
          attrTypeName = synthesizeInlineSimpleType(inlineSimple, nsMap, syntheticTypes, undefined, diagnostics);
        } else {
          attrTypeName = resolveTypeQName(undefined, nsMap, diagnostics);
        }
      }
      const attrDescription = extractDocumentation(child);
      fields.push({
        ...combineCardinality(inheritedCardinality, {
          minOccurs: child['@_use'] === 'required' ? 1 : 0,
          maxOccurs: 1
        }),
        kind: 'attribute',
        qname: toClark(resolveDeclaredFieldNamespace(ownerNs, 'attribute', child['@_form'], formDefaults), name),
        typeName: attrTypeName,
        ...(child['@_default'] !== undefined ? { defaultValue: String(child['@_default']) } : {}),
        ...(child['@_fixed'] !== undefined ? { fixedValue: String(child['@_fixed']) } : {}),
        ...(attrDescription !== undefined ? { description: attrDescription } : {})
      });
      continue;
    }

    if (localTag === 'sequence' || localTag === 'all') {
      collectFields(
        ownerNs,
        child,
        fields,
        ctx,
        choiceGroup,
        combineCardinality(inheritedCardinality, parseCardinality(child)),
        choiceBranch
      );
      continue;
    }

    if (localTag === 'choice') {
      const groupId = `${ctx.choiceCounter.value++}`;
      // Each direct child of the xs:choice is one branch. Branch identity is
      // threaded through as choiceBranch so fields inlined from a group ref or
      // nested compositor stay together as a single branch (#73 / ipo-style
      // shipTo+billTo vs singleAddress choices).
      let branchIndex = 0;
      for (const [branchTag, branchChild] of nodeChildren(child)) {
        const branchLocal = getNodeTagLocalName(branchTag);
        if (branchLocal !== 'element' && branchLocal !== 'group' && branchLocal !== 'sequence' && branchLocal !== 'choice' && branchLocal !== 'all') {
          continue;
        }
        const branchId = `${groupId}.${branchIndex++}`;
        collectFields(
          ownerNs,
          { [branchTag]: branchChild },
          fields,
          ctx,
          groupId,
          combineCardinality(inheritedCardinality, parseCardinality(child)),
          branchId
        );
      }
      continue;
    }

    if (localTag === 'group') {
      const ref = child['@_ref'] ? String(child['@_ref']) : '';
      if (!ref) continue;
      const refQName = resolveTypeQName(ref, nsMap, diagnostics);
      const groupEntry = groups[refQName];
      if (groupEntry) {
        collectFields(
          groupEntry.ownerNs, groupEntry.node, fields,
          { ...ctx, nsMap: groupEntry.nsMap, formDefaults: groupEntry.formDefaults },
          choiceGroup, combineCardinality(inheritedCardinality, parseCardinality(child)), choiceBranch
        );
      } else {
        diagnostics.add(`unresolved group ref "${refQName}"`);
      }
      continue;
    }

    if (localTag === 'attributeGroup') {
      const ref = child['@_ref'] ? String(child['@_ref']) : '';
      if (!ref) continue;
      const refQName = resolveTypeQName(ref, nsMap, diagnostics);
      const attrEntry = attributeGroups[refQName];
      if (attrEntry) {
        collectFields(
          attrEntry.ownerNs, attrEntry.node, fields,
          { ...ctx, nsMap: attrEntry.nsMap, formDefaults: attrEntry.formDefaults },
          choiceGroup, inheritedCardinality, choiceBranch
        );
      } else {
        diagnostics.add(`unresolved attributeGroup ref "${refQName}"`);
      }
      continue;
    }

    if (localTag === 'simpleContent') {
      const derivation = nodeChildren(child).find(([key]) => {
        const local = getNodeTagLocalName(key);
        return local === 'extension' || local === 'restriction';
      })?.[1];
      if (!derivation) {
        continue;
      }
      const baseAttr = derivation['@_base'];
      if (baseAttr && typeof baseAttr === 'string') {
        const baseType = resolveTypeQName(baseAttr, nsMap, diagnostics);
        let textType = baseType;
        const seenAttrs = new Set<string>();
        // Type-level cycle guard: circular simpleContent bases (invalid XSD)
        // would otherwise spin forever once all types are collected (#94).
        const seenTypes = new Set<QName>([baseType]);
        let current = complexTypes[baseType];
        while (current) {
          const tf = current.fields.find(f => f.kind === 'text');
          if (!tf) break;
          for (const f of current.fields) {
            if (f.kind === 'attribute' && !seenAttrs.has(f.qname)) {
              seenAttrs.add(f.qname);
              // Copy the field so the derived type does not alias the base's object.
              fields.push({ ...f });
            }
          }
          textType = tf.typeName;
          if (seenTypes.has(textType)) break;
          seenTypes.add(textType);
          current = complexTypes[textType];
        }
        fields.push({
          ...inheritedCardinality,
          kind: 'text',
          qname: toClark(ownerNs, '_text'),
          typeName: textType
        });
      }
      collectFields(ownerNs, derivation, fields, ctx, choiceGroup, inheritedCardinality, choiceBranch);
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
      collectFields(ownerNs, derivation, fields, ctx, choiceGroup, inheritedCardinality, choiceBranch);
    }
  }
};

// Extract the base type of a complexContent/xs:extension derivation, if any.
const extractExtensionBase = (container: AnyNode, nsMap: Record<string, string>, diagnostics: Set<string>): QName | undefined => {
  const complexContent = nodeChildren(container).find(([key]) => getNodeTagLocalName(key) === 'complexContent')?.[1];
  const extensionNode = complexContent
    ? nodeChildren(complexContent).find(([key]) => getNodeTagLocalName(key) === 'extension')?.[1]
    : undefined;
  return extensionNode?.['@_base'] ? resolveTypeQName(String(extensionNode['@_base']), nsMap, diagnostics) : undefined;
};

type DeferredInlineType = {
  typeName: QName;
  container: AnyNode;
  ownerNs: string;
  nsMap: Record<string, string>;
  formDefaults: SchemaFormDefaults;
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
  const groups: Record<string, GroupEntry> = {};
  const attributeGroups: Record<string, GroupEntry> = {};
  const attributes: Record<string, GlobalAttributeDecl> = {};
  const unresolvedRefs = new Set<string>();

  const fieldContext = (nsMap: Record<string, string>, formDefaults: SchemaFormDefaults, targetNs: string): FieldCollectionContext => ({
    nsMap,
    formDefaults,
    elements,
    choiceCounter: { value: 0 },
    complexTypes,
    syntheticTypes: { targetNs, counter: syntheticTypeCounter, simpleTypes },
    groups,
    attributeGroups,
    deferredSyntheticTypes,
    attributes,
    diagnostics: unresolvedRefs
  });

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

  // Declaration collection (pass 1) is separated from field collection (passes 2-3)
  // so element/group/attributeGroup/attribute references always resolve against the
  // complete declaration maps, regardless of file and CLI argument order (#77).
  type PendingFile = {
    effectiveNs: string;
    resolveNsMap: Record<string, string>;
    formDefaults: SchemaFormDefaults;
    elementNodes: AnyNode[];
    complexTypeNodes: AnyNode[];
  };
  const pendingFiles: PendingFile[] = [];

  for (const { entry, schemaNode, nsMap: fileNsMap, targetNs: fileTargetNs, formDefaults: fileFormDefaults } of allFiles) {
    const effectiveNs = fileTargetNs || entry.inheritedTargetNs || '';
    // Namespace-less schemas contribute no entry — '' would be noise (#79).
    if (effectiveNs) {
      targetNamespaces.add(effectiveNs);
    }

    if (!fileNsMap[''] && entry.inheritedTargetNs) {
      fileNsMap[''] = entry.inheritedTargetNs;
    }

    // Unprefixed type references resolve against the schema document's default
    // namespace when one is declared (e.g. xmlns="...XMLSchema" makes
    // type="string" mean xs:string); the targetNamespace is only a fallback.
    const resolveNsMap = { ...fileNsMap, '': fileNsMap[''] || effectiveNs };

    const schemaChildren = nodeChildren(schemaNode);
    const elementNodes: AnyNode[] = [];
    const complexTypeNodes: AnyNode[] = [];
    // Pass 1: collect all declarations before processing fields
    for (const [tag, child] of schemaChildren) {
      const localTag = getNodeTagLocalName(tag);

      if (localTag === 'import' || localTag === 'include' || localTag === 'redefine') {
        continue;
      }

      if (localTag === 'simpleType') {
        const name = String(child['@_name'] ?? '');
        if (!name) continue;
        const qname = toClark(effectiveNs, name);
        simpleTypes[qname] = parseSimpleTypeDef(qname, child, resolveNsMap, simpleTypes, unresolvedRefs);
        continue;
      }

      if (localTag === 'complexType') {
        complexTypeNodes.push(child);
        continue;
      }

      if (localTag === 'element') {
        elementNodes.push(child);
        continue;
      }

      if (localTag === 'group') {
        const name = String(child['@_name'] ?? '');
        if (!name) continue;
        const qname = toClark(effectiveNs, name);
        groups[qname] = { ownerNs: effectiveNs, formDefaults: fileFormDefaults, nsMap: resolveNsMap, node: child };
        continue;
      }

      if (localTag === 'attributeGroup') {
        const name = String(child['@_name'] ?? '');
        if (!name) continue;
        const qname = toClark(effectiveNs, name);
        attributeGroups[qname] = { ownerNs: effectiveNs, formDefaults: fileFormDefaults, nsMap: resolveNsMap, node: child };
        continue;
      }

      if (localTag === 'attribute') {
        const name = String(child['@_name'] ?? '');
        if (!name) continue;
        const qname = toClark(effectiveNs, name);
        let typeName: QName;
        if (child['@_type']) {
          typeName = resolveTypeQName(String(child['@_type']), resolveNsMap, unresolvedRefs);
        } else {
          const inlineSimple = nodeChildren(child).find(([key]) => getNodeTagLocalName(key) === 'simpleType')?.[1];
          typeName = inlineSimple
            ? synthesizeInlineSimpleType(inlineSimple, resolveNsMap, { targetNs: effectiveNs, counter: syntheticTypeCounter, simpleTypes }, name, unresolvedRefs)
            : toClark(XSD_NS, 'string');
        }
        attributes[qname] = { typeName, description: extractDocumentation(child) };
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

    pendingFiles.push({ effectiveNs, resolveNsMap, formDefaults: fileFormDefaults, elementNodes, complexTypeNodes });
  }

  // Group/attributeGroup redefines must land before any field collection:
  // references to them are inlined into consumers at collection time (#78).
  for (const [, overrides] of redefineOverrides) {
    for (const override of overrides) {
      if (override.kind === 'group') {
        groups[override.qname] = { ownerNs: override.targetNs, formDefaults: override.formDefaults, nsMap: override.nsMap, node: override.node };
      } else if (override.kind === 'attributeGroup') {
        attributeGroups[override.qname] = { ownerNs: override.targetNs, formDefaults: override.formDefaults, nsMap: override.nsMap, node: override.node };
      }
    }
  }

  // Pass 2: process top-level elements
  for (const { effectiveNs, resolveNsMap, formDefaults: fileFormDefaults, elementNodes } of pendingFiles) {
    for (const child of elementNodes) {
      const name = String(child['@_name'] ?? '');
      if (!name) continue;

      let typeName = child['@_type'] ? resolveTypeQName(String(child['@_type']), resolveNsMap, unresolvedRefs) : undefined;

      if (!typeName) {
        const inlineComplex = nodeChildren(child).find(([key]) => getNodeTagLocalName(key) === 'complexType')?.[1];
        if (inlineComplex) {
          typeName = toClark(effectiveNs, `anonymous_${name}_Type`);
          complexTypes[typeName] = { name: typeName, fields: [] };
          deferredInlineTypes.push({ typeName, container: inlineComplex, ownerNs: effectiveNs, nsMap: resolveNsMap, formDefaults: fileFormDefaults });
        }
      }

      if (!typeName) {
        const inlineSimple = nodeChildren(child).find(([key]) => getNodeTagLocalName(key) === 'simpleType')?.[1];
        if (inlineSimple) {
          typeName = synthesizeInlineSimpleType(inlineSimple, resolveNsMap, { targetNs: effectiveNs, counter: syntheticTypeCounter, simpleTypes }, name, unresolvedRefs);
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
        nillable: child['@_nillable'] === true || child['@_nillable'] === 'true',
        description: extractDocumentation(child)
      };
      if (!rootElements.includes(qname)) {
        rootElements.push(qname);
      }
    }
  }

  // Pass 3: process complex types — references resolve against all files' declarations
  for (const { effectiveNs, resolveNsMap, formDefaults: fileFormDefaults, complexTypeNodes } of pendingFiles) {
    for (const child of complexTypeNodes) {
      const name = String(child['@_name'] ?? '');
      if (!name) continue;
      const qname = toClark(effectiveNs, name);
      const fields: IrField[] = [];
      collectFields(effectiveNs, child, fields, fieldContext(resolveNsMap, fileFormDefaults, effectiveNs));
      const baseType = extractExtensionBase(child, resolveNsMap, unresolvedRefs);

      complexTypes[qname] = { name: qname, fields, baseType, description: extractDocumentation(child) };
    }
  }

  // Apply redefine overrides — replace or augment types in the included schemas
  for (const [, overrides] of redefineOverrides) {
    for (const override of overrides) {
      if (override.kind === 'complexType') {
        const fields: IrField[] = [];
        collectFields(override.targetNs, override.node, fields, fieldContext(override.nsMap, override.formDefaults, override.targetNs));
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
        const baseType = derivationNode?.['@_base'] ? resolveTypeQName(String(derivationNode['@_base']), override.nsMap, unresolvedRefs) : undefined;
        const description = extractDocumentation(override.node);
        if (baseType === override.qname && derivationKind === 'extension') {
          const original = complexTypes[override.qname];
          if (original) {
            complexTypes[override.qname] = { name: override.qname, fields: [...original.fields, ...fields], baseType: original.baseType, description: description ?? original.description };
          } else {
            complexTypes[override.qname] = { name: override.qname, fields, baseType: undefined, description };
          }
        } else if (baseType === override.qname && derivationKind === 'restriction') {
          complexTypes[override.qname] = { name: override.qname, fields, baseType: undefined, description };
        } else {
          complexTypes[override.qname] = { name: override.qname, fields, baseType, description };
        }
      } else if (override.kind === 'simpleType') {
        // Drop synthetic inline item/member types created for the previous definition
        // so swapping list ↔ union (or changing item/member shape) does not leave orphans.
        const orphanPrefix = `${override.qname}_`;
        for (const existingName of Object.keys(simpleTypes)) {
          if (existingName.startsWith(orphanPrefix)) {
            delete simpleTypes[existingName];
          }
        }

        simpleTypes[override.qname] = parseSimpleTypeDef(override.qname, override.node, override.nsMap, simpleTypes, unresolvedRefs);
      }
    }
  }

  // Process deferred inline types now that all elements are collected
  const processDeferredType = ({ typeName, container, ownerNs, nsMap, formDefaults }: DeferredInlineType) => {
    const fields: IrField[] = [];
    collectFields(ownerNs, container, fields, fieldContext(nsMap, formDefaults, ownerNs));
    complexTypes[typeName] = { name: typeName, fields, baseType: extractExtensionBase(container, nsMap, unresolvedRefs) };
  };

  for (const deferred of deferredInlineTypes) {
    processDeferredType(deferred);
  }

  // Process synthetic types created during field collection (deferred so all attributeGroups are available)
  while (deferredSyntheticTypes.length > 0) {
    processDeferredType(deferredSyntheticTypes.shift()!);
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
      // Extension cycle (invalid XSD): cut it instead of re-appending the
      // repeated type's fields, which outer frames have already collected.
      return [];
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
    unresolvedRefs: [...unresolvedRefs],
    simpleTypes,
    complexTypes: mergedComplexTypes,
    elements,
    rootElements
  };
};

export const clarkToLocal = (qname: QName): string => fromClark(qname).local;
