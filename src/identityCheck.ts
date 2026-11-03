// Shared identity-constraint checker. Data-shape pass used by the XML
// runtime and inlined into standalone generated modules.

import type { z } from "zod";
import {
  type AnySchema,
  analyzeField,
  objectDefOf,
  peelOnce,
  unwrapModifiers,
  XSI_TYPE_FIELD,
  xsiTypeUnionDef,
} from "./schemaUtils.js";

// Identity constraints (xs:key / xs:keyref / xs:unique)
//
// Post-parse pass over the validated tree, driven by the identity metadata
// codegen registers on root schemas and element field metas. Semantics per
// XSD 1.0 §3.11.4/§3.11.5: each element occurrence owns an identity-constraint
// table — its own key/unique evaluations merged with the tables propagated up
// from its children (propagation conflicts poison the entry instead of
// erroring) — and a keyref is checked against the table its own element
// carries for the referenced key. Uniqueness is enforced per occurrence of
// the declaring element; a keyref whose referenced key has no table on the
// keyref's element is unsatisfiable. Violations surface as custom ZodError
// issues with data paths, like the choice-group checks.
// ---------------------------------------------------------------------------

export type QName = `{${string}}${string}`;

export type IdentityStep =
  | { axis: "child"; qname: QName }
  | { axis: "attribute"; qname: QName }
  | { axis: "child"; wildcard: true; namespace?: string | undefined }
  | { axis: "attribute"; wildcard: true; namespace?: string | undefined }
  | { axis: "self" };

export type IdentityPath = {
  descendant: boolean;
  steps: IdentityStep[];
};

export type IdentityConstraint = {
  kind: "key" | "keyref" | "unique";
  name: QName;
  refer?: QName;
  selector: IdentityPath[];
  fields: IdentityPath[][];
};

export type NilAttr = [clark: string, lexical: string, qnameNs: Record<string, string> | undefined];

export type WrappedMeta = { kind: "attribute" | "text"; qname: QName };

export type IdentityChoiceFieldMeta = { tag: string; qname: QName };

export type IdentityFieldMeta = {
  kind: "element" | "attribute" | "text" | "any" | "anyAttribute" | "choice";
  qname: QName;
  choice?: { branches: IdentityChoiceFieldMeta[] };
  wrapped?: WrappedMeta;
  qnameValue?: boolean;
  identity?: IdentityConstraint[];
};

export type IdentityTypeMeta = { fields?: Record<string, IdentityFieldMeta> };

export type IdentityRootMeta = {
  identity?: IdentityConstraint[];
  identityElements?: () => Record<string, unknown>;
  hasIdentity?: true;
};

export type IdentityProvenance = {
  lexical?: string | undefined;
  qnameNs?: Record<string, string> | undefined;
  xsiType?: string | undefined;
  nilAttributes?: NilAttr[] | undefined;
};

export type IdentityContext = {
  getRootMeta: (schema: AnySchema) => IdentityRootMeta | undefined;
  getFieldsMeta: (schema: AnySchema) => Record<string, IdentityFieldMeta> | undefined;
  getProvenance: (container: object, key: string, index: number) => IdentityProvenance;
  getSubstQName: (container: object, key: string, index: number) => QName | undefined;
  getRootLexical: (
    schema: AnySchema,
  ) => { lexical?: string | undefined; qnameNs?: Record<string, string> | undefined } | undefined;
  simpleValue: (node: IdentityNode) => unknown;
  coerceLexical: (lexical: string, schema: AnySchema) => unknown;
  getSubstitutionSchema: (substQName: QName, item: AnySchema) => AnySchema;
  getSubstitutionMemberMeta: (schema: AnySchema) => QName | undefined;
  getChoiceBranchSchema: (fieldSchema: AnySchema, tag: string) => AnySchema | undefined;
  getXsiTypeOptionQName: (schema: AnySchema) => QName | undefined;
};

// Field-value extraction yields this for absent/nil/non-simple targets;
// xs:key reports it, xs:unique and xs:keyref skip the node (XSD §3.11.4).
export const IDENTITY_ABSENT: unique symbol = Symbol("identity-absent");
// A field xpath matching more than one node is a violation for every kind
// (§3.11.4: a key sequence needs exactly one value per field).
export const IDENTITY_MULTIPLE: unique symbol = Symbol("identity-multiple");
// A field target that is not simple-typed (element with complex content)
// cannot contribute to a key sequence — a violation for every kind.
export const IDENTITY_COMPLEX: unique symbol = Symbol("identity-complex");

