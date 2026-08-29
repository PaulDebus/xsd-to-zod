import path from "node:path";
import XMLParser from "@nodable/flexible-xml-parser";
import { childOrderOf } from "./documentOrder.js";
import { Xsd2ZodError } from "./errors.js";
import { sanitizeIdentifier } from "./irToZod.js";
import { clarkToLocal, splitQName, syntheticChildName, toClark } from "./qname.js";
import { readXmlFile } from "./readXmlFile.js";
import { createOutputBuilder, normalizeLineEndings } from "./runtime.js";
import type {
  Cardinality,
  ChoiceGroupGuard,
  ComplexTypeDef,
  Diagnostic,
  DiagnosticKind,
  ElementDef,
  Facet,
  IrField,
  QName,
  SimpleTypeDef,
  WildcardDef,
  XsdIr,
} from "./types.js";

const XSD_NS = "http://www.w3.org/2001/XMLSchema";

// Append a diagnostic, deduped by kind+message (the message already embeds
// the ref) so a repeated hit of the same problem reports once.
const diagnosticKeys = new WeakMap<Diagnostic[], Set<string>>();
const report = (
  diagnostics: Diagnostic[],
  kind: DiagnosticKind,
  message: string,
  ref?: string,
): void => {
  const key = `${kind}|${message}`;
  let seen = diagnosticKeys.get(diagnostics);
  if (!seen) {
    seen = new Set<string>();
    diagnosticKeys.set(diagnostics, seen);
  }
  if (!seen.has(key)) {
    seen.add(key);
    diagnostics.push({ kind, message, ...optProp("ref", ref) });
  }
};

const parser = new XMLParser({
  skip: { attributes: false },
  attributes: { prefix: "@_" },
  // Decode entities but keep attribute/text lexicals verbatim: default number
  // coercion would corrupt schema values like fixed="1.0" or enum values (#68).
  OutputBuilder: createOutputBuilder(),
});

// Expand general entities declared in the document's internal DTD subset.
// The parser only knows the predefined entities, but some schemas (the wg
// IRI type library) build pattern facets from <!ENTITY> declarations.
// First declaration wins (XML spec); references nest, so expansion recurses
// with a cycle guard.
const expandInternalEntities = (xml: string): string => {
  const doctype = /<!DOCTYPE[^>[]*\[([\s\S]*?)\]\s*>/.exec(xml);
  const subset = doctype?.[1];
  if (subset === undefined) {
    return xml;
  }
  const entities = new Map<string, string>();
  for (const m of subset.matchAll(/<!ENTITY\s+([^\s%]+)\s+"([^"]*)"\s*>/g)) {
    const name = m[1];
    if (name !== undefined && !entities.has(name)) {
      entities.set(name, m[2] ?? "");
    }
  }
  if (entities.size === 0) {
    return xml;
  }
  const expand = (value: string, seen: Set<string>): string =>
    value.replace(/&([^\s;&]+);/g, (ref, name: string) => {
      const replacement = entities.get(name);
      if (replacement === undefined || seen.has(name)) {
        return ref;
      }
      return expand(replacement, new Set(seen).add(name));
    });
  const doctypeStart = doctype?.index ?? 0;
  const head = xml.slice(0, doctypeStart + (doctype?.[0].length ?? 0));
  return head + expand(xml.slice(head.length), new Set());
};

type AnyNode = Record<string, unknown>;
type FormDefault = "qualified" | "unqualified";
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

const sanitizeTsIdentifier = sanitizeIdentifier;

const optProp = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  value === undefined ? {} : ({ [key]: value } as { [P in K]: V });

const NUMBER_FACETS = new Set([
  "length",
  "minLength",
  "maxLength",
  "totalDigits",
  "fractionDigits",
]);

// Order-facet values stay raw lexicals so bounds beyond MAX_SAFE_INTEGER keep
// their precision into codegen (see Facet in types.ts).
const LEXICAL_FACETS = new Set(["minInclusive", "maxInclusive", "minExclusive", "maxExclusive"]);

const parseFacets = (restrictionNode: AnyNode): Facet[] => {
  const facets: Facet[] = [];
  for (const [tag, child] of nodeChildren(restrictionNode)) {
    const localTag = getNodeTagLocalName(tag);
    if (localTag === "enumeration") {
      const val = child["@_value"];
      if (val !== undefined) {
        facets.push({ kind: "enumeration", value: String(val) });
      }
    } else if (NUMBER_FACETS.has(localTag)) {
      const val = child["@_value"];
      if (val !== undefined) {
        facets.push({
          kind: localTag as Facet["kind"],
          value: Number(val),
        } as Facet);
      }
    } else if (LEXICAL_FACETS.has(localTag)) {
      const val = child["@_value"];
      if (val !== undefined) {
        facets.push({
          kind: localTag as Facet["kind"],
          value: String(val).trim(),
        } as Facet);
      }
    } else if (localTag === "pattern") {
      const val = child["@_value"];
      if (val !== undefined) {
        facets.push({ kind: "pattern", value: String(val) });
      }
    } else if (localTag === "whiteSpace") {
      const val = child["@_value"];
      if (val === "preserve" || val === "replace" || val === "collapse") {
        facets.push({ kind: "whiteSpace", value: val });
      }
    }
  }
  return facets;
};

const resolveTypeQName = (
  rawType: string | undefined,
  nsMap: Record<string, string>,
  diagnostics: Diagnostic[],
): QName => {
  if (!rawType) {
    return toClark(XSD_NS, "string");
  }
  const { prefix, local } = splitQName(rawType);
  if (prefix !== "" && nsMap[prefix] === undefined) {
    report(
      diagnostics,
      "unknown-namespace-prefix",
      `unknown namespace prefix "${prefix}" in QName "${rawType}"`,
      rawType,
    );
  }
  if (prefix === "") {
    return toClark(nsMap[""] ?? "", local);
  }
  return toClark(nsMap[prefix] ?? "", local);
};

// Parse the body of an xs:simpleType declaration (restriction / list / union)
// into a SimpleTypeDef. Inline item/member types are registered in simpleTypes
// under synthetic names derived from qname.
const parseSimpleTypeDef = (
  qname: QName,
  node: AnyNode,
  nsMap: Record<string, string>,
  simpleTypes: Record<string, SimpleTypeDef>,
  diagnostics: Diagnostic[],
): SimpleTypeDef => {
  const description = extractDocumentation(node);
  const listChild = nodeChildren(node).find(([key]) => getNodeTagLocalName(key) === "list")?.[1];
  if (listChild) {
    const itemTypeRaw = listChild["@_itemType"];
    let itemType: QName;
    if (itemTypeRaw) {
      itemType = resolveTypeQName(String(itemTypeRaw), nsMap, diagnostics);
    } else {
      const inlineSimple = nodeChildren(listChild).find(
        ([key]) => getNodeTagLocalName(key) === "simpleType",
      )?.[1];
      itemType = inlineSimple
        ? resolveInlineSimpleType(
            inlineSimple,
            nsMap,
            simpleTypes,
            syntheticChildName(qname, "_itemType"),
            diagnostics,
          )
        : toClark(XSD_NS, "string");
    }
    return {
      name: qname,
      kind: "list",
      itemType,
      ...optProp("description", description),
    };
  }

  const unionChild = nodeChildren(node).find(([key]) => getNodeTagLocalName(key) === "union")?.[1];
  if (unionChild) {
    // Members are the memberTypes attribute's refs followed by the inline
    // xs:simpleType children, in order (XSD 1.0 §4.1.2.3).
    const memberTypesRaw = unionChild["@_memberTypes"];
    const memberTypes: QName[] = memberTypesRaw
      ? String(memberTypesRaw)
          .split(/\s+/)
          .map((mt) => resolveTypeQName(mt, nsMap, diagnostics))
      : [];
    for (const [key, stNode] of nodeChildren(unionChild)) {
      if (getNodeTagLocalName(key) !== "simpleType") {
        continue;
      }
      memberTypes.push(
        resolveInlineSimpleType(
          stNode,
          nsMap,
          simpleTypes,
          syntheticChildName(qname, `_member${memberTypes.length}`),
          diagnostics,
        ),
      );
    }
    return {
      name: qname,
      kind: "union",
      memberTypes,
      ...optProp("description", description),
    };
  }

  const restriction = nodeChildren(node).find(
    ([key]) => getNodeTagLocalName(key) === "restriction",
  )?.[1];
  const baseType = resolveTypeQName(
    restriction?.["@_base"] ? String(restriction["@_base"]) : undefined,
    nsMap,
    diagnostics,
  );
  const facets = restriction ? parseFacets(restriction) : [];
  return {
    name: qname,
    kind: "restriction",
    baseType,
    ...(facets.length > 0 ? { facets } : {}),
    ...optProp("description", description),
  };
};

const resolveInlineSimpleType = (
  node: AnyNode,
  nsMap: Record<string, string>,
  simpleTypes: Record<string, SimpleTypeDef>,
  syntheticName: QName,
  diagnostics: Diagnostic[],
): QName => {
  simpleTypes[syntheticName] = parseSimpleTypeDef(
    syntheticName,
    node,
    nsMap,
    simpleTypes,
    diagnostics,
  );
  return syntheticName;
};

