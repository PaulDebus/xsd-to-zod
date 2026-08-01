import path from "node:path";
import XMLParser from "@nodable/flexible-xml-parser";
import { Xsd2ZodError } from "./errors.js";
import { sanitizeIdentifier } from "./irToZod.js";
import { clarkToLocal, splitQName, syntheticChildName, toClark } from "./qname.js";
import { readXmlFile } from "./readXmlFile.js";
import { createOutputBuilder } from "./runtime.js";
import type {
  Cardinality,
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
    const memberTypesRaw = unionChild["@_memberTypes"];
    let memberTypes: QName[];
    if (memberTypesRaw) {
      memberTypes = String(memberTypesRaw)
        .split(/\s+/)
        .map((mt) => resolveTypeQName(mt, nsMap, diagnostics));
    } else {
      memberTypes = nodeChildren(unionChild)
        .filter(([key]) => getNodeTagLocalName(key) === "simpleType")
        .map(([, stNode], idx) =>
          resolveInlineSimpleType(
            stNode,
            nsMap,
            simpleTypes,
            syntheticChildName(qname, `_member${idx}`),
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
  let candidate = local;
  let collisionIdx = 2;
  while (
    ctx.simpleTypes[toClark(ctx.targetNs, candidate)] ||
    ctx.complexTypes[toClark(ctx.targetNs, candidate)]
  ) {
    candidate = `${local}_${collisionIdx++}`;
  }
  const syntheticName = toClark(ctx.targetNs, candidate);
  return resolveInlineSimpleType(inlineSimple, nsMap, ctx.simpleTypes, syntheticName, diagnostics);
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
  const xml = readXmlFile(filePath);
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

const nodeChildren = (node: AnyNode): [string, AnyNode][] => {
  const children: [string, AnyNode][] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_") || key === "#text") {
      continue;
    }
    for (const entry of asArray(value as AnyNode | AnyNode[])) {
      if (entry && typeof entry === "object") {
        children.push([key, entry as AnyNode]);
      }
    }
  }
  return children;
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

// xs:redefine semantics: a ref inside a redefining group/attributeGroup that
// names the redefined component points at the ORIGINAL definition. Expand
// those self-refs with the original's children before the override replaces
// the registry entry — otherwise the self-ref resolves to the override itself
// and field collection recurses without end. A self-ref with no original is
// genuinely circular (invalid XSD) and is dropped with a diagnostic.
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

// A simple type may not take part in a derivation cycle: a union may not have
// itself as a member and a restriction/list may not derive from itself, even
// transitively. Such schemas are invalid XSD, and keeping the edge would make
// codegen emit a const that references itself before initialization, crashing
// at module load. Break every cycle with a diagnostic: drop the union member
// that closes it, or — when the closing edge is a restriction base or a list
// item type — drop the offending type; references to a dropped type fall back
// to z.unknown() at codegen.
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
  stack: Set<string>,
  unresolvedKind: DiagnosticKind,
  unresolvedPrefix: string,
  circularKind?: DiagnosticKind,
): void => {
  if (stack.has(refQName)) {
    if (circularKind) {
      report(
        ctx.diagnostics,
        circularKind,
        `circular group ref "${refQName}" dropped`,
        refQName,
      );
    }
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

const collectFields = (
  container: AnyNode,
  ctx: FieldCollectionContext,
  scope: CollectFieldsScope,
): void => {
  const {
    ownerNs,
    fields,
    wildcards,
    choiceGroup,
    inheritedCardinality,
    choiceBranch,
    parentTypeName,
  } = scope;
  const {
    nsMap,
    formDefaults,
    elements,
    complexTypes,
    syntheticTypes,
    groups,
    attributeGroups,
    deferredSyntheticTypes,
    attributes,
    diagnostics,
    allowMissingImports,
  } = ctx;
  for (const [tag, child] of nodeChildren(container)) {
    const localTag = getNodeTagLocalName(tag);
    if (localTag === "element") {
      const name = String(child["@_name"] ?? "");
      const ref = child["@_ref"] ? String(child["@_ref"]) : "";
      if (!name && !ref) {
        continue;
      }

      if (ref) {
        const refQName = resolveTypeQName(ref, nsMap, diagnostics);
        const referenced = elements[refQName];
        if (referenced) {
          const effectiveCardinality = combineCardinality(
            inheritedCardinality,
            parseCardinality(child),
          );
          const description = extractDocumentation(child) ?? referenced.description;
          fields.push({
            ...buildRefField(
              effectiveCardinality,
              refQName,
              referenced.typeName,
              child["@_nillable"] === true ||
                child["@_nillable"] === "true" ||
                referenced.nillable === true,
              choiceGroup,
              choiceBranch,
            ),
            ...(child["@_default"] !== undefined && { defaultValue: String(child["@_default"]) }),
            ...(child["@_fixed"] !== undefined && { fixedValue: String(child["@_fixed"]) }),
            ...optProp("description", description),
          });
        } else {
          report(
            diagnostics,
            "unresolved-element-ref",
            `unresolved element ref "${refQName}"`,
            refQName,
          );
          if (allowMissingImports) {
            const effectiveCardinality = combineCardinality(
              inheritedCardinality,
              parseCardinality(child),
            );
            fields.push(
              buildRefField(
                effectiveCardinality,
                refQName,
                refQName,
                child["@_nillable"] === true || child["@_nillable"] === "true",
                choiceGroup,
                choiceBranch,
              ),
            );
          }
        }
        continue;
      }

      let typeName: QName;
      if (child["@_type"]) {
        // nsMap already maps '' to the declared default xmlns, falling back to
        // the target namespace only when none is declared (#94).
        typeName = resolveTypeQName(String(child["@_type"]), nsMap, diagnostics);
      } else {
        const inlineComplex = nodeChildren(child).find(
          ([key]) => getNodeTagLocalName(key) === "complexType",
        )?.[1];
        const inlineSimple = nodeChildren(child).find(
          ([key]) => getNodeTagLocalName(key) === "simpleType",
        )?.[1];
        if (inlineComplex) {
          let local: string;
          if (parentTypeName) {
            local = `${sanitizeTsIdentifier(parentTypeName)}_${sanitizeTsIdentifier(name)}_Type`;
          } else {
            syntheticTypes.counter.value++;
            local = `anonymous_Type${syntheticTypes.counter.value}`;
          }
          let candidate = local;
          let collisionIdx = 2;
          while (
            complexTypes[toClark(syntheticTypes.targetNs, candidate)] ||
            syntheticTypes.simpleTypes[toClark(syntheticTypes.targetNs, candidate)]
          ) {
            candidate = `${local}_${collisionIdx++}`;
          }
          const syntheticName = toClark(syntheticTypes.targetNs, candidate);
          complexTypes[syntheticName] = { name: syntheticName, fields: [] };
          deferredSyntheticTypes.push({
            typeName: syntheticName,
            container: inlineComplex,
            ownerNs,
            nsMap,
            formDefaults,
          });
          typeName = syntheticName;
        } else if (inlineSimple) {
          const hint = parentTypeName
            ? `${sanitizeTsIdentifier(parentTypeName)}_${sanitizeTsIdentifier(name)}`
            : undefined;
          typeName = synthesizeInlineSimpleType(
            inlineSimple,
            nsMap,
            syntheticTypes,
            hint,
            diagnostics,
            parentTypeName !== undefined,
          );
        } else {
          // An element with no type declaration is xs:anyType — open content.
          typeName = toClark(XSD_NS, "anyType");
        }
      }
      const effectiveCardinality = combineCardinality(
        inheritedCardinality,
        parseCardinality(child),
      );
      const description = extractDocumentation(child);
      fields.push({
        ...effectiveCardinality,
        kind: "element",
        qname: toClark(
          resolveDeclaredFieldNamespace(ownerNs, "element", child["@_form"], formDefaults),
          name,
        ),
        typeName,
        nillable: child["@_nillable"] === true || child["@_nillable"] === "true",
        ...optProp("choiceGroup", choiceGroup),
        ...optProp("choiceBranch", choiceBranch),
        ...(child["@_default"] !== undefined && { defaultValue: String(child["@_default"]) }),
        ...(child["@_fixed"] !== undefined && { fixedValue: String(child["@_fixed"]) }),
        ...optProp("description", description),
      });
      continue;
    }

    if (localTag === "attribute") {
      const name = String(child["@_name"] ?? "");
      const ref = child["@_ref"] ? String(child["@_ref"]) : "";
      if (!name && !ref) {
        continue;
      }

      if (ref) {
        const refQName = resolveTypeQName(ref, nsMap, diagnostics);
        const referenced = attributes[refQName];
        if (!referenced) {
          report(
            diagnostics,
            "unresolved-attribute-ref",
            `unresolved attribute ref "${refQName}"`,
            refQName,
          );
        }
        const description = extractDocumentation(child) ?? referenced?.description;
        fields.push({
          ...combineCardinality(inheritedCardinality, {
            minOccurs: child["@_use"] === "required" ? 1 : 0,
            maxOccurs: 1,
          }),
          kind: "attribute",
          qname: refQName,
          typeName: referenced?.typeName ?? toClark(XSD_NS, "string"),
          ...(child["@_default"] !== undefined && { defaultValue: String(child["@_default"]) }),
          ...(child["@_fixed"] !== undefined && { fixedValue: String(child["@_fixed"]) }),
          ...optProp("description", description),
        });
        continue;
      }

      let attrTypeName: QName;
      if (child["@_type"]) {
        attrTypeName = resolveTypeQName(String(child["@_type"]), nsMap, diagnostics);
      } else {
        const inlineSimple = nodeChildren(child).find(
          ([key]) => getNodeTagLocalName(key) === "simpleType",
        )?.[1];
        if (inlineSimple) {
          const hint = parentTypeName
            ? `${sanitizeTsIdentifier(parentTypeName)}_${sanitizeTsIdentifier(name)}`
            : undefined;
          attrTypeName = synthesizeInlineSimpleType(
            inlineSimple,
            nsMap,
            syntheticTypes,
            hint,
            diagnostics,
            parentTypeName !== undefined,
          );
        } else {
          attrTypeName = resolveTypeQName(undefined, nsMap, diagnostics);
        }
      }
      const attrDescription = extractDocumentation(child);
      fields.push({
        ...combineCardinality(inheritedCardinality, {
          minOccurs: child["@_use"] === "required" ? 1 : 0,
          maxOccurs: 1,
        }),
        kind: "attribute",
        qname: toClark(
          resolveDeclaredFieldNamespace(ownerNs, "attribute", child["@_form"], formDefaults),
          name,
        ),
        typeName: attrTypeName,
        ...(child["@_default"] !== undefined && { defaultValue: String(child["@_default"]) }),
        ...(child["@_fixed"] !== undefined && { fixedValue: String(child["@_fixed"]) }),
        ...optProp("description", attrDescription),
      });
      continue;
    }

    if (localTag === "any" || localTag === "anyAttribute") {
      wildcards.push({
        kind: localTag,
        namespaceConstraint: String(child["@_namespace"] ?? "##any"),
      });
      continue;
    }

    if (localTag === "sequence" || localTag === "all") {
      collectFields(child, ctx, {
        ownerNs,
        fields,
        wildcards,
        ...optProp("choiceGroup", choiceGroup),
        inheritedCardinality: combineCardinality(inheritedCardinality, parseCardinality(child)),
        ...optProp("choiceBranch", choiceBranch),
        ...optProp("parentTypeName", parentTypeName),
      });
      continue;
    }

    if (localTag === "choice") {
      const groupId = `${ctx.choiceCounter.value++}`;
      const choiceCard = combineCardinality(inheritedCardinality, parseCardinality(child));
      ctx.choiceGroupCardinality.set(groupId, choiceCard);
      // Each direct child of the xs:choice is one branch. Branch identity is
      // threaded through as choiceBranch so fields inlined from a group ref or
      // nested compositor stay together as a single branch (#73 / ipo-style
      // shipTo+billTo vs singleAddress choices).
      let branchIndex = 0;
      for (const [branchTag, branchChild] of nodeChildren(child)) {
        const branchLocal = getNodeTagLocalName(branchTag);
        if (
          branchLocal !== "element" &&
          branchLocal !== "group" &&
          branchLocal !== "sequence" &&
          branchLocal !== "choice" &&
          branchLocal !== "all" &&
          branchLocal !== "any"
        ) {
          continue;
        }
        const branchId = `${groupId}.${branchIndex++}`;
        collectFields({ [branchTag]: branchChild }, ctx, {
          ownerNs,
          fields,
          wildcards,
          choiceGroup: groupId,
          inheritedCardinality: combineCardinality(inheritedCardinality, parseCardinality(child)),
          choiceBranch: branchId,
          ...optProp("parentTypeName", parentTypeName),
        });
      }
      continue;
    }

    if (localTag === "group") {
      const ref = child["@_ref"] ? String(child["@_ref"]) : "";
      if (!ref) {
        continue;
      }
      const refQName = resolveTypeQName(ref, nsMap, diagnostics);
      expandGroupRef(
        refQName,
        groups[refQName],
        ctx,
        {
          ownerNs,
          fields,
          wildcards,
          ...optProp("choiceGroup", choiceGroup),
          inheritedCardinality: combineCardinality(inheritedCardinality, parseCardinality(child)),
          ...optProp("choiceBranch", choiceBranch),
          ...optProp("parentTypeName", parentTypeName),
        },
        ctx.expansionStack.groups,
        "unresolved-group-ref",
        "unresolved group ref",
        "circular-group-ref",
      );
      continue;
    }

    if (localTag === "attributeGroup") {
      const ref = child["@_ref"] ? String(child["@_ref"]) : "";
      if (!ref) {
        continue;
      }
      const refQName = resolveTypeQName(ref, nsMap, diagnostics);
      expandGroupRef(
        refQName,
        attributeGroups[refQName],
        ctx,
        {
          ownerNs,
          fields,
          wildcards,
          ...optProp("choiceGroup", choiceGroup),
          inheritedCardinality,
          ...optProp("choiceBranch", choiceBranch),
          ...optProp("parentTypeName", parentTypeName),
        },
        ctx.expansionStack.attributeGroups,
        "unresolved-attribute-group-ref",
        "unresolved attributeGroup ref",
      );
      continue;
    }

    if (localTag === "simpleContent") {
      const derivation = nodeChildren(child).find(([key]) => {
        const local = getNodeTagLocalName(key);
        return local === "extension" || local === "restriction";
      })?.[1];
      if (!derivation) {
        continue;
      }
      const baseAttr = derivation["@_base"];
      if (baseAttr && typeof baseAttr === "string") {
        const baseType = resolveTypeQName(baseAttr, nsMap, diagnostics);
        let textType = baseType;
        const seenAttrs = new Set<string>();
        // Type-level cycle guard: circular simpleContent bases (invalid XSD)
        // would otherwise spin forever once all types are collected (#94).
        const seenTypes = new Set<QName>([baseType]);
        let current = complexTypes[baseType];
        while (current) {
          const tf = current.fields.find((f) => f.kind === "text");
          if (!tf) {
            break;
          }
          for (const f of current.fields) {
            if (f.kind === "attribute" && !seenAttrs.has(f.qname)) {
              seenAttrs.add(f.qname);
              // Copy the field so the derived type does not alias the base's object.
              fields.push({ ...f });
            }
          }
          textType = tf.typeName;
          if (seenTypes.has(textType)) {
            break;
          }
          seenTypes.add(textType);
          current = complexTypes[textType];
        }
        fields.push({
          ...inheritedCardinality,
          kind: "text",
          qname: toClark(ownerNs, "_text"),
          typeName: textType,
        });
      }
      collectFields(derivation, ctx, {
        ownerNs,
        fields,
        wildcards,
        ...optProp("choiceGroup", choiceGroup),
        inheritedCardinality,
        ...optProp("choiceBranch", choiceBranch),
        ...optProp("parentTypeName", parentTypeName),
      });
      continue;
    }

    if (localTag === "complexContent") {
      const derivation = nodeChildren(child).find(([key]) => {
        const local = getNodeTagLocalName(key);
        return local === "extension" || local === "restriction";
      })?.[1];
      if (!derivation) {
        continue;
      }
      collectFields(derivation, ctx, {
        ownerNs,
        fields,
        wildcards,
        ...optProp("choiceGroup", choiceGroup),
        inheritedCardinality,
        ...optProp("choiceBranch", choiceBranch),
        ...optProp("parentTypeName", parentTypeName),
      });
    }
  }
};

// Extract the base type of a complexContent/xs:extension derivation, if any.
const extractExtensionBase = (
  container: AnyNode,
  nsMap: Record<string, string>,
  diagnostics: Diagnostic[],
): QName | undefined => {
  const complexContent = nodeChildren(container).find(
    ([key]) => getNodeTagLocalName(key) === "complexContent",
  )?.[1];
  const extensionNode = complexContent
    ? nodeChildren(complexContent).find(([key]) => getNodeTagLocalName(key) === "extension")?.[1]
    : undefined;
  return extensionNode?.["@_base"]
    ? resolveTypeQName(String(extensionNode["@_base"]), nsMap, diagnostics)
    : undefined;
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

export const parseXsd = (files: string[], opts?: ParseXsdOptions): XsdIr => {
  const queue: QueueEntry[] = files.map((file) => ({
    file: path.resolve(file),
    entryPoint: true,
  }));

  const simpleTypes: Record<string, SimpleTypeDef> = {};
  const complexTypes: Record<string, ComplexTypeDef> = {};
  const elements: Record<string, ElementDef> = {};
  const rootElements: QName[] = [];
  const targetNamespaces = new Set<string>();
  const deferredInlineTypes: DeferredInlineType[] = [];
  const deferredSyntheticTypes: DeferredInlineType[] = [];
  const syntheticTypeCounter = { value: 0 };
  // Choice group ids are internal only (never emitted), but fields merged from
  // a base type and its extension must not share an id — an extension's
  // xs:choice is a separate group appended after the base content. A shared
  // counter keeps every group's id unique across the parse.
  const choiceCounter = { value: 0 };
  const groups: Record<string, GroupEntry> = {};
  const attributeGroups: Record<string, GroupEntry> = {};
  const attributes: Record<string, GlobalAttributeDecl> = {};
  const diagnostics: Diagnostic[] = [];

  const choiceGroupsMeta = (
    entries: Map<string, Cardinality> | Record<string, Cardinality>,
  ): Pick<ComplexTypeDef, "choiceGroups"> => {
    const record = entries instanceof Map ? Object.fromEntries(entries) : entries;
    return Object.keys(record).length > 0 ? { choiceGroups: record } : {};
  };

  const fieldContext = (
    nsMap: Record<string, string>,
    formDefaults: SchemaFormDefaults,
    targetNs: string,
  ): FieldCollectionContext => ({
    nsMap,
    formDefaults,
    elements,
    choiceCounter,
    choiceGroupCardinality: new Map(),
    complexTypes,
    syntheticTypes: { targetNs, counter: syntheticTypeCounter, simpleTypes, complexTypes },
    groups,
    attributeGroups,
    deferredSyntheticTypes,
    attributes,
    diagnostics: diagnostics,
    allowMissingImports: opts?.allowMissingImports ?? false,
    expansionStack: { groups: new Set(), attributeGroups: new Set() },
  });

  // Build import/include graph for topological sorting
  const depGraph: Map<string, string[]> = new Map();

  const addDependency = (from: string, to: string): void => {
    const resolvedFrom = path.resolve(from);
    const resolvedTo = path.resolve(to);
    if (!depGraph.has(resolvedFrom)) {
      depGraph.set(resolvedFrom, []);
    }
    depGraph.get(resolvedFrom)?.push(resolvedTo);
  };

  // First pass: collect all files and their dependencies
  const allFiles: Array<{
    entry: QueueEntry;
    schemaNode: AnyNode;
    nsMap: Record<string, string>;
    targetNs: string;
    formDefaults: SchemaFormDefaults;
  }> = [];

  // Helpers for composite scan keys (file + inherited namespace) so chameleon schemas
  // included by multiple schemas with different target namespaces are scanned once per
  // distinct inherited namespace rather than once globally.
  const scanKey = (file: string, inheritedTargetNs?: string): string =>
    `${file}|${inheritedTargetNs ?? ""}`;

  {
    const pending = new Map<string, QueueEntry>();
    for (const qe of queue) {
      pending.set(scanKey(qe.file, qe.inheritedTargetNs), qe);
    }
    const scanned = new Set<string>();

    while (pending.size > 0) {
      const firstKey = pending.keys().next().value as string;
      const entry = pending.get(firstKey);
      if (!entry) {
        continue;
      }
      pending.delete(firstKey);
      const entryKey = scanKey(entry.file, entry.inheritedTargetNs);
      if (scanned.has(entryKey)) {
        continue;
      }
      scanned.add(entryKey);

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
        report(
          diagnostics,
          "unresolved-import",
          `unable to read schema "${entry.file}"`,
          entry.file,
        );
        continue;
      }
      allFiles.push({ entry, schemaNode, nsMap, targetNs, formDefaults });

      for (const [tag, child] of nodeChildren(schemaNode)) {
        const localTag = getNodeTagLocalName(tag);
        const schemaLocation = child["@_schemaLocation"] ? String(child["@_schemaLocation"]) : "";
        if (!schemaLocation) {
          continue;
        }

        // schemaLocation is only a hint: remote URLs are never read as local
        // files (and "must not resolve" tests rely on that). Skip with a
        // diagnostic instead of crashing.
        if (/^https?:/i.test(schemaLocation)) {
          report(
            diagnostics,
            "remote-schema-location",
            `remote schemaLocation "${schemaLocation}" skipped (not resolved)`,
            schemaLocation,
          );
          continue;
        }

        const resolved = path.resolve(path.dirname(entry.file), schemaLocation);
        addDependency(entry.file, resolved);

        if (localTag === "import" || localTag === "include" || localTag === "redefine") {
          const ns = localTag === "include" ? targetNs || entry.inheritedTargetNs || "" : undefined;
          const depKey = scanKey(resolved, ns);
          if (scanned.has(depKey)) {
            continue;
          }

          if (!pending.has(depKey)) {
            pending.set(depKey, {
              file: resolved,
              ...optProp("inheritedTargetNs", ns),
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
    if (permanent.has(node)) {
      return;
    }
    if (temporary.has(node)) {
      return;
    }
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

  // Redefine overrides, in the order the xs:redefine elements were seen.
  const redefineOverrides: RedefineOverride[] = [];

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

  for (const {
    entry,
    schemaNode,
    nsMap: fileNsMap,
    targetNs: fileTargetNs,
    formDefaults: fileFormDefaults,
  } of allFiles) {
    const effectiveNs = fileTargetNs || entry.inheritedTargetNs || "";
    // Namespace-less schemas contribute no entry — '' would be noise (#79).
    if (effectiveNs) {
      targetNamespaces.add(effectiveNs);
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
    // Pass 1: collect all declarations before processing fields
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
        simpleTypes[qname] = parseSimpleTypeDef(
          qname,
          child,
          resolveNsMap,
          simpleTypes,
          diagnostics,
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
        groups[qname] = {
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
        attributeGroups[qname] = {
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
          typeName = resolveTypeQName(String(child["@_type"]), resolveNsMap, diagnostics);
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
                  counter: syntheticTypeCounter,
                  simpleTypes,
                  complexTypes,
                },
                name,
                diagnostics,
              )
            : toClark(XSD_NS, "string");
        }
        const attrDescription = extractDocumentation(child);
        attributes[qname] = {
          typeName,
          ...optProp("description", attrDescription),
        };
      }
    }

    // Collect redefine overrides (children of xs:redefine elements)
    for (const [tag, child] of schemaChildren) {
      const localTag = getNodeTagLocalName(tag);
      if (localTag === "redefine") {
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
            const schemaLocation = child["@_schemaLocation"]
              ? String(child["@_schemaLocation"])
              : "";
            if (schemaLocation) {
              redefineOverrides.push({
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

    pendingFiles.push({
      effectiveNs,
      resolveNsMap,
      formDefaults: fileFormDefaults,
      elementNodes,
      complexTypeNodes,
    });
  }

  // Group/attributeGroup redefines must land before any field collection:
  // references to them are inlined into consumers at collection time (#78).
  // Self-refs inside the override are expanded against the original first.
  for (const override of redefineOverrides) {
    if (override.kind === "group") {
      groups[override.qname] = {
        ownerNs: override.targetNs,
        formDefaults: override.formDefaults,
        nsMap: override.nsMap,
        node: expandRedefineSelfRefs(
          override.node,
          "group",
          override.qname,
          groups[override.qname]?.node,
          override.nsMap,
          diagnostics,
        ),
      };
    } else if (override.kind === "attributeGroup") {
      attributeGroups[override.qname] = {
        ownerNs: override.targetNs,
        formDefaults: override.formDefaults,
        nsMap: override.nsMap,
        node: expandRedefineSelfRefs(
          override.node,
          "attributeGroup",
          override.qname,
          attributeGroups[override.qname]?.node,
          override.nsMap,
          diagnostics,
        ),
      };
    }
  }

  // Pass 2: process top-level elements
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
        ? resolveTypeQName(String(child["@_type"]), resolveNsMap, diagnostics)
        : undefined;

      if (!typeName) {
        const inlineComplex = nodeChildren(child).find(
          ([key]) => getNodeTagLocalName(key) === "complexType",
        )?.[1];
        if (inlineComplex) {
          typeName = toClark(effectiveNs, `anonymous_${name}_Type`);
          complexTypes[typeName] = { name: typeName, fields: [] };
          deferredInlineTypes.push({
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
              counter: syntheticTypeCounter,
              simpleTypes,
              complexTypes,
            },
            name,
            diagnostics,
          );
        }
      }

      if (!typeName) {
        // An element with no type declaration is xs:anyType — open content.
        typeName = toClark(XSD_NS, "anyType");
      }

      const qname = toClark(effectiveNs, name);
      const description = extractDocumentation(child);
      elements[qname] = {
        name: qname,
        typeName,
        cardinality: parseCardinality(child),
        nillable: child["@_nillable"] === true || child["@_nillable"] === "true",
        ...optProp("description", description),
        ...(child["@_default"] !== undefined && { defaultValue: String(child["@_default"]) }),
        ...(child["@_fixed"] !== undefined && { fixedValue: String(child["@_fixed"]) }),
      };
      if (!rootElements.includes(qname)) {
        rootElements.push(qname);
      }
    }
  }

  // Pass 3: process complex types — references resolve against all files' declarations
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
      const fCtx = fieldContext(resolveNsMap, fileFormDefaults, effectiveNs);
      collectFields(child, fCtx, {
        ownerNs: effectiveNs,
        fields,
        wildcards,
        inheritedCardinality: { minOccurs: 1, maxOccurs: 1 },
        parentTypeName: clarkToLocal(qname),
      });
      const baseType = extractExtensionBase(child, resolveNsMap, diagnostics);
      const description = extractDocumentation(child);

      complexTypes[qname] = {
        name: qname,
        fields,
        ...optProp("baseType", baseType),
        ...optProp("description", description),
        ...choiceGroupsMeta(fCtx.choiceGroupCardinality),
        ...(wildcards.length > 0 ? { wildcards } : {}),
      };
    }
  }

  // Apply redefine overrides — replace or augment types in the included schemas
  for (const override of redefineOverrides) {
    if (override.kind === "complexType") {
      const fields: IrField[] = [];
      const wildcards: WildcardDef[] = [];
      const fCtx = fieldContext(override.nsMap, override.formDefaults, override.targetNs);
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
        ? resolveTypeQName(String(derivationNode["@_base"]), override.nsMap, diagnostics)
        : undefined;
      const description = extractDocumentation(override.node);
      const choiceGroupMeta = choiceGroupsMeta(fCtx.choiceGroupCardinality);
      const effectiveBaseType = baseType === override.qname ? undefined : baseType;
      if (baseType === override.qname && derivationKind === "extension") {
        const original = complexTypes[override.qname];
        if (original) {
          const mergedChoiceGroups = {
            ...original.choiceGroups,
            ...Object.fromEntries(fCtx.choiceGroupCardinality),
          };
          const mergedWildcards = [...(original.wildcards ?? []), ...wildcards];
          complexTypes[override.qname] = {
            name: override.qname,
            fields: [...original.fields, ...fields],
            ...optProp("baseType", original.baseType),
            ...optProp("description", description ?? original.description),
            ...choiceGroupsMeta(mergedChoiceGroups),
            ...(mergedWildcards.length > 0 ? { wildcards: mergedWildcards } : {}),
          };
        } else {
          complexTypes[override.qname] = {
            name: override.qname,
            fields,
            ...optProp("baseType", effectiveBaseType),
            ...optProp("description", description),
            ...choiceGroupMeta,
            ...(wildcards.length > 0 ? { wildcards } : {}),
          };
        }
      } else {
        complexTypes[override.qname] = {
          name: override.qname,
          fields,
          ...optProp("baseType", effectiveBaseType),
          ...optProp("description", description),
          ...choiceGroupMeta,
          ...(wildcards.length > 0 ? { wildcards } : {}),
        };
      }
    } else if (override.kind === "simpleType") {
      // Preserve the original definition before it is replaced: a self-base in
      // the override (restriction base="own name") points at the ORIGINAL per
      // xs:redefine semantics, not at the override itself.
      const original = simpleTypes[override.qname];

      // Drop synthetic inline item/member types created for the previous definition
      // so swapping list ↔ union (or changing item/member shape) does not leave orphans.
      const orphanPrefix = `${override.qname}_`;
      for (const existingName of Object.keys(simpleTypes)) {
        if (existingName.startsWith(orphanPrefix)) {
          delete simpleTypes[existingName];
        }
      }

      const def = parseSimpleTypeDef(
        override.qname,
        override.node,
        override.nsMap,
        simpleTypes,
        diagnostics,
      );
      if (def.kind === "restriction" && def.baseType === override.qname) {
        if (original) {
          // Name the preserved original outside the `${qname}_` synthetic
          // prefix — the orphan cleanup above deletes that space on every
          // redefine in the chain. Bump the suffix for chained redefines.
          let originalName = `${override.qname}-redefined` as QName;
          for (let i = 2; simpleTypes[originalName] !== undefined; i++) {
            originalName = `${override.qname}-redefined-${i}` as QName;
          }
          simpleTypes[originalName] = { ...original, name: originalName };
          def.baseType = originalName;
        } else {
          report(
            diagnostics,
            "circular-redefinition",
            `circular simpleType redefinition "${override.qname}" without an original definition`,
            override.qname,
          );
        }
      }
      simpleTypes[override.qname] = def;
    }
  }

  // Process deferred inline types now that all elements are collected
  const processDeferredType = ({
    typeName,
    container,
    ownerNs,
    nsMap,
    formDefaults,
  }: DeferredInlineType) => {
    const fields: IrField[] = [];
    const wildcards: WildcardDef[] = [];
    const fCtx = fieldContext(nsMap, formDefaults, ownerNs);
    collectFields(container, fCtx, {
      ownerNs,
      fields,
      wildcards,
      inheritedCardinality: { minOccurs: 1, maxOccurs: 1 },
      parentTypeName: clarkToLocal(typeName),
    });
    const baseType = extractExtensionBase(container, nsMap, diagnostics);
    complexTypes[typeName] = {
      name: typeName,
      fields,
      ...optProp("baseType", baseType),
      ...choiceGroupsMeta(fCtx.choiceGroupCardinality),
      ...(wildcards.length > 0 ? { wildcards } : {}),
    };
  };

  for (const deferred of deferredInlineTypes) {
    processDeferredType(deferred);
  }

  // Process synthetic types created during field collection (deferred so all attributeGroups are available)
  while (deferredSyntheticTypes.length > 0) {
    const next = deferredSyntheticTypes.shift();
    if (next) {
      processDeferredType(next);
    }
  }

  const mergedComplexTypes: Record<string, ComplexTypeDef> = {};
  const resolveMergedFields = (typeName: string, stack: Set<string>): IrField[] => {
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
  // Wildcards inherit down the extension chain, like fields.
  const resolveMergedWildcards = (typeName: string, stack: Set<string>): WildcardDef[] => {
    const type = complexTypes[typeName];
    if (!type) {
      return [];
    }
    if (!type.baseType || !complexTypes[type.baseType] || stack.has(typeName)) {
      return type?.wildcards ?? [];
    }
    const nextStack = new Set(stack);
    nextStack.add(typeName);
    return [...resolveMergedWildcards(type.baseType, nextStack), ...(type.wildcards ?? [])];
  };
  // Choice group cardinality inherits down the extension chain, like fields.
  const resolveMergedChoiceGroups = (
    typeName: string,
    stack: Set<string>,
  ): Record<string, Cardinality> | undefined => {
    const type = complexTypes[typeName];
    if (!type) {
      return undefined;
    }
    if (!type.baseType || !complexTypes[type.baseType] || stack.has(typeName)) {
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

  for (const [name, type] of Object.entries(complexTypes)) {
    const mergedWildcards = resolveMergedWildcards(name, new Set());
    const mergedChoiceGroups = resolveMergedChoiceGroups(name, new Set());
    mergedComplexTypes[name] = {
      ...type,
      fields: resolveMergedFields(name, new Set()),
      ...(mergedChoiceGroups ? { choiceGroups: mergedChoiceGroups } : {}),
      ...(mergedWildcards.length > 0 ? { wildcards: mergedWildcards } : {}),
    };
  }

  dropCircularSimpleTypeRefs(simpleTypes, diagnostics);

  return {
    targetNamespaces: [...targetNamespaces],
    diagnostics: diagnostics,
    simpleTypes,
    complexTypes: mergedComplexTypes,
    elements,
    rootElements,
  };
};

export { clarkToLocal } from "./qname.js";