export type IdentityNode = {
  elementSchemas?: Record<string, AnySchema> | undefined;
  lexical?: string | undefined;
  value: unknown;
  schema: AnySchema | undefined;
  /** Element qname this node was reached through (undefined for scope roots). */
  qname?: QName | undefined;
  path: readonly (string | number)[];
  /** Prefix→URI bindings for QName-typed values. */
  qnameNs?: Record<string, string> | undefined;
  /**
   * xsi:type of an open-content occurrence (Clark). Identity equality is
   * per-datatype (§3.11.1), so the annotation joins the compared value.
   */
  xsiType?: string | undefined;
  /** Attributes of a nil occurrence — nil collapses content, not attributes. */
  nilAttributes?: NilAttr[] | undefined;
  /** Set when this element occurrence is a collapsed value wrapper. */
  wrapped?: WrappedMeta | undefined;
};

const splitClark = (qname: string): { namespace: string; local: string } => {
  if (!qname.startsWith("{")) {
    return { namespace: "", local: qname };
  }
  const close = qname.indexOf("}");
  return { namespace: qname.slice(1, close), local: qname.slice(close + 1) };
};

// One element occurrence's identity-constraint table: per constraint name,
// tuple key → first-seen node path; plus the tuple keys poisoned by
// propagation conflicts (§3.11.5: conflicting propagated entries vanish).
type IdentityTable = {
  entries: Map<QName, Map<string, string>>;
  poisoned: Map<QName, Set<string>>;
};

type IdentityState = {
  issues: z.core.$ZodIssue[];
  elementSchemas?: Record<string, AnySchema> | undefined;
};

// Value-space tuple keys (XSD compares typed values: 1 equals 01 for xs:int).
// Length-prefixing strings keeps tuple concatenation collision-free; NaN and
// -0 key like their XSD value-space equals.
const identityValueKey = (value: unknown): string => {
  if (value === null) {
    return "null:";
  }
  if (value === undefined) {
    return "undef:";
  }
  switch (typeof value) {
    case "string":
      return `str:${value.length}:${value}`;
    case "number":
      return `num:${value}`;
    case "bigint":
      return `big:${value.toString()}`;
    case "boolean":
      return `bool:${value}`;
    case "object":
      if (Array.isArray(value)) {
        return `arr:[${value.map(identityValueKey).join(",")}]`;
      }
      // Structured datatypes (xsdDateTime): plain objects with fixed keys.
      return `obj:{${Object.keys(value as Record<string, unknown>)
        .sort()
        .map(
          (k) => `${JSON.stringify(k)}=${identityValueKey((value as Record<string, unknown>)[k])}`,
        )
        .join(",")}}`;
    default:
      return `other:${String(value)}`;
  }
};

const identityTupleKey = (values: unknown[]): string => values.map(identityValueKey).join("|");

const identityTupleDisplay = (values: unknown[]): string =>
  values
    .map((v) => {
      // xsi:type-tagged open values read as `decimal 1`, not the wrapper.
      if (v !== null && typeof v === "object" && !Array.isArray(v) && "$xsiType" in v) {
        const tagged = v as { $xsiType: string; $value: unknown };
        return `${splitClark(tagged.$xsiType).local} ${JSON.stringify(tagged.$value)}`;
      }
      if (v !== null && typeof v === "object" && !Array.isArray(v) && "$decimal" in v) {
        return `decimal ${JSON.stringify((v as { $decimal: unknown }).$decimal)}`;
      }
      return typeof v === "bigint" ? v.toString() : (JSON.stringify(v) ?? String(v));
    })
    .join(", ");

// xsi:type union dispatch on an occurrence's discriminant: the matching
// derived variant, else the declared (first) option.
const identityXsiMember = (
  ctx: IdentityContext,
  unionOptions: readonly AnySchema[],
  occValue: unknown,
  fallback: AnySchema,
): AnySchema => {
  const xsiType =
    occValue !== null && typeof occValue === "object"
      ? (occValue as Record<string, unknown>)[XSI_TYPE_FIELD]
      : undefined;
  const match =
    typeof xsiType === "string"
      ? unionOptions.find((option) => ctx.getXsiTypeOptionQName(option) === xsiType)
      : undefined;
  return match ?? unionOptions[0] ?? fallback;
};