type SyntheticTypeContext = {
  targetNs: string;
  counter: { value: number };
  simpleTypes: Record<string, SimpleTypeDef>;
  complexTypes: Record<string, ComplexTypeDef>;
};

const uniqueSyntheticLocal = (
  base: string,
  targetNs: string,
  simpleTypes: Record<string, SimpleTypeDef>,
  complexTypes: Record<string, ComplexTypeDef>,
): string => {
  let candidate = base;
  let n = 2;
  while (simpleTypes[toClark(targetNs, candidate)] || complexTypes[toClark(targetNs, candidate)]) {
    candidate = `${base}_${n++}`;
  }
  return candidate;
};

// Register an inline xs:simpleType under a synthetic name. nameHint (an
// element/attribute name) gives readable names at schema level, where names
// are unique; nested occurrences get a counter-based name instead.
const synthesizeInlineSimpleType = (
  inlineSimple: AnyNode,
  nsMap: Record<string, string>,
  ctx: SyntheticTypeContext,
  nameHint: string | undefined,
  diagnostics: Diagnostic[],
  descriptive = false,
): QName => {
  let local: string;
  if (nameHint === undefined) {
    local = `anonymous_SimpleType${++ctx.counter.value}`;
  } else if (descriptive) {
    local = `${sanitizeTsIdentifier(nameHint)}_SimpleType`;
  } else {
    local = `anonymous_${sanitizeTsIdentifier(nameHint)}_SimpleType`;
  }
  const candidate = uniqueSyntheticLocal(local, ctx.targetNs, ctx.simpleTypes, ctx.complexTypes);
  return resolveInlineSimpleType(
    inlineSimple,
    nsMap,
    ctx.simpleTypes,
    toClark(ctx.targetNs, candidate),
    diagnostics,
  );
};

const OCCURS_LEXICAL = /^\d+$/;

const parseOccursValue = (raw: unknown, attr: "minOccurs" | "maxOccurs"): number => {
  const text = String(raw).trim();
  if (!OCCURS_LEXICAL.test(text)) {
    throw new Xsd2ZodError(
      "invalid-occurs",
      `Invalid ${attr} value ${JSON.stringify(text)}: expected a non-negative integer`,
    );
  }
  return Number(text);
};

const parseCardinality = (node: AnyNode): Cardinality => {
  const rawMin = node["@_minOccurs"];
  const rawMax = node["@_maxOccurs"];
  return {
    minOccurs: rawMin === undefined ? 1 : parseOccursValue(rawMin, "minOccurs"),
    maxOccurs:
      rawMax === undefined
        ? 1
        : rawMax === "unbounded"
          ? "unbounded"
          : parseOccursValue(rawMax, "maxOccurs"),
  };
};

const multiplyMaxOccurs = (
  left: Cardinality["maxOccurs"],
  right: Cardinality["maxOccurs"],
): Cardinality["maxOccurs"] => {
  if (left === 0 || right === 0) {
    return 0;
  }
  if (left === "unbounded" || right === "unbounded") {
    return "unbounded";
  }
  return left * right;
};

const combineCardinality = (parent: Cardinality, own: Cardinality): Cardinality => ({
  minOccurs: parent.minOccurs * own.minOccurs,
  maxOccurs: multiplyMaxOccurs(parent.maxOccurs, own.maxOccurs),
});

const normalizeFormDefault = (raw: unknown, fallback: FormDefault): FormDefault =>
  raw === "qualified" || raw === "unqualified" ? raw : fallback;

const resolveDeclaredFieldNamespace = (
  ownerNs: string,
  fieldKind: "attribute" | "element",
  formValue: unknown,
  formDefaults: SchemaFormDefaults,
): string => {
  const fallback = fieldKind === "attribute" ? formDefaults.attribute : formDefaults.element;
  const effectiveForm = normalizeFormDefault(formValue, fallback);
  return effectiveForm === "qualified" ? ownerNs : "";
};

const collectNamespaceMap = (schemaNode: AnyNode): Record<string, string> => {
  const nsMap: Record<string, string> = {};
  for (const [key, value] of Object.entries(schemaNode)) {
    if (!key.startsWith("@_xmlns")) {
      continue;
    }
    const suffix = key.slice("@_xmlns".length);
    const prefix = suffix.startsWith(":") ? suffix.slice(1) : "";
    nsMap[prefix] = String(value);
  }
  if (!nsMap["xs"]) {
    nsMap["xs"] = XSD_NS;
  }
  // The xml prefix is implicitly bound and need not be declared (XML Namespaces spec).
  if (!nsMap["xml"]) {
    nsMap["xml"] = "http://www.w3.org/XML/1998/namespace";
  }
  return nsMap;
};

const getNodeTagLocalName = (tag: string): string => splitQName(tag).local;

const readSchema = (
  filePath: string,
): {
  schemaNode: AnyNode;
  nsMap: Record<string, string>;
  targetNs: string;
  formDefaults: SchemaFormDefaults;
} => {
  const xml = normalizeLineEndings(expandInternalEntities(readXmlFile(filePath)));
  const parsed = parser.parse(xml) as Record<string, AnyNode>;
  const schemaEntry = Object.entries(parsed).find(([key]) => getNodeTagLocalName(key) === "schema");
  if (!schemaEntry) {
    throw new Xsd2ZodError("no-schema-root", `No schema root found in ${filePath}`, {
      file: filePath,
    });
  }
  const schemaNode = schemaEntry[1];
  const nsMap = collectNamespaceMap(schemaNode);
  const targetNs = String(schemaNode["@_targetNamespace"] ?? "");
  const formDefaults: SchemaFormDefaults = {
    element: normalizeFormDefault(schemaNode["@_elementFormDefault"], "unqualified"),
    attribute: normalizeFormDefault(schemaNode["@_attributeFormDefault"], "unqualified"),
  };
  return { schemaNode, nsMap, targetNs, formDefaults };
};

const collectChildren = (entries: Iterable<[string, unknown]>): [string, AnyNode][] => {
  const out: [string, AnyNode][] = [];
  for (const [key, value] of entries) {
    if (key.startsWith("@_") || key === "#text") {
      continue;
    }
    for (const entry of asArray(value as AnyNode | AnyNode[])) {
      if (entry && typeof entry === "object") {
        out.push([key, entry as AnyNode]);
      }
    }
  }
  return out;
};

const nodeChildren = (node: AnyNode): [string, AnyNode][] => collectChildren(Object.entries(node));

// Document-order children, when the parser's order tracking is available
// (see childOrderOf): the grouped shape from nodeChildren loses cross-tag
// order, which particle order — e.g. wildcard positions — depends on.
// Falls back to the grouped iteration for programmatically built nodes.
const nodeChildrenOrdered = (node: AnyNode): [string, AnyNode][] => {
  const order = childOrderOf(node);
  return order === undefined
    ? nodeChildren(node)
    : collectChildren(order as Iterable<[string, unknown]>);
};

const pushChild = (node: AnyNode, tag: string, child: AnyNode): void => {
  const existing = node[tag];
  if (existing === undefined) {
    node[tag] = child;
  } else if (Array.isArray(existing)) {
    existing.push(child);
  } else {
    node[tag] = [existing, child];
  }
};

// Expand xs:redefine self-refs to the original definition before override.
const expandRedefineSelfRefs = (
  node: AnyNode,
  refTag: "group" | "attributeGroup",
  selfQName: QName,
  original: AnyNode | undefined,
  nsMap: Record<string, string>,
  diagnostics: Diagnostic[],
): AnyNode => {
  const rebuild = (current: AnyNode): AnyNode => {
    const out: AnyNode = {};
    for (const [key, value] of Object.entries(current)) {
      if (key.startsWith("@_") || key === "#text") {
        out[key] = value;
        continue;
      }
      for (const child of asArray(value as AnyNode | AnyNode[])) {
        if (!child || typeof child !== "object") {
          continue;
        }
        const childNode = child as AnyNode;
        const ref = childNode["@_ref"];
        if (
          getNodeTagLocalName(key) === refTag &&
          ref !== undefined &&
          resolveTypeQName(String(ref), nsMap, diagnostics) === selfQName
        ) {
          if (original === undefined) {
            report(
              diagnostics,
              "circular-redefinition",
              `circular ${refTag} redefinition "${selfQName}" without an original definition`,
              selfQName,
            );
            continue;
          }
          for (const [origTag, origChild] of nodeChildren(structuredClone(original))) {
            pushChild(out, origTag, origChild);
          }
          continue;
        }
        pushChild(out, key, rebuild(childNode));
      }
    }
    return out;
  };
  return rebuild(structuredClone(node));
};

// Break simple-type derivation cycles (invalid XSD) so codegen doesn't emit self-referencing consts.
const dropCircularSimpleTypeRefs = (
  simpleTypes: Record<string, SimpleTypeDef>,
  diagnostics: Diagnostic[],
): void => {
  const onStack = new Set<string>();
  const done = new Set<string>();
  const dropped = new Set<string>();
  const visit = (name: string): void => {
    if (done.has(name)) {
      return;
    }
    const type = simpleTypes[name];
    if (type === undefined) {
      done.add(name);
      return;
    }
    onStack.add(name);
    if (type.kind === "union") {
      type.memberTypes = type.memberTypes.filter((member) => {
        if (onStack.has(member)) {
          report(
            diagnostics,
            "circular-union-member",
            `circular union member "${member}" dropped from union "${name}"`,
            member,
          );
          return false;
        }
        visit(member);
        return !dropped.has(member);
      });
    } else {
      const dep = type.kind === "list" ? type.itemType : type.baseType;
      if (onStack.has(dep)) {
        report(
          diagnostics,
          "circular-derivation",
          `circular ${type.kind} "${name}" dropped (derives from itself through "${dep}")`,
          name,
        );
        delete simpleTypes[name];
        dropped.add(name);
      } else {
        visit(dep);
      }
    }
    onStack.delete(name);
    done.add(name);
  };
  for (const name of Object.keys(simpleTypes)) {
    visit(name);
  }
};