// The schema one occurrence was parsed with: member dispatch via the recorded
// substitution tag, then xsi:type union dispatch via the xsiType discriminant.
const identityOccurrenceSchema = (
  ctx: IdentityContext,
  fieldSchema: AnySchema,
  container: object,
  key: string,
  occValue: unknown,
  index: number,
): AnySchema => {
  let item = analyzeField(fieldSchema).itemSchema;
  const substQName = ctx.getSubstQName(container, key, index);
  if (typeof substQName === "string") {
    item = ctx.getSubstitutionSchema(substQName, item);
  } else {
    const def = unwrapModifiers(item)._zod.def;
    if (def.type === "union") {
      item =
        (def as z.core.$ZodUnionDef).options.find(
          (option) => ctx.getSubstitutionMemberMeta(option as AnySchema) !== undefined,
        ) ?? item;
    }
  }
  const union = xsiTypeUnionDef(item);
  if (union !== undefined) {
    item = identityXsiMember(ctx, union.options as readonly AnySchema[], occValue, item);
  }
  return item;
};

// A NameTest step matches an instance tag: exact qname, or — for `*`/`ns:*`
// steps (both qname and namespace undefined / namespace-scoped) — any tag
// optionally confined to one namespace.
const identityStepMatches = (
  stepQname: QName | undefined,
  stepNs: string | undefined,
  qname: QName | undefined,
): boolean => {
  if (stepQname !== undefined) {
    return qname === stepQname;
  }
  return stepNs === undefined || splitClark(qname ?? "{}").namespace === stepNs;
};

// One item of an ergonomic repeated-choice array read as its branch
// occurrence: the tag present on the item selects the branch qname/schema,
// exactly as the parse walk built it.
const identityChoiceBranch = (
  ctx: IdentityContext,
  fieldSchema: AnySchema,
  branch: IdentityChoiceFieldMeta,
  item: Record<string, unknown>,
): { value: unknown; schema: AnySchema | undefined } | undefined => {
  if (!(branch.tag in item)) {
    return undefined;
  }
  const value = item[branch.tag];
  let schema = ctx.getChoiceBranchSchema(fieldSchema, branch.tag);
  if (schema !== undefined) {
    const union = xsiTypeUnionDef(schema);
    if (union !== undefined) {
      schema = identityXsiMember(ctx, union.options as readonly AnySchema[], value, schema);
    }
  }
  return { value, schema };
};

// Element children of a data node: declared fields via the fields meta, plus
// open-shape extras, which are keyed by their Clark qname already. Filter by
// exact step qname, or by namespace for an `ns:*` step (both undefined: all
// children). A substitution-group occurrence is exposed under its actual
// member tag — identity xpaths match instance tags, substitution-group
// membership does not apply.
const identityChildren = (
  ctx: IdentityContext,
  node: IdentityNode,
  qname: QName | undefined,
  namespace?: string,
): IdentityNode[] => {
  const matches = (childQName: QName): boolean => identityStepMatches(qname, namespace, childQName);
  const { value } = node;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const obj = value as Record<string, unknown>;
  const out: IdentityNode[] = [];
  const declaredKeys = new Set<string>();
  const fields = node.schema === undefined ? undefined : ctx.getFieldsMeta(node.schema);
  const shape = node.schema === undefined ? {} : (objectDefOf(node.schema)?.shape ?? {});
  if (fields !== undefined) {
    for (const [key, fieldMeta] of Object.entries(fields)) {
      declaredKeys.add(key);
      const fieldValue = obj[key];
      const fieldSchema = shape[key];
      if (fieldValue === undefined || fieldSchema === undefined) {
        continue;
      }
      if (fieldMeta.kind === "choice") {
        const choice = fieldMeta.choice;
        if (choice === undefined || !Array.isArray(fieldValue)) {
          continue;
        }
        fieldValue.forEach((item, i) => {
          if (item === null || typeof item !== "object" || Array.isArray(item)) {
            return;
          }
          const tagged = item as Record<string, unknown>;
          const provenance = ctx.getProvenance(obj, key, i);
          for (const branch of choice.branches) {
            const occurrence = identityChoiceBranch(ctx, fieldSchema, branch, tagged);
            if (occurrence === undefined || !matches(branch.qname)) {
              continue;
            }
            out.push({
              elementSchemas: node.elementSchemas,
              ...provenance,
              value: occurrence.value,
              schema: occurrence.schema,
              qname: branch.qname,
              path: [...node.path, key, i],
            });
          }
        });
        continue;
      }
      if (fieldMeta.kind !== "element") {
        continue;
      }
      const isArray = analyzeField(fieldSchema).isArray;
      const occurrences = isArray ? (fieldValue as unknown[]) : [fieldValue];
      occurrences.forEach((occ, i) => {
        const effectiveQName = (ctx.getSubstQName(obj, key, i) ?? fieldMeta.qname) as QName;
        if (!matches(effectiveQName)) {
          return;
        }
        out.push({
          elementSchemas: node.elementSchemas,
          ...ctx.getProvenance(obj, key, i),
          value: occ,
          schema: identityOccurrenceSchema(ctx, fieldSchema, obj, key, occ, i),
          qname: effectiveQName,
          path: [...node.path, key, ...(isArray ? [i] : [])],
          wrapped: fieldMeta.wrapped,
        });
      });
    }
  }
  for (const [key, entryValue] of Object.entries(obj)) {
    if (declaredKeys.has(key) || !key.startsWith("{")) {
      continue;
    }
    if (!matches(key as QName)) {
      continue;
    }
    const isArray = Array.isArray(entryValue);
    const occurrences = isArray ? (entryValue as unknown[]) : [entryValue];
    occurrences.forEach((occ, i) => {
      out.push({
        elementSchemas: node.elementSchemas,
        ...ctx.getProvenance(obj, key, i),
        value: occ,
        schema: node.elementSchemas?.[key],
        qname: key as QName,
        path: [...node.path, key, ...(isArray ? [i] : [])],
      });
    });
  }
  return out;
};

const XSI_NS = "http://www.w3.org/2001/XMLSchema";

// The declared attribute field for a qname, with its value schema. Nil and
// non-nil attribute lookups share this scan.
const findAttributeMeta = (
  ctx: IdentityContext,
  schema: AnySchema | undefined,
  qname: QName,
): { key: string; fieldMeta: IdentityFieldMeta; schema: AnySchema | undefined } | undefined => {
  if (schema === undefined) {
    return undefined;
  }
  const fields = ctx.getFieldsMeta(schema);
  if (fields === undefined) {
    return undefined;
  }
  const shape = objectDefOf(schema)?.shape ?? {};
  for (const [key, fieldMeta] of Object.entries(fields)) {
    if (fieldMeta.kind === "attribute" && fieldMeta.qname === qname) {
      return { key, fieldMeta, schema: shape[key] };
    }
  }
  return undefined;
};

const identityAttributeNode = (
  ctx: IdentityContext,
  node: IdentityNode,
  qname: QName,
): IdentityNode | undefined => {
  if (node.wrapped !== undefined) {
    if (node.wrapped.kind !== "attribute" || node.wrapped.qname !== qname) {
      return undefined;
    }
    return {
      value: node.value,
      schema: node.schema,
      qname,
      path: node.path,
      qnameNs: node.qnameNs,
    };
  }
  const { value } = node;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    // A nil element's attributes survive the collapse to null in the side
    // channel — XSD evaluates attribute fields of nil elements normally.
    const found = node.nilAttributes?.find(([clark]) => clark === qname);
    if (found === undefined) {
      return undefined;
    }
    // Typed key fields compare in value space like the non-nil path (int "01"
    // is int "1"); QName-typed attributes resolve their prefixes against the
    // bindings retained next to the nil lexical.
    const meta = findAttributeMeta(ctx, node.schema, qname);
    let nilSchema: AnySchema | undefined;
    let nilValue: unknown = found[1];
    let nilQNameNs: Record<string, string> | undefined;
    if (meta !== undefined) {
      if (meta.fieldMeta.qnameValue === true) {
        nilQNameNs = found[2];
        nilSchema = meta.schema;
      } else {
        nilSchema = meta.schema;
        if (nilSchema !== undefined) {
          try {
            nilValue = ctx.coerceLexical(found[1], nilSchema);
          } catch {
            nilValue = found[1];
          }
        }
      }
    }
    return {
      value: nilValue,
      lexical: found[1],
      schema: nilSchema,
      qname,
      path: node.path,
      ...(nilQNameNs === undefined ? {} : { qnameNs: nilQNameNs }),
    };
  }
  const obj = value as Record<string, unknown>;
  const meta = findAttributeMeta(ctx, node.schema, qname);
  if (meta !== undefined) {
    const info = splitClark(qname);
    const attrValue = obj[meta.key] ?? obj[`@${info.namespace ? qname : info.local}`];
    if (attrValue === undefined) {
      return undefined;
    }
    const provenance = ctx.getProvenance(obj, meta.key, 0);
    return {
      value: attrValue,
      lexical: provenance.lexical,
      schema: meta.schema,
      qname,
      path: node.path,
      qnameNs: provenance.qnameNs,
    };
  }
  // Open shape: attributes are keyed '@' + clark (no-namespace: '@local').
  const clark = splitClark(qname);
  const openValue = obj[`@${clark.namespace ? `{${clark.namespace}}` : ""}${clark.local}`];
  return openValue === undefined
    ? undefined
    : { value: openValue, schema: undefined, qname, path: node.path };
};