// Human-readable text from xs:annotation/xs:documentation children, emitted as
// .describe() in the generated schemas (#25). A documentation node parses to a
// plain string when it has no attributes, or an object with #text when it has
// (e.g. xml:lang) — both shapes are handled, multiple entries are joined.
const extractDocumentation = (node: AnyNode): string | undefined => {
  const annotation = nodeChildren(node).find(
    ([key]) => getNodeTagLocalName(key) === "annotation",
  )?.[1];
  if (!annotation) {
    return undefined;
  }
  const docs: string[] = [];
  for (const [key, value] of Object.entries(annotation)) {
    if (getNodeTagLocalName(key) !== "documentation") {
      continue;
    }
    for (const entry of asArray(value)) {
      const text = entry && typeof entry === "object" ? (entry as AnyNode)["#text"] : entry;
      const trimmed = String(text ?? "").trim();
      if (trimmed.length > 0) {
        docs.push(trimmed);
      }
    }
  }
  return docs.length > 0 ? docs.join("\n") : undefined;
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
  choiceGroupCardinality: Map<string, Cardinality>;
  choiceGroupGuards: Map<string, ChoiceGroupGuard>;
  complexTypes: Record<string, ComplexTypeDef>;
  syntheticTypes: SyntheticTypeContext;
  groups: Record<string, GroupEntry>;
  attributeGroups: Record<string, GroupEntry>;
  deferredSyntheticTypes: DeferredInlineType[];
  /** Global attribute declarations, mapped to their type and documentation. */
  attributes: Record<string, GlobalAttributeDecl>;
  diagnostics: Diagnostic[];
  allowMissingImports: boolean;
  /** Tracks group / attributeGroup refs currently being expanded to prevent infinite recursion. */
  expansionStack: {
    groups: Set<string>;
    attributeGroups: Set<string>;
  };
};

// Shared shape for ref-based element fields.  The resolved-ref and
// fallback-ref paths diverge only in typeName source, nillable origin and
// optional metadata — this factory collapses the common structure.
const buildRefField = (
  effectiveCardinality: Cardinality,
  qname: QName,
  typeName: QName,
  nillable: boolean,
  choiceGroup: string | undefined,
  choiceBranch: string | undefined,
): IrField => ({
  ...effectiveCardinality,
  kind: "element",
  qname,
  typeName,
  nillable,
  ...optProp("choiceGroup", choiceGroup),
  ...optProp("choiceBranch", choiceBranch),
});

type CollectFieldsScope = {
  ownerNs: string;
  fields: IrField[];
  wildcards: WildcardDef[];
  choiceGroup?: string;
  inheritedCardinality: Cardinality;
  choiceBranch?: string;
  parentTypeName?: string;
};

const expandGroupRef = (
  refQName: QName,
  entry: GroupEntry | undefined,
  ctx: FieldCollectionContext,
  scope: CollectFieldsScope,
  kind: "group" | "attributeGroup",
  unresolvedKind: DiagnosticKind,
  unresolvedPrefix: string,
  circularKind: DiagnosticKind,
): void => {
  const stack = kind === "group" ? ctx.expansionStack.groups : ctx.expansionStack.attributeGroups;
  if (stack.has(refQName)) {
    report(ctx.diagnostics, circularKind, `circular ${kind} ref "${refQName}" dropped`, refQName);
    return;
  }
  if (!entry) {
    report(ctx.diagnostics, unresolvedKind, `${unresolvedPrefix} "${refQName}"`, refQName);
    return;
  }
  stack.add(refQName);
  collectFields(
    entry.node,
    {
      ...ctx,
      nsMap: entry.nsMap,
      formDefaults: entry.formDefaults,
    },
    {
      ...scope,
      ownerNs: entry.ownerNs,
      parentTypeName: scope.parentTypeName ?? clarkToLocal(refQName),
    },
  );
  stack.delete(refQName);
};

const valueConstraints = (node: AnyNode): Pick<IrField, "defaultValue" | "fixedValue"> => ({
  ...(node["@_default"] !== undefined && { defaultValue: String(node["@_default"]) }),
  ...(node["@_fixed"] !== undefined && { fixedValue: String(node["@_fixed"]) }),
});

const attributeCardinality = (node: AnyNode, inherited: Cardinality): Cardinality =>
  combineCardinality(inherited, {
    minOccurs: node["@_use"] === "required" ? 1 : 0,
    maxOccurs: 1,
  });

const nestedScope = (
  scope: CollectFieldsScope,
  inheritedCardinality: Cardinality,
): CollectFieldsScope => ({
  ownerNs: scope.ownerNs,
  fields: scope.fields,
  wildcards: scope.wildcards,
  ...optProp("choiceGroup", scope.choiceGroup),
  inheritedCardinality,
  ...optProp("choiceBranch", scope.choiceBranch),
  ...optProp("parentTypeName", scope.parentTypeName),
});

const findDerivation = (node: AnyNode): AnyNode | undefined =>
  nodeChildren(node).find(([key]) => {
    const local = getNodeTagLocalName(key);
    return local === "extension" || local === "restriction";
  })?.[1];

// Inline xs:simpleType of a nested element/attribute: named after the owning
// type and field when inside a named type, anonymous at schema level.
const synthesizeFieldSimpleType = (
  inlineSimple: AnyNode,
  name: string,
  ctx: FieldCollectionContext,
  scope: CollectFieldsScope,
): QName => {
  const hint = scope.parentTypeName
    ? `${sanitizeTsIdentifier(scope.parentTypeName)}_${sanitizeTsIdentifier(name)}`
    : undefined;
  return synthesizeInlineSimpleType(
    inlineSimple,
    ctx.nsMap,
    ctx.syntheticTypes,
    hint,
    ctx.diagnostics,
    scope.parentTypeName !== undefined,
  );
};

// Register an element's inline xs:complexType under a synthetic name and defer
// its field collection until all declarations are known.
const registerInlineComplexType = (
  inlineComplex: AnyNode,
  name: string,
  ctx: FieldCollectionContext,
  scope: CollectFieldsScope,
): QName => {
  let local: string;
  if (scope.parentTypeName) {
    local = `${sanitizeTsIdentifier(scope.parentTypeName)}_${sanitizeTsIdentifier(name)}_Type`;
  } else {
    ctx.syntheticTypes.counter.value++;
    local = `anonymous_Type${ctx.syntheticTypes.counter.value}`;
  }
  const candidate = uniqueSyntheticLocal(
    local,
    ctx.syntheticTypes.targetNs,
    ctx.syntheticTypes.simpleTypes,
    ctx.complexTypes,
  );
  const syntheticName = toClark(ctx.syntheticTypes.targetNs, candidate);
  ctx.complexTypes[syntheticName] = { name: syntheticName, fields: [] };
  ctx.deferredSyntheticTypes.push({
    typeName: syntheticName,
    container: inlineComplex,
    ownerNs: scope.ownerNs,
    nsMap: ctx.nsMap,
    formDefaults: ctx.formDefaults,
  });
  return syntheticName;
};

const resolveElementTypeName = (
  child: AnyNode,
  name: string,
  ctx: FieldCollectionContext,
  scope: CollectFieldsScope,
): QName => {
  if (child["@_type"]) {
    // nsMap already maps '' to the declared default xmlns, falling back to
    // the target namespace only when none is declared (#94).
    return resolveTypeQName(String(child["@_type"]), ctx.nsMap, ctx.diagnostics);
  }
  const inlineComplex = nodeChildren(child).find(
    ([key]) => getNodeTagLocalName(key) === "complexType",
  )?.[1];
  if (inlineComplex) {
    return registerInlineComplexType(inlineComplex, name, ctx, scope);
  }
  const inlineSimple = nodeChildren(child).find(
    ([key]) => getNodeTagLocalName(key) === "simpleType",
  )?.[1];
  if (inlineSimple) {
    return synthesizeFieldSimpleType(inlineSimple, name, ctx, scope);
  }
  // An element with no type declaration is xs:anyType — open content.
  return toClark(XSD_NS, "anyType");
};

// Namespace declarations local to one schema node (e.g. xmlns:imp on the
// xsd:element itself) — QName-valued attributes resolve against these too.
const localNsDeclarations = (node: AnyNode): Record<string, string> => {
  const decls: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "@_xmlns") {
      decls[""] = String(value);
    } else if (key.startsWith("@_xmlns:")) {
      decls[key.slice("@_xmlns:".length)] = String(value);
    }
  }
  return decls;
};