// All attribute nodes of a data node (the `@*`/`@ns:*` field steps): declared
// attributes via the fields meta, open-shape extras, nil-captured attributes.
// XPath's @* covers xsi:nil too — a nil node contributes it implicitly.
const identityAttributeNodes = (
  ctx: IdentityContext,
  node: IdentityNode,
  namespace?: string,
): IdentityNode[] => {
  const inNamespace = (clark: string): boolean =>
    namespace === undefined || splitClark(clark).namespace === namespace;
  if (node.wrapped !== undefined) {
    if (node.wrapped.kind !== "attribute" || !inNamespace(node.wrapped.qname)) {
      return [];
    }
    return [
      {
        value: node.value,
        schema: node.schema,
        qname: node.wrapped.qname,
        path: node.path,
        qnameNs: node.qnameNs,
      },
    ];
  }
  const { value } = node;
  // value === null holds only for xsi:nil=true occurrences (see readOccurrence),
  // so the implicit xsi:nil attribute below cannot leak onto non-nil nodes.
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    const out: IdentityNode[] = (node.nilAttributes ?? [])
      .filter(([clark]) => inNamespace(clark))
      .map(([clark, lexical, qnameNs]) => {
        const meta = findAttributeMeta(ctx, node.schema, clark as QName);
        return {
          value: lexical,
          schema: undefined,
          qname: clark as QName,
          path: node.path,
          ...(meta?.fieldMeta.qnameValue === true && qnameNs !== undefined ? { qnameNs } : {}),
        };
      });
    if (value === null && inNamespace(`{${XSI_NS}}nil`)) {
      out.push({
        value: "true",
        schema: undefined,
        qname: `{${XSI_NS}}nil`,
        path: node.path,
      });
    }
    return out;
  }
  const obj = value as Record<string, unknown>;
  const out: IdentityNode[] = [];
  const declaredKeys = new Set<string>();
  const fields = node.schema === undefined ? undefined : ctx.getFieldsMeta(node.schema);
  if (fields !== undefined) {
    const shape = objectDefOf(node.schema as AnySchema)?.shape ?? {};
    for (const [key, fieldMeta] of Object.entries(fields)) {
      declaredKeys.add(key);
      if (fieldMeta.kind !== "attribute" || !inNamespace(fieldMeta.qname)) {
        continue;
      }
      const attrValue = obj[key];
      if (attrValue === undefined) {
        continue;
      }
      const provenance = ctx.getProvenance(obj, key, 0);
      out.push({
        value: attrValue,
        schema: shape[key],
        qname: fieldMeta.qname,
        path: node.path,
        qnameNs: provenance.qnameNs,
      });
    }
  }
  for (const [key, openValue] of Object.entries(obj)) {
    if (declaredKeys.has(key) || !key.startsWith("@")) {
      continue;
    }
    if (openValue !== undefined && inNamespace(key.slice(1))) {
      out.push({
        value: openValue,
        schema: undefined,
        qname: key.slice(1) as QName,
        path: node.path,
      });
    }
  }
  return out;
};

// Evaluate one restricted-xpath branch against a context node.
const identitySelect = (
  ctx: IdentityContext,
  path: IdentityPath,
  contextNode: IdentityNode,
): IdentityNode[] => {
  let current: IdentityNode[] = [contextNode];
  if (path.descendant) {
    const stack = [contextNode];
    current = [];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) {
        break;
      }
      current.push(node);
      stack.push(...identityChildren(ctx, node, undefined));
    }
  }
  for (const step of path.steps) {
    if (step.axis === "self") {
      continue;
    }
    const next: IdentityNode[] = [];
    for (const node of current) {
      if (step.axis === "attribute") {
        // Attribute steps are only legal as the last xs:field step (enforced
        // at parse time); the value rides as a leaf node.
        if ("wildcard" in step) {
          next.push(...identityAttributeNodes(ctx, node, step.namespace));
          continue;
        }
        const attr = identityAttributeNode(ctx, node, step.qname);
        if (attr !== undefined) {
          next.push(attr);
        }
        continue;
      }
      const stepQname = "wildcard" in step ? undefined : step.qname;
      const stepNs = "wildcard" in step ? step.namespace : undefined;
      next.push(...identityChildren(ctx, node, stepQname, stepNs));
    }
    current = next;
  }
  return current;
};

// Data-shape simple-value fallback for the standalone target. It has no
// lexicals or QName bindings; the runtime passes its full provenance-aware
// implementation through `IdentityContext.simpleValue`.
export const simpleIdentityValue = (node: IdentityNode, ctx: IdentityContext): unknown => {
  if (node.wrapped !== undefined && node.wrapped.kind === "attribute") {
    return IDENTITY_COMPLEX;
  }
  const { value } = node;
  if (value === null || value === undefined) {
    return IDENTITY_ABSENT;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return IDENTITY_ABSENT;
  }
  if (typeof value === "object") {
    const fields = node.schema === undefined ? undefined : ctx.getFieldsMeta(node.schema);
    if (fields !== undefined) {
      for (const [key, fieldMeta] of Object.entries(fields)) {
        if (fieldMeta.kind === "text") {
          const text = (value as Record<string, unknown>)[key];
          return text === undefined
            ? IDENTITY_ABSENT
            : simpleIdentityValue({ ...node, value: text, schema: undefined }, ctx);
        }
      }
    }
    return IDENTITY_COMPLEX;
  }
  return value;
};

// One field's value for a selected node: the union of all branch targets.
// Zero targets is ABSENT (key reports, unique/keyref skip); more than one is
// a violation per §3.11.4 (a key sequence needs exactly one value per field).
const identityFieldValue = (
  ctx: IdentityContext,
  branches: IdentityPath[],
  node: IdentityNode,
): unknown => {
  const targets: IdentityNode[] = [];
  const seen = new Set<string>();
  for (const branch of branches) {
    for (const target of identitySelect(ctx, branch, node)) {
      const key = `${identityPathString(target.path)}|${target.qname ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push(target);
      }
    }
  }
  if (targets.length === 0) {
    return IDENTITY_ABSENT;
  }
  const first = targets[0];
  if (targets.length > 1 || first === undefined) {
    return IDENTITY_MULTIPLE;
  }
  return ctx.simpleValue(first);
};

const identityPathString = (path: readonly (string | number)[]): string => JSON.stringify(path);

// Propagated entries merge upward (§3.11.5): a tuple key arriving with two
// distinct nodes is poisoned — no entry survives for it.
const mergeIdentityTable = (target: IdentityTable, src: IdentityTable): void => {
  for (const [name, srcPoisoned] of src.poisoned) {
    let poisoned = target.poisoned.get(name);
    if (poisoned === undefined) {
      poisoned = new Set();
      target.poisoned.set(name, poisoned);
    }
    const targetEntries = target.entries.get(name);
    for (const key of srcPoisoned) {
      targetEntries?.delete(key);
      poisoned.add(key);
    }
  }
  for (const [name, srcEntries] of src.entries) {
    let targetEntries = target.entries.get(name);
    if (targetEntries === undefined) {
      targetEntries = new Map();
      target.entries.set(name, targetEntries);
    }
    let poisoned = target.poisoned.get(name);
    if (poisoned === undefined) {
      poisoned = new Set();
      target.poisoned.set(name, poisoned);
    }
    for (const [key, pathString] of srcEntries) {
      if (poisoned.has(key)) {
        continue;
      }
      const existing = targetEntries.get(key);
      if (existing === undefined) {
        targetEntries.set(key, pathString);
      } else if (existing !== pathString) {
        targetEntries.delete(key);
        poisoned.add(key);
      }
    }
  }
};

// The selected node set of a constraint, deduped (union branches can overlap).
const identitySelectedNodes = (
  ctx: IdentityContext,
  constraint: IdentityConstraint,
  scopeNode: IdentityNode,
): IdentityNode[] => {
  const seen = new Set<string>();
  const out: IdentityNode[] = [];
  for (const branch of constraint.selector) {
    for (const node of identitySelect(ctx, branch, scopeNode)) {
      const key = identityPathString(node.path);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(node);
      }
    }
  }
  return out;
};

// A field that matched several nodes, or a complex-typed target, is a
// violation for every constraint kind (§3.11.4: a key sequence needs exactly
// one simple value per field). Returns the issue, or undefined when the
// tuple is usable (ABSENT entries are the caller's kind-specific concern).
const identityFieldIssue = (
  constraint: IdentityConstraint,
  tuple: unknown[],
  node: IdentityNode,
): z.core.$ZodIssue | undefined => {
  const local = splitClark(constraint.name).local;
  if (tuple.some((v) => v === IDENTITY_MULTIPLE)) {
    return {
      code: "custom",
      message: `xs:${constraint.kind} "${local}": a field xpath selects more than one node`,
      path: [...node.path],
      input: node.value,
    };
  }
  if (tuple.some((v) => v === IDENTITY_COMPLEX)) {
    return {
      code: "custom",
      message: `xs:${constraint.kind} "${local}": a field target is not simple-typed`,
      path: [...node.path],
      input: node.value,
    };
  }
  return undefined;
};

// Uniqueness and presence are enforced on the constraint's own qualified node
// set; the table returned for upward propagation additionally carries the
// children's entries (merged by the caller).
const evaluateUniqueOrKey = (
  ctx: IdentityContext,
  constraint: IdentityConstraint,
  scopeNode: IdentityNode,
  state: IdentityState,
): Map<string, string> => {
  const local = splitClark(constraint.name).local;
  const localEntries = new Map<string, string>();
  for (const node of identitySelectedNodes(ctx, constraint, scopeNode)) {
    const tuple = constraint.fields.map((f) => identityFieldValue(ctx, f, node));
    const fieldIssue = identityFieldIssue(constraint, tuple, node);
    if (fieldIssue !== undefined) {
      state.issues.push(fieldIssue);
      continue;
    }
    if (tuple.some((v) => v === IDENTITY_ABSENT)) {
      if (constraint.kind === "key") {
        state.issues.push({
          code: "custom",
          message: `xs:key "${local}": a selected element is missing a key field (or it is nil)`,
          path: [...node.path],
          input: node.value,
        });
      }
      continue;
    }
    const key = identityTupleKey(tuple);
    if (localEntries.has(key)) {
      state.issues.push({
        code: "custom",
        message: `xs:${constraint.kind} "${local}": duplicate key value (${identityTupleDisplay(tuple)})`,
        path: [...node.path],
        input: node.value,
      });
    } else {
      localEntries.set(key, identityPathString(node.path));
    }
  }
  return localEntries;
};

const evaluateKeyref = (
  ctx: IdentityContext,
  constraint: IdentityConstraint,
  table: Map<string, string> | undefined,
  scopeNode: IdentityNode,
  state: IdentityState,
): void => {
  const refer = constraint.refer;
  if (refer === undefined) {
    return;
  }
  const local = splitClark(constraint.name).local;
  const referLocal = splitClark(refer).local;
  for (const node of identitySelectedNodes(ctx, constraint, scopeNode)) {
    const tuple = constraint.fields.map((f) => identityFieldValue(ctx, f, node));
    const fieldIssue = identityFieldIssue(constraint, tuple, node);
    if (fieldIssue !== undefined) {
      state.issues.push(fieldIssue);
      continue;
    }
    if (tuple.some((v) => v === IDENTITY_ABSENT)) {
      continue;
    }
    if (table === undefined) {
      // No node table for the referenced key on this element (§3.11.4 cl. 4.3):
      // the constraint is unsatisfiable here.
      state.issues.push({
        code: "custom",
        message: `xs:keyref "${local}": referenced key "${referLocal}" is not in scope here`,
        path: [...node.path],
        input: node.value,
      });
      continue;
    }
    if (!table.has(identityTupleKey(tuple))) {
      state.issues.push({
        code: "custom",
        message: `xs:keyref "${local}": no entry in key "${referLocal}" matches (${identityTupleDisplay(tuple)})`,
        path: [...node.path],
        input: node.value,
      });
    }
  }
};

// Bottom-up: children first so their tables can merge into this occurrence's,
// then this occurrence's own constraints (key/unique before keyref, so a
// keyref sees tables declared on the same element). Returns the table the
// parent merges.
const walkIdentity = (
  ctx: IdentityContext,
  schema: AnySchema | undefined,
  value: unknown,
  path: readonly (string | number)[],
  constraints: readonly IdentityConstraint[],
  state: IdentityState,
  provenance: Partial<IdentityNode> = {},
): IdentityTable => {
  const own: IdentityTable = { entries: new Map(), poisoned: new Map() };
  const scopeNode: IdentityNode = {
    elementSchemas: state.elementSchemas,
    ...provenance,
    value,
    schema,
    path,
  };
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    schema !== undefined
  ) {
    const fields = ctx.getFieldsMeta(schema);
    if (fields !== undefined) {
      const shape = objectDefOf(schema)?.shape ?? {};
      const obj = value as Record<string, unknown>;
      for (const [key, fieldMeta] of Object.entries(fields)) {
        const fieldValue = obj[key];
        const fieldSchema = shape[key];
        if (fieldValue === undefined || fieldSchema === undefined) {
          continue;
        }
        if (fieldMeta.kind === "choice") {
          const choice = fieldMeta.choice;
          if (choice === undefined || !Array.isArray(fieldValue)) {
            continue;
          }
          fieldValue.forEach((item, i) => {
            if (item === null || typeof item !== "object" || Array.isArray(item)) {
              return;
            }
            const tagged = item as Record<string, unknown>;
            for (const branch of choice.branches) {
              const occurrence = identityChoiceBranch(ctx, fieldSchema, branch, tagged);
              if (occurrence === undefined) {
                continue;
              }
              // Ergonomic choices exclude branches that declare constraints
              // themselves, so only nested tables propagate from here.
              const childTable = walkIdentity(
                ctx,
                occurrence.schema,
                occurrence.value,
                [...path, key, i, branch.tag],
                [],
                state,
                ctx.getProvenance(obj, key, i),
              );
              mergeIdentityTable(own, childTable);
            }
          });
          continue;
        }
        if (fieldMeta.kind !== "element") {
          continue;
        }
        const isArray = analyzeField(fieldSchema).isArray;
        const occurrences = isArray ? (fieldValue as unknown[]) : [fieldValue];
        occurrences.forEach((occ, i) => {
          const childTable = walkIdentity(
            ctx,
            identityOccurrenceSchema(ctx, fieldSchema, obj, key, occ, i),
            occ,
            [...path, key, ...(isArray ? [i] : [])],
            fieldMeta.identity ?? [],
            state,
            { ...ctx.getProvenance(obj, key, i), wrapped: fieldMeta.wrapped },
          );
          mergeIdentityTable(own, childTable);
        });
      }
    }
  }
  for (const constraint of constraints) {
    if (constraint.kind === "keyref") {
      continue;
    }
    const localEntries = evaluateUniqueOrKey(ctx, constraint, scopeNode, state);
    let table = own.entries.get(constraint.name);
    if (table === undefined) {
      table = new Map();
      own.entries.set(constraint.name, table);
    }
    // Local entries win over propagated ones on conflict (§3.11.5).
    own.poisoned.get(constraint.name)?.forEach((key) => {
      if (localEntries.has(key)) {
        own.poisoned.get(constraint.name)?.delete(key);
      }
    });
    for (const [key, pathString] of localEntries) {
      table.set(key, pathString);
    }
  }
  for (const constraint of constraints) {
    if (constraint.kind === "keyref") {
      evaluateKeyref(ctx, constraint, own.entries.get(constraint.refer ?? "{}"), scopeNode, state);
    }
  }
  return own;
};

export const identityIssues = (
  ctx: IdentityContext,
  rootSchema: AnySchema,
  data: unknown,
): z.core.$ZodIssue[] => {
  const meta = ctx.getRootMeta(rootSchema);
  const declarations = meta?.identityElements?.();
  const elementSchemas =
    declarations === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(declarations).filter(
            (entry): entry is [string, AnySchema] =>
              entry[1] !== null && typeof entry[1] === "object" && "_zod" in entry[1],
          ),
        );
  const state: IdentityState = { issues: [], elementSchemas };
  // Resolve the root occurrence's content schema like the parse walk does
  // (lazy wrapper, then xsi:type union dispatch on the discriminant).
  let schema = peelOnce(rootSchema);
  const union = xsiTypeUnionDef(schema);
  if (union !== undefined && data !== null && typeof data === "object" && !Array.isArray(data)) {
    schema = identityXsiMember(ctx, union.options as readonly AnySchema[], data, schema);
  }
  const rootEntry = ctx.getRootLexical(rootSchema);
  walkIdentity(ctx, schema, data, [], meta?.identity ?? [], state, {
    lexical: rootEntry?.lexical,
    qnameNs: rootEntry?.qnameNs,
  });
  return state.issues;
};

// ---------------------------------------------------------------------------