const collectElementRef = (
  child: AnyNode,
  ref: string,
  ctx: FieldCollectionContext,
  scope: CollectFieldsScope,
): void => {
  const refQName = resolveTypeQName(
    ref,
    { ...ctx.nsMap, ...localNsDeclarations(child) },
    ctx.diagnostics,
  );
  // Unprefixed refs resolve against the target namespace when no default
  // xmlns is declared; a no-namespace imported element still matches.
  const resolvedQName = ctx.elements[refQName] ? refQName : toClark("", clarkToLocal(refQName));
  const referenced = ctx.elements[resolvedQName];
  if (!referenced) {
    report(
      ctx.diagnostics,
      "unresolved-element-ref",
      `unresolved element ref "${refQName}"`,
      refQName,
    );
    if (ctx.allowMissingImports) {
      scope.fields.push(
        buildRefField(
          combineCardinality(scope.inheritedCardinality, parseCardinality(child)),
          refQName,
          refQName,
          child["@_nillable"] === true || child["@_nillable"] === "true",
          scope.choiceGroup,
          scope.choiceBranch,
        ),
      );
    }
    return;
  }
  const effectiveCardinality = combineCardinality(
    scope.inheritedCardinality,
    parseCardinality(child),
  );
  const description = extractDocumentation(child) ?? referenced.description;
  scope.fields.push({
    ...buildRefField(
      effectiveCardinality,
      resolvedQName,
      referenced.typeName,
      child["@_nillable"] === true ||
        child["@_nillable"] === "true" ||
        referenced.nillable === true,
      scope.choiceGroup,
      scope.choiceBranch,
    ),
    // A ref particle carries no value constraint of its own — the referenced
    // global declaration's default/fixed applies.
    ...optProp("defaultValue", referenced.defaultValue),
    ...optProp("fixedValue", referenced.fixedValue),
    ...valueConstraints(child),
    ...optProp("description", description),
  });
};

type FieldHandler = (
  child: AnyNode,
  ctx: FieldCollectionContext,
  scope: CollectFieldsScope,
) => void;

const collectElement: FieldHandler = (child, ctx, scope) => {
  const name = String(child["@_name"] ?? "");
  const ref = child["@_ref"] ? String(child["@_ref"]) : "";
  if (!name && !ref) {
    return;
  }
  const localCtx = { ...ctx, nsMap: { ...ctx.nsMap, ...localNsDeclarations(child) } };
  if (ref) {
    collectElementRef(child, ref, ctx, scope);
    return;
  }
  const typeName = resolveElementTypeName(child, name, localCtx, scope);
  const effectiveCardinality = combineCardinality(
    scope.inheritedCardinality,
    parseCardinality(child),
  );
  scope.fields.push({
    ...effectiveCardinality,
    kind: "element",
    qname: toClark(
      resolveDeclaredFieldNamespace(scope.ownerNs, "element", child["@_form"], ctx.formDefaults),
      name,
    ),
    typeName,
    nillable: child["@_nillable"] === true || child["@_nillable"] === "true",
    ...optProp("choiceGroup", scope.choiceGroup),
    ...optProp("choiceBranch", scope.choiceBranch),
    ...valueConstraints(child),
    ...optProp("description", extractDocumentation(child)),
  });
};

const collectAttribute: FieldHandler = (child, ctx, scope) => {
  const name = String(child["@_name"] ?? "");
  const ref = child["@_ref"] ? String(child["@_ref"]) : "";
  if (!name && !ref) {
    return;
  }
  const localNsMap = { ...ctx.nsMap, ...localNsDeclarations(child) };
  if (ref) {
    const refQName = resolveTypeQName(ref, localNsMap, ctx.diagnostics);
    const referenced = ctx.attributes[refQName];
    if (!referenced) {
      report(
        ctx.diagnostics,
        "unresolved-attribute-ref",
        `unresolved attribute ref "${refQName}"`,
        refQName,
      );
    }
    const description = extractDocumentation(child) ?? referenced?.description;
    scope.fields.push({
      ...attributeCardinality(child, scope.inheritedCardinality),
      kind: "attribute",
      qname: refQName,
      typeName: referenced?.typeName ?? toClark(XSD_NS, "string"),
      ...valueConstraints(child),
      ...optProp("description", description),
    });
    return;
  }
  let typeName: QName;
  if (child["@_type"]) {
    typeName = resolveTypeQName(String(child["@_type"]), localNsMap, ctx.diagnostics);
  } else {
    const inlineSimple = nodeChildren(child).find(
      ([key]) => getNodeTagLocalName(key) === "simpleType",
    )?.[1];
    typeName = inlineSimple
      ? synthesizeFieldSimpleType(inlineSimple, name, ctx, scope)
      : resolveTypeQName(undefined, ctx.nsMap, ctx.diagnostics);
  }
  scope.fields.push({
    ...attributeCardinality(child, scope.inheritedCardinality),
    kind: "attribute",
    qname: toClark(
      resolveDeclaredFieldNamespace(scope.ownerNs, "attribute", child["@_form"], ctx.formDefaults),
      name,
    ),
    typeName,
    ...valueConstraints(child),
    ...optProp("description", extractDocumentation(child)),
  });
};

const collectWildcard =
  (kind: WildcardDef["kind"]): FieldHandler =>
  (child, _ctx, scope) => {
    scope.wildcards.push({
      kind,
      namespaceConstraint: String(child["@_namespace"] ?? "##any"),
      ...(kind === "any"
        ? { position: scope.fields.filter((f) => f.kind === "element").length }
        : {}),
      ...optProp("choiceGroup", scope.choiceGroup),
    });
  };

const collectCompositor: FieldHandler = (child, ctx, scope) => {
  collectFields(
    child,
    ctx,
    nestedScope(scope, combineCardinality(scope.inheritedCardinality, parseCardinality(child))),
  );
};

const CHOICE_BRANCH_TAGS = new Set(["element", "group", "sequence", "choice", "all", "any"]);

const collectChoice: FieldHandler = (child, ctx, scope) => {
  const groupId = `${ctx.choiceCounter.value++}`;
  const choiceCard = combineCardinality(scope.inheritedCardinality, parseCardinality(child));
  ctx.choiceGroupCardinality.set(groupId, choiceCard);
  // A choice nested inside a branch of an outer choice is only reachable when
  // that branch is selected — the codegen gates its check on the branch.
  if (scope.choiceGroup !== undefined && scope.choiceBranch !== undefined) {
    ctx.choiceGroupGuards.set(groupId, { group: scope.choiceGroup, branch: scope.choiceBranch });
  }
  // Each direct child of the xs:choice is one branch. Branch identity is
  // threaded through as choiceBranch so fields inlined from a group ref or
  // nested compositor stay together as a single branch (#73 / ipo-style
  // shipTo+billTo vs singleAddress choices).
  let branchIndex = 0;
  for (const [branchTag, branchChild] of nodeChildrenOrdered(child)) {
    if (!CHOICE_BRANCH_TAGS.has(getNodeTagLocalName(branchTag))) {
      continue;
    }
    const branchId = `${groupId}.${branchIndex++}`;
    collectFields({ [branchTag]: branchChild }, ctx, {
      ownerNs: scope.ownerNs,
      fields: scope.fields,
      wildcards: scope.wildcards,
      choiceGroup: groupId,
      inheritedCardinality: choiceCard,
      choiceBranch: branchId,
      ...optProp("parentTypeName", scope.parentTypeName),
    });
  }
};

const collectGroupRef: FieldHandler = (child, ctx, scope) => {
  const ref = child["@_ref"] ? String(child["@_ref"]) : "";
  if (!ref) {
    return;
  }
  const refQName = resolveTypeQName(ref, ctx.nsMap, ctx.diagnostics);
  expandGroupRef(
    refQName,
    ctx.groups[refQName],
    ctx,
    nestedScope(scope, combineCardinality(scope.inheritedCardinality, parseCardinality(child))),
    "group",
    "unresolved-group-ref",
    "unresolved group ref",
    "circular-group-ref",
  );
};

const collectAttributeGroupRef: FieldHandler = (child, ctx, scope) => {
  const ref = child["@_ref"] ? String(child["@_ref"]) : "";
  if (!ref) {
    return;
  }
  const refQName = resolveTypeQName(ref, ctx.nsMap, ctx.diagnostics);
  expandGroupRef(
    refQName,
    ctx.attributeGroups[refQName],
    ctx,
    nestedScope(scope, scope.inheritedCardinality),
    "attributeGroup",
    "unresolved-attribute-group-ref",
    "unresolved attributeGroup ref",
    "circular-attribute-group-ref",
  );
};

const collectSimpleContent: FieldHandler = (child, ctx, scope) => {
  const derivation = findDerivation(child);
  if (!derivation) {
    return;
  }
  const baseAttr = derivation["@_base"];
  if (baseAttr && typeof baseAttr === "string") {
    const baseType = resolveTypeQName(baseAttr, ctx.nsMap, ctx.diagnostics);
    let textType = baseType;
    const seenAttrs = new Set<string>();
    // Type-level cycle guard: circular simpleContent bases (invalid XSD)
    // would otherwise spin forever once all types are collected (#94).
    const seenTypes = new Set<QName>([baseType]);
    let current = ctx.complexTypes[baseType];
    while (current) {
      const textField = current.fields.find((f) => f.kind === "text");
      if (!textField) {
        break;
      }
      for (const f of current.fields) {
        if (f.kind === "attribute" && !seenAttrs.has(f.qname)) {
          seenAttrs.add(f.qname);
          // Copy the field so the derived type does not alias the base's object.
          scope.fields.push({ ...f });
        }
      }
      textType = textField.typeName;
      if (seenTypes.has(textType)) {
        break;
      }
      seenTypes.add(textType);
      current = ctx.complexTypes[textType];
    }
    scope.fields.push({
      ...scope.inheritedCardinality,
      kind: "text",
      qname: toClark(scope.ownerNs, "_text"),
      typeName: textType,
    });
  }
  collectFields(derivation, ctx, nestedScope(scope, scope.inheritedCardinality));
};

const collectComplexContent: FieldHandler = (child, ctx, scope) => {
  const derivation = findDerivation(child);
  if (!derivation) {
    return;
  }
  collectFields(derivation, ctx, nestedScope(scope, scope.inheritedCardinality));
};

// XSD §3.4.2: a complex type is mixed when its <complexContent> carries
// mixed="true", or — without complexContent — the <complexType> itself does;
// the default is false. Mixed content allows character data interleaved with
// the child elements.
const isMixedComplexType = (node: AnyNode): boolean => {
  const complexContent = nodeChildren(node).find(
    ([key]) => getNodeTagLocalName(key) === "complexContent",
  )?.[1];
  const mixed = complexContent?.["@_mixed"] ?? node["@_mixed"];
  return mixed === true || mixed === "true";
};

// Mixed content: optional `_text` field (parser concatenates text segments).
const prependMixedTextField = (fields: IrField[], ownerNs: string): void => {
  if (fields.some((f) => f.kind === "text")) {
    return;
  }
  fields.unshift({
    minOccurs: 0,
    maxOccurs: 1,
    kind: "text",
    qname: toClark(ownerNs, "_text"),
    typeName: toClark(XSD_NS, "string"),
  });
};

// Keep first `_text` only when merging mixed types.
const dedupeTextFields = (fields: IrField[]): IrField[] => {
  const firstText = fields.findIndex((f) => f.kind === "text");
  return firstText === -1 ? fields : fields.filter((f, i) => f.kind !== "text" || i === firstText);
};

// Collapse adjacent same-name element particles into one repeated field.
const mergeRepeatedElementFields = (fields: IrField[], wildcards: WildcardDef[]): IrField[] => {
  const wildcardPositions = new Set(
    wildcards.flatMap((w) => (w.position === undefined ? [] : [w.position])),
  );
  const merged: IrField[] = [];
  let elementOrdinal = -1;
  for (const field of fields) {
    if (field.kind === "element") {
      elementOrdinal++;
    }
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.kind === "element" &&
      field.kind === "element" &&
      !wildcardPositions.has(elementOrdinal) &&
      field.qname === prev.qname &&
      field.typeName === prev.typeName &&
      field.nillable === prev.nillable &&
      field.choiceGroup === prev.choiceGroup &&
      field.choiceBranch === prev.choiceBranch
    ) {
      prev.minOccurs += field.minOccurs;
      prev.maxOccurs =
        prev.maxOccurs === "unbounded" || field.maxOccurs === "unbounded"
          ? "unbounded"
          : prev.maxOccurs + field.maxOccurs;
      continue;
    }
    merged.push({ ...field });
  }
  return merged;
};

// Two fields sharing an object key (same local name, different namespaces)
// need distinct keys — zod object keys are unique and the fields meta map is
// keyed the same way. The first occurrence keeps the plain key.
const disambiguateFieldKeys = (fields: IrField[]): IrField[] => {
  const baseKey = (field: IrField): string =>
    field.kind === "text"
      ? "_text"
      : field.kind === "attribute"
        ? `@${clarkToLocal(field.qname)}`
        : clarkToLocal(field.qname);
  const used = new Set<string>();
  return fields.map((field) => {
    const key = field.fieldKey ?? baseKey(field);
    if (!used.has(key)) {
      used.add(key);
      return field;
    }
    // Same-qname repeats share the key on purpose (see IrField.fieldKey).
    if (field.qname === fields.find((f) => (f.fieldKey ?? baseKey(f)) === key)?.qname) {
      return field;
    }
    let n = 2;
    while (used.has(`${key}${n}`)) {
      n++;
    }
    const unique = `${key}${n}`;
    used.add(unique);
    return { ...field, fieldKey: unique };
  });
};

const FIELD_HANDLERS: Record<string, FieldHandler> = {
  element: collectElement,
  attribute: collectAttribute,
  any: collectWildcard("any"),
  anyAttribute: collectWildcard("anyAttribute"),
  sequence: collectCompositor,
  all: collectCompositor,
  choice: collectChoice,
  group: collectGroupRef,
  attributeGroup: collectAttributeGroupRef,
  simpleContent: collectSimpleContent,
  complexContent: collectComplexContent,
};

const collectFields = (
  container: AnyNode,
  ctx: FieldCollectionContext,
  scope: CollectFieldsScope,
): void => {
  for (const [tag, child] of nodeChildrenOrdered(container)) {
    FIELD_HANDLERS[getNodeTagLocalName(tag)]?.(child, ctx, scope);
  }
};

// Extract the base type of a complexContent or simpleContent derivation, if any.
const extractExtensionBase = (
  container: AnyNode,
  nsMap: Record<string, string>,
  diagnostics: Diagnostic[],
): QName | undefined => extractDerivationBase(container, "extension", nsMap, diagnostics);

const extractRestrictionBase = (
  container: AnyNode,
  nsMap: Record<string, string>,
  diagnostics: Diagnostic[],
): QName | undefined => extractDerivationBase(container, "restriction", nsMap, diagnostics);

const extractDerivationBase = (
  container: AnyNode,
  kind: "extension" | "restriction",
  nsMap: Record<string, string>,
  diagnostics: Diagnostic[],
): QName | undefined => {
  const contentNode = nodeChildren(container).find(([key]) => {
    const local = getNodeTagLocalName(key);
    return local === "complexContent" || local === "simpleContent";
  })?.[1];
  const derivationNode = contentNode
    ? nodeChildren(contentNode).find(([key]) => getNodeTagLocalName(key) === kind)?.[1]
    : undefined;
  return derivationNode?.["@_base"]
    ? resolveTypeQName(String(derivationNode["@_base"]), nsMap, diagnostics)
    : undefined;
};

// xs:complexType abstract="true".
const isAbstractComplexType = (node: AnyNode): boolean => {
  const abstract = node["@_abstract"];
  return abstract === true || abstract === "true";
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
  /** True when this file was passed directly by the user; errors reading entry points should still throw. */
  entryPoint?: boolean;
};

type RedefineOverride = {
  kind: "complexType" | "simpleType" | "group" | "attributeGroup";
  qname: QName;
  node: AnyNode;
  nsMap: Record<string, string>;
  targetNs: string;
  formDefaults: SchemaFormDefaults;
};

export type ParseXsdOptions = {
  /** When true, unresolved element refs produce a fallback field with z.unknown()
   *  type instead of being silently dropped. Without this flag, unresolved refs
   *  are dropped (old behaviour) and only a warning is emitted. */
  allowMissingImports?: boolean;
};

type PendingFile = {
  effectiveNs: string;
  resolveNsMap: Record<string, string>;
  formDefaults: SchemaFormDefaults;
  elementNodes: AnyNode[];
  complexTypeNodes: AnyNode[];
};

// Mutable registries shared by all parse phases: declarations land here first,
// then field collection and redefines rewrite them in place.
type ParseState = {
  simpleTypes: Record<string, SimpleTypeDef>;
  complexTypes: Record<string, ComplexTypeDef>;
  elements: Record<string, ElementDef>;
  rootElements: QName[];
  targetNamespaces: Set<string>;
  deferredInlineTypes: DeferredInlineType[];
  deferredSyntheticTypes: DeferredInlineType[];
  syntheticTypeCounter: { value: number };
  choiceCounter: { value: number };
  groups: Record<string, GroupEntry>;
  attributeGroups: Record<string, GroupEntry>;
  attributes: Record<string, GlobalAttributeDecl>;
  diagnostics: Diagnostic[];
  allowMissingImports: boolean;
};

const toRecord = <V>(entries: Map<string, V> | Record<string, V>): Record<string, V> =>
  entries instanceof Map ? Object.fromEntries(entries) : entries;

const choiceGroupsMeta = (
  entries: Map<string, Cardinality> | Record<string, Cardinality>,
): Pick<ComplexTypeDef, "choiceGroups"> => {
  const record = toRecord(entries);
  return Object.keys(record).length > 0 ? { choiceGroups: record } : {};
};

const choiceGuardsMeta = (
  entries: Map<string, ChoiceGroupGuard> | Record<string, ChoiceGroupGuard>,
): Pick<ComplexTypeDef, "choiceGroupGuards"> => {
  const record = toRecord(entries);
  return Object.keys(record).length > 0 ? { choiceGroupGuards: record } : {};
};

const createFieldContext = (
  state: ParseState,
  nsMap: Record<string, string>,
  formDefaults: SchemaFormDefaults,
  targetNs: string,
): FieldCollectionContext => ({
  nsMap,
  formDefaults,
  elements: state.elements,
  choiceCounter: state.choiceCounter,
  choiceGroupCardinality: new Map(),
  choiceGroupGuards: new Map(),
  complexTypes: state.complexTypes,
  syntheticTypes: {
    targetNs,
    counter: state.syntheticTypeCounter,
    simpleTypes: state.simpleTypes,
    complexTypes: state.complexTypes,
  },
  groups: state.groups,
  attributeGroups: state.attributeGroups,
  deferredSyntheticTypes: state.deferredSyntheticTypes,
  attributes: state.attributes,
  diagnostics: state.diagnostics,
  allowMissingImports: state.allowMissingImports,
  expansionStack: { groups: new Set(), attributeGroups: new Set() },
});

type ScannedFile = {
  entry: QueueEntry;
  schemaNode: AnyNode;
  nsMap: Record<string, string>;
  targetNs: string;
  formDefaults: SchemaFormDefaults;
};

// Read entry points plus every schema reachable via schemaLocation and
// return them in dependency order (depth-first, dependencies first).
const scanSchemaFiles = (files: string[], diagnostics: Diagnostic[]): ScannedFile[] => {
  const allFiles: ScannedFile[] = [];
  const scanKey = (file: string, inheritedTargetNs?: string): string =>
    `${file}|${inheritedTargetNs ?? ""}`;
  const scanned = new Set<string>();

  const visit = (entry: QueueEntry): void => {
    const key = scanKey(entry.file, entry.inheritedTargetNs);
    if (scanned.has(key)) {
      return;
    }
    scanned.add(key);

    let schemaNode: AnyNode;
    let nsMap: Record<string, string>;
    let targetNs: string;
    let formDefaults: SchemaFormDefaults;
    try {
      const result = readSchema(entry.file);
      ({ schemaNode, nsMap, targetNs, formDefaults } = result);
    } catch (err) {
      if (entry.entryPoint) {
        throw err;
      }
      report(diagnostics, "unresolved-import", `unable to read schema "${entry.file}"`, entry.file);
      return;
    }

    for (const [tag, child] of nodeChildren(schemaNode)) {
      const localTag = getNodeTagLocalName(tag);
      const schemaLocation = child["@_schemaLocation"] ? String(child["@_schemaLocation"]) : "";
      if (!schemaLocation) {
        continue;
      }
      if (/^https?:/i.test(schemaLocation)) {
        report(
          diagnostics,
          "remote-schema-location",
          `remote schemaLocation "${schemaLocation}" skipped (not resolved)`,
          schemaLocation,
        );
        continue;
      }
      if (localTag !== "import" && localTag !== "include" && localTag !== "redefine") {
        continue;
      }
      const resolved = path.resolve(path.dirname(entry.file), schemaLocation);
      const ns = localTag === "include" ? targetNs || entry.inheritedTargetNs || "" : undefined;
      visit({ file: resolved, ...optProp("inheritedTargetNs", ns) });
    }

    allFiles.push({ entry, schemaNode, nsMap, targetNs, formDefaults });
  };

  for (const file of files) {
    visit({ file: path.resolve(file), entryPoint: true });
  }
  return allFiles;
};

const collectRedefineOverrides = (
  schemaChildren: [string, AnyNode][],
  effectiveNs: string,
  resolveNsMap: Record<string, string>,
  formDefaults: SchemaFormDefaults,
  overrides: RedefineOverride[],
): void => {
  for (const [tag, child] of schemaChildren) {
    if (getNodeTagLocalName(tag) !== "redefine") {
      continue;
    }
    for (const [rtag, rchild] of nodeChildren(child)) {
      const rlocal = getNodeTagLocalName(rtag);
      const rname = String(rchild["@_name"] ?? "");
      if (!rname) {
        continue;
      }
      if (
        rlocal === "complexType" ||
        rlocal === "simpleType" ||
        rlocal === "group" ||
        rlocal === "attributeGroup"
      ) {
        const rqname = toClark(effectiveNs, rname);
        const schemaLocation = child["@_schemaLocation"] ? String(child["@_schemaLocation"]) : "";
        if (schemaLocation) {
          overrides.push({
            kind: rlocal,
            qname: rqname,
            node: rchild,
            nsMap: resolveNsMap,
            targetNs: effectiveNs,
            formDefaults,
          });
        }
      }
    }
  }
};

// Declaration collection is separated from field collection
// (collectTopLevelElements / collectComplexTypes) so element, group,
// attributeGroup and attribute references always resolve against the complete
// declaration maps, regardless of file and CLI argument order (#77).
const collectDeclarations = (
  state: ParseState,
  files: ScannedFile[],
): { pendingFiles: PendingFile[]; redefineOverrides: RedefineOverride[] } => {
  const pendingFiles: PendingFile[] = [];
  // Redefine overrides, in the order the xs:redefine elements were seen.
  const redefineOverrides: RedefineOverride[] = [];

  for (const {
    entry,
    schemaNode,
    nsMap: fileNsMap,
    targetNs: fileTargetNs,
    formDefaults: fileFormDefaults,
  } of files) {
    const effectiveNs = fileTargetNs || entry.inheritedTargetNs || "";
    // Namespace-less schemas contribute no entry — '' would be noise (#79).
    if (effectiveNs) {
      state.targetNamespaces.add(effectiveNs);
    }

    if (!fileNsMap[""] && entry.inheritedTargetNs) {
      fileNsMap[""] = entry.inheritedTargetNs;
    }

    // Unprefixed type references resolve against the schema document's default
    // namespace when one is declared (e.g. xmlns="...XMLSchema" makes
    // type="string" mean xs:string); the targetNamespace is only a fallback.
    const resolveNsMap = { ...fileNsMap, "": fileNsMap[""] || effectiveNs };

    const schemaChildren = nodeChildren(schemaNode);
    const elementNodes: AnyNode[] = [];
    const complexTypeNodes: AnyNode[] = [];
    for (const [tag, child] of schemaChildren) {
      const localTag = getNodeTagLocalName(tag);

      if (localTag === "import" || localTag === "include" || localTag === "redefine") {
        continue;
      }

      if (localTag === "simpleType") {
        const name = String(child["@_name"] ?? "");
        if (!name) {
          continue;
        }
        const qname = toClark(effectiveNs, name);
        state.simpleTypes[qname] = parseSimpleTypeDef(
          qname,
          child,
          resolveNsMap,
          state.simpleTypes,
          state.diagnostics,
        );
        continue;
      }

      if (localTag === "complexType") {
        complexTypeNodes.push(child);
        continue;
      }

      if (localTag === "element") {
        elementNodes.push(child);
        continue;
      }

      if (localTag === "group") {
        const name = String(child["@_name"] ?? "");
        if (!name) {
          continue;
        }
        const qname = toClark(effectiveNs, name);
        state.groups[qname] = {
          ownerNs: effectiveNs,
          formDefaults: fileFormDefaults,
          nsMap: resolveNsMap,
          node: child,
        };
        continue;
      }

      if (localTag === "attributeGroup") {
        const name = String(child["@_name"] ?? "");
        if (!name) {
          continue;
        }
        const qname = toClark(effectiveNs, name);
        state.attributeGroups[qname] = {
          ownerNs: effectiveNs,
          formDefaults: fileFormDefaults,
          nsMap: resolveNsMap,
          node: child,
        };
        continue;
      }

      if (localTag === "attribute") {
        const name = String(child["@_name"] ?? "");
        if (!name) {
          continue;
        }
        const qname = toClark(effectiveNs, name);
        let typeName: QName;
        if (child["@_type"]) {
          typeName = resolveTypeQName(String(child["@_type"]), resolveNsMap, state.diagnostics);
        } else {
          const inlineSimple = nodeChildren(child).find(
            ([key]) => getNodeTagLocalName(key) === "simpleType",
          )?.[1];
          typeName = inlineSimple
            ? synthesizeInlineSimpleType(
                inlineSimple,
                resolveNsMap,
                {
                  targetNs: effectiveNs,
                  counter: state.syntheticTypeCounter,
                  simpleTypes: state.simpleTypes,
                  complexTypes: state.complexTypes,
                },
                name,
                state.diagnostics,
              )
            : toClark(XSD_NS, "string");
        }
        const attrDescription = extractDocumentation(child);
        state.attributes[qname] = {
          typeName,
          ...optProp("description", attrDescription),
        };
      }
    }

    collectRedefineOverrides(
      schemaChildren,
      effectiveNs,
      resolveNsMap,
      fileFormDefaults,
      redefineOverrides,
    );

    pendingFiles.push({
      effectiveNs,
      resolveNsMap,
      formDefaults: fileFormDefaults,
      elementNodes,
      complexTypeNodes,
    });
  }

  return { pendingFiles, redefineOverrides };
};

// Group/attributeGroup redefines must land before any field collection:
// references to them are inlined into consumers at collection time (#78).
// Self-refs inside the override are expanded against the original first.
const applyGroupRedefines = (state: ParseState, overrides: RedefineOverride[]): void => {
  for (const override of overrides) {
    if (override.kind === "group") {
      state.groups[override.qname] = {
        ownerNs: override.targetNs,
        formDefaults: override.formDefaults,
        nsMap: override.nsMap,
        node: expandRedefineSelfRefs(
          override.node,
          "group",
          override.qname,
          state.groups[override.qname]?.node,
          override.nsMap,
          state.diagnostics,
        ),
      };
    } else if (override.kind === "attributeGroup") {
      state.attributeGroups[override.qname] = {
        ownerNs: override.targetNs,
        formDefaults: override.formDefaults,
        nsMap: override.nsMap,
        node: expandRedefineSelfRefs(
          override.node,
          "attributeGroup",
          override.qname,
          state.attributeGroups[override.qname]?.node,
          override.nsMap,
          state.diagnostics,
        ),
      };
    }
  }
};

const collectTopLevelElements = (state: ParseState, pendingFiles: PendingFile[]): void => {
  for (const {
    effectiveNs,
    resolveNsMap,
    formDefaults: fileFormDefaults,
    elementNodes,
  } of pendingFiles) {
    for (const child of elementNodes) {
      const name = String(child["@_name"] ?? "");
      if (!name) {
        continue;
      }

      let typeName = child["@_type"]
        ? resolveTypeQName(String(child["@_type"]), resolveNsMap, state.diagnostics)
        : undefined;

      if (!typeName) {
        const inlineComplex = nodeChildren(child).find(
          ([key]) => getNodeTagLocalName(key) === "complexType",
        )?.[1];
        if (inlineComplex) {
          typeName = toClark(effectiveNs, `anonymous_${name}_Type`);
          state.complexTypes[typeName] = { name: typeName, fields: [] };
          state.deferredInlineTypes.push({
            typeName,
            container: inlineComplex,
            ownerNs: effectiveNs,
            nsMap: resolveNsMap,
            formDefaults: fileFormDefaults,
          });
        }
      }

      if (!typeName) {
        const inlineSimple = nodeChildren(child).find(
          ([key]) => getNodeTagLocalName(key) === "simpleType",
        )?.[1];
        if (inlineSimple) {
          typeName = synthesizeInlineSimpleType(
            inlineSimple,
            resolveNsMap,
            {
              targetNs: effectiveNs,
              counter: state.syntheticTypeCounter,
              simpleTypes: state.simpleTypes,
              complexTypes: state.complexTypes,
            },
            name,
            state.diagnostics,
          );
        }
      }

      if (!typeName) {
        // An element with no type declaration is xs:anyType — open content.
        typeName = toClark(XSD_NS, "anyType");
      }

      const qname = toClark(effectiveNs, name);
      const description = extractDocumentation(child);
      const substitutionGroup = child["@_substitutionGroup"]
        ? resolveTypeQName(String(child["@_substitutionGroup"]), resolveNsMap, state.diagnostics)
        : undefined;
      state.elements[qname] = {
        name: qname,
        typeName,
        cardinality: parseCardinality(child),
        nillable: child["@_nillable"] === true || child["@_nillable"] === "true",
        ...optProp("substitutionGroup", substitutionGroup),
        ...optProp("description", description),
        ...valueConstraints(child),
      };
      if (!state.rootElements.includes(qname)) {
        state.rootElements.push(qname);
      }
    }
  }
};

const collectComplexTypes = (state: ParseState, pendingFiles: PendingFile[]): void => {
  for (const {
    effectiveNs,
    resolveNsMap,
    formDefaults: fileFormDefaults,
    complexTypeNodes,
  } of pendingFiles) {
    for (const child of complexTypeNodes) {
      const name = String(child["@_name"] ?? "");
      if (!name) {
        continue;
      }
      const qname = toClark(effectiveNs, name);
      const fields: IrField[] = [];
      const wildcards: WildcardDef[] = [];
      const fCtx = createFieldContext(state, resolveNsMap, fileFormDefaults, effectiveNs);
      collectFields(child, fCtx, {
        ownerNs: effectiveNs,
        fields,
        wildcards,
        inheritedCardinality: { minOccurs: 1, maxOccurs: 1 },
        parentTypeName: clarkToLocal(qname),
      });
      const baseType = extractExtensionBase(child, resolveNsMap, state.diagnostics);
      const restrictionBase =
        baseType === undefined
          ? extractRestrictionBase(child, resolveNsMap, state.diagnostics)
          : undefined;
      const description = extractDocumentation(child);
      if (isMixedComplexType(child)) {
        prependMixedTextField(fields, effectiveNs);
      }

      state.complexTypes[qname] = {
        name: qname,
        fields,
        ...optProp("baseType", baseType),
        ...optProp("restrictionBase", restrictionBase),
        ...(isAbstractComplexType(child) ? { abstract: true } : {}),
        ...optProp("description", description),
        ...choiceGroupsMeta(fCtx.choiceGroupCardinality),
        ...choiceGuardsMeta(fCtx.choiceGroupGuards),
        ...(wildcards.length > 0 ? { wildcards } : {}),
      };
    }
  }
};

const applyTypeRedefines = (state: ParseState, overrides: RedefineOverride[]): void => {
  for (const override of overrides) {
    if (override.kind === "complexType") {
      const fields: IrField[] = [];
      const wildcards: WildcardDef[] = [];
      const fCtx = createFieldContext(
        state,
        override.nsMap,
        override.formDefaults,
        override.targetNs,
      );
      collectFields(override.node, fCtx, {
        ownerNs: override.targetNs,
        fields,
        wildcards,
        inheritedCardinality: { minOccurs: 1, maxOccurs: 1 },
        parentTypeName: clarkToLocal(override.qname),
      });
      const complexContent = nodeChildren(override.node).find(
        ([key]) => getNodeTagLocalName(key) === "complexContent",
      )?.[1];
      const derivationEntry = complexContent
        ? nodeChildren(complexContent).find(([key]) => {
            const local = getNodeTagLocalName(key);
            return local === "extension" || local === "restriction";
          })
        : undefined;
      const derivationKind = derivationEntry ? getNodeTagLocalName(derivationEntry[0]) : undefined;
      const derivationNode = derivationEntry?.[1];
      const baseType = derivationNode?.["@_base"]
        ? resolveTypeQName(String(derivationNode["@_base"]), override.nsMap, state.diagnostics)
        : undefined;
      const description = extractDocumentation(override.node);
      const choiceGroupMeta = choiceGroupsMeta(fCtx.choiceGroupCardinality);
      const choiceGuardMeta = choiceGuardsMeta(fCtx.choiceGroupGuards);
      const effectiveBaseType = baseType === override.qname ? undefined : baseType;
      const abstract = isAbstractComplexType(override.node);
      if (isMixedComplexType(override.node)) {
        prependMixedTextField(fields, override.targetNs);
      }
      if (baseType === override.qname && derivationKind === "extension") {
        const original = state.complexTypes[override.qname];
        if (original) {
          const mergedChoiceGroups = {
            ...original.choiceGroups,
            ...Object.fromEntries(fCtx.choiceGroupCardinality),
          };
          const mergedChoiceGuards = {
            ...original.choiceGroupGuards,
            ...Object.fromEntries(fCtx.choiceGroupGuards),
          };
          const mergedWildcards = [...(original.wildcards ?? []), ...wildcards];
          state.complexTypes[override.qname] = {
            name: override.qname,
            fields: dedupeTextFields([...original.fields, ...fields]),
            ...optProp("baseType", original.baseType),
            ...optProp("restrictionBase", original.restrictionBase),
            ...(abstract || original.abstract === true ? { abstract: true } : {}),
            ...optProp("description", description ?? original.description),
            ...choiceGroupsMeta(mergedChoiceGroups),
            ...choiceGuardsMeta(mergedChoiceGuards),
            ...(mergedWildcards.length > 0 ? { wildcards: mergedWildcards } : {}),
          };
        } else {
          state.complexTypes[override.qname] = {
            name: override.qname,
            fields,
            ...optProp("baseType", effectiveBaseType),
            ...(abstract ? { abstract: true } : {}),
            ...optProp("description", description),
            ...choiceGroupMeta,
            ...choiceGuardMeta,
            ...(wildcards.length > 0 ? { wildcards } : {}),
          };
        }
      } else {
        state.complexTypes[override.qname] = {
          name: override.qname,
          fields,
          ...optProp("baseType", effectiveBaseType),
          ...(abstract ? { abstract: true } : {}),
          ...optProp("description", description),
          ...choiceGroupMeta,
          ...choiceGuardMeta,
          ...(wildcards.length > 0 ? { wildcards } : {}),
        };
      }
    } else if (override.kind === "simpleType") {
      // Preserve the original definition before it is replaced: a self-base in
      // the override (restriction base="own name") points at the ORIGINAL per
      // xs:redefine semantics, not at the override itself.
      const original = state.simpleTypes[override.qname];

      // Drop synthetic inline item/member types created for the previous definition
      // so swapping list ↔ union (or changing item/member shape) does not leave orphans.
      const orphanPrefix = `${override.qname}_`;
      for (const existingName of Object.keys(state.simpleTypes)) {
        if (existingName.startsWith(orphanPrefix)) {
          delete state.simpleTypes[existingName];
        }
      }

      const def = parseSimpleTypeDef(
        override.qname,
        override.node,
        override.nsMap,
        state.simpleTypes,
        state.diagnostics,
      );
      if (def.kind === "restriction" && def.baseType === override.qname) {
        if (original) {
          // Name the preserved original outside the `${qname}_` synthetic
          // prefix — the orphan cleanup above deletes that space on every
          // redefine in the chain. Bump the suffix for chained redefines.
          let originalName = `${override.qname}-redefined` as QName;
          for (let i = 2; state.simpleTypes[originalName] !== undefined; i++) {
            originalName = `${override.qname}-redefined-${i}` as QName;
          }
          state.simpleTypes[originalName] = { ...original, name: originalName };
          def.baseType = originalName;
        } else {
          report(
            state.diagnostics,
            "circular-redefinition",
            `circular simpleType redefinition "${override.qname}" without an original definition`,
            override.qname,
          );
        }
      }
      state.simpleTypes[override.qname] = def;
    }
  }
};

const processDeferredType = (
  state: ParseState,
  { typeName, container, ownerNs, nsMap, formDefaults }: DeferredInlineType,
): void => {
  const fields: IrField[] = [];
  const wildcards: WildcardDef[] = [];
  const fCtx = createFieldContext(state, nsMap, formDefaults, ownerNs);
  collectFields(container, fCtx, {
    ownerNs,
    fields,
    wildcards,
    inheritedCardinality: { minOccurs: 1, maxOccurs: 1 },
    parentTypeName: clarkToLocal(typeName),
  });
  const baseType = extractExtensionBase(container, nsMap, state.diagnostics);
  const restrictionBase =
    baseType === undefined
      ? extractRestrictionBase(container, nsMap, state.diagnostics)
      : undefined;
  if (isMixedComplexType(container)) {
    prependMixedTextField(fields, ownerNs);
  }
  state.complexTypes[typeName] = {
    name: typeName,
    fields,
    ...optProp("baseType", baseType),
    ...optProp("restrictionBase", restrictionBase),
    ...(isAbstractComplexType(container) ? { abstract: true } : {}),
    ...choiceGroupsMeta(fCtx.choiceGroupCardinality),
    ...choiceGuardsMeta(fCtx.choiceGroupGuards),
    ...(wildcards.length > 0 ? { wildcards } : {}),
  };
};

// Inline types are collected only after all declarations exist: element refs
// and attributeGroups they contain must resolve against the complete maps.
// Field collection itself can enqueue further synthetic types, so the queue is
// drained rather than iterated as a fixed snapshot.
const processDeferredTypes = (state: ParseState): void => {
  for (const deferred of state.deferredInlineTypes) {
    processDeferredType(state, deferred);
  }
  while (state.deferredSyntheticTypes.length > 0) {
    const next = state.deferredSyntheticTypes.shift();
    if (next) {
      processDeferredType(state, next);
    }
  }
};

// Flatten each complex type's extension chain into a self-contained def:
// fields, wildcards and choice group cardinalities inherit from base to
// derived type.
const mergeExtendedTypes = (state: ParseState): Record<string, ComplexTypeDef> => {
  const resolveMergedFields = (typeName: string, stack: Set<string>): IrField[] => {
    const type = state.complexTypes[typeName];
    if (!type) {
      return [];
    }
    if (!type.baseType || !state.complexTypes[type.baseType]) {
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
  // Wildcards inherit down the extension chain, like fields. Extension
  // content follows the base content, so a derived type's wildcard positions
  // shift by the base's element-field count.
  const resolveMergedWildcards = (typeName: string, stack: Set<string>): WildcardDef[] => {
    const type = state.complexTypes[typeName];
    if (!type) {
      return [];
    }
    if (!type.baseType || !state.complexTypes[type.baseType] || stack.has(typeName)) {
      return type?.wildcards ?? [];
    }
    const nextStack = new Set(stack);
    nextStack.add(typeName);
    const baseWildcards = resolveMergedWildcards(type.baseType, nextStack);
    const baseElementCount = resolveMergedFields(type.baseType, nextStack).filter(
      (f) => f.kind === "element",
    ).length;
    const own = (type.wildcards ?? []).map((w) =>
      w.position === undefined ? w : { ...w, position: w.position + baseElementCount },
    );
    return [...baseWildcards, ...own];
  };
  // Choice group cardinality inherits down the extension chain, like fields.
  const resolveMergedChoiceGroups = (
    typeName: string,
    stack: Set<string>,
  ): Record<string, Cardinality> | undefined => {
    const type = state.complexTypes[typeName];
    if (!type) {
      return undefined;
    }
    if (!type.baseType || !state.complexTypes[type.baseType] || stack.has(typeName)) {
      return type.choiceGroups;
    }
    const nextStack = new Set(stack);
    nextStack.add(typeName);
    const baseGroups = resolveMergedChoiceGroups(type.baseType, nextStack);
    if (baseGroups && type.choiceGroups) {
      return { ...baseGroups, ...type.choiceGroups };
    }
    return type.choiceGroups ?? baseGroups;
  };
  // Guards for nested choice groups inherit the same way.
  const resolveMergedChoiceGuards = (
    typeName: string,
    stack: Set<string>,
  ): Record<string, ChoiceGroupGuard> | undefined => {
    const type = state.complexTypes[typeName];
    if (!type) {
      return undefined;
    }
    if (!type.baseType || !state.complexTypes[type.baseType] || stack.has(typeName)) {
      return type.choiceGroupGuards;
    }
    const nextStack = new Set(stack);
    nextStack.add(typeName);
    const baseGuards = resolveMergedChoiceGuards(type.baseType, nextStack);
    if (baseGuards && type.choiceGroupGuards) {
      return { ...baseGuards, ...type.choiceGroupGuards };
    }
    return type.choiceGroupGuards ?? baseGuards;
  };

  const mergedComplexTypes: Record<string, ComplexTypeDef> = {};
  for (const [name, type] of Object.entries(state.complexTypes)) {
    const mergedWildcards = resolveMergedWildcards(name, new Set());
    const mergedChoiceGroups = resolveMergedChoiceGroups(name, new Set());
    const mergedChoiceGuards = resolveMergedChoiceGuards(name, new Set());
    mergedComplexTypes[name] = {
      ...type,
      fields: disambiguateFieldKeys(
        mergeRepeatedElementFields(
          dedupeTextFields(resolveMergedFields(name, new Set())),
          mergedWildcards,
        ),
      ),
      ...(mergedChoiceGroups ? { choiceGroups: mergedChoiceGroups } : {}),
      ...(mergedChoiceGuards ? { choiceGroupGuards: mergedChoiceGuards } : {}),
      ...(mergedWildcards.length > 0 ? { wildcards: mergedWildcards } : {}),
    };
  }
  return mergedComplexTypes;
};

// simpleContent derivation walks the base chain eagerly at collection time,
// so a base declared LATER in the schema set leaves the derived type's _text
// field typed by the (complex) base itself. Fix those up once every type is
// collected: resolve the text type through the base chain and inherit the
// attributes the eager walk missed.
const resolveForwardSimpleContentBases = (state: ParseState): void => {
  for (const type of Object.values(state.complexTypes)) {
    const textField = type.fields.find((f) => f.kind === "text");
    if (textField === undefined || state.complexTypes[textField.typeName] === undefined) {
      continue;
    }
    const seenAttrs = new Set(
      type.fields.filter((f) => f.kind === "attribute").map((f) => f.qname),
    );
    const seenTypes = new Set<QName>([textField.typeName]);
    let current = state.complexTypes[textField.typeName];
    let resolved: QName | undefined;
    while (current !== undefined) {
      for (const f of current.fields) {
        if (f.kind === "attribute" && !seenAttrs.has(f.qname)) {
          seenAttrs.add(f.qname);
          // Copy the field so the derived type does not alias the base's object.
          type.fields.push({ ...f });
        }
      }
      const baseText = current.fields.find((f) => f.kind === "text");
      if (baseText === undefined) {
        break;
      }
      if (state.complexTypes[baseText.typeName] === undefined) {
        resolved = baseText.typeName;
        break;
      }
      if (seenTypes.has(baseText.typeName)) {
        break;
      }
      seenTypes.add(baseText.typeName);
      current = state.complexTypes[baseText.typeName];
    }
    if (resolved !== undefined) {
      textField.typeName = resolved;
    }
  }
};

export const parseXsd = (files: string[], opts?: ParseXsdOptions): XsdIr => {
  const state: ParseState = {
    simpleTypes: {},
    complexTypes: {},
    elements: {},
    rootElements: [],
    targetNamespaces: new Set<string>(),
    deferredInlineTypes: [],
    deferredSyntheticTypes: [],
    syntheticTypeCounter: { value: 0 },
    // Choice group ids are internal only (never emitted), but fields merged
    // from a base type and its extension must not share an id — an extension's
    // xs:choice is a separate group appended after the base content. A shared
    // counter keeps every group's id unique across the parse.
    choiceCounter: { value: 0 },
    groups: {},
    attributeGroups: {},
    attributes: {},
    diagnostics: [],
    allowMissingImports: opts?.allowMissingImports ?? false,
  };

  const scannedFiles = scanSchemaFiles(files, state.diagnostics);
  const { pendingFiles, redefineOverrides } = collectDeclarations(state, scannedFiles);
  applyGroupRedefines(state, redefineOverrides);
  collectTopLevelElements(state, pendingFiles);
  collectComplexTypes(state, pendingFiles);
  applyTypeRedefines(state, redefineOverrides);
  processDeferredTypes(state);
  resolveForwardSimpleContentBases(state);
  const mergedComplexTypes = mergeExtendedTypes(state);

  dropCircularSimpleTypeRefs(state.simpleTypes, state.diagnostics);

  return {
    targetNamespaces: [...state.targetNamespaces],
    diagnostics: state.diagnostics,
    simpleTypes: state.simpleTypes,
    complexTypes: mergedComplexTypes,
    elements: state.elements,
    rootElements: state.rootElements,
  };
};
