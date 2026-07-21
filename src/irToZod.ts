import { Xsd2ZodError } from './errors.js';
import { clarkToLocal, trySplitClark } from './qname.js';
import { XSD_INTEGER_TYPE_NAMES } from './xsdBuiltins.js';
import type {
  ComplexTypeDef,
  Facet,
  IrField,
  QName,
  SimpleTypeDef,
  XsdIr
} from './types.js';

const XSD_NS = 'http://www.w3.org/2001/XMLSchema';

const NUMBER_PRIMITIVES = new Set([...XSD_INTEGER_TYPE_NAMES, 'decimal', 'float', 'double']);

// Resolve a (possibly user-defined) simple type to its builtin base kind, so
// fixed/default values are coerced to the JS type the runtime produces (#87).
const resolvePrimitiveKind = (typeName: QName, ir: XsdIr, seen?: Set<string>): 'number' | 'boolean' | 'string' => {
  const parts = trySplitClark(typeName);
  if (!parts) {
    return 'string';
  }
  if (parts.ns === XSD_NS) {
    if (NUMBER_PRIMITIVES.has(parts.local)) {
      return 'number';
    }
    return parts.local === 'boolean' ? 'boolean' : 'string';
  }
  const seenNames = seen ?? new Set<string>();
  if (seenNames.has(typeName)) {
    return 'string';
  }
  seenNames.add(typeName);
  const simple = ir.simpleTypes[typeName];
  if (!simple) {
    return 'string';
  }
  const base =
    simple.kind === 'restriction' ? simple.baseType
    : simple.kind === 'list' ? simple.itemType
    : simple.memberTypes[0];
  return base ? resolvePrimitiveKind(base, ir, seenNames) : 'string';
};

const primitiveToZod = (typeName: QName, definedTypes: Set<string>): string => {
  const parts = trySplitClark(typeName);
  if (!parts) {
    return 'z.unknown()';
  }
  if (parts.ns !== XSD_NS) {
    // Unresolvable references (e.g. type="string" in a schema whose default
    // namespace is the targetNamespace) must not emit a dangling schemas lookup.
    return definedTypes.has(typeName) ? `schemas[${JSON.stringify(typeName)}]` : 'z.unknown()';
  }

  if (XSD_INTEGER_TYPE_NAMES.has(parts.local)) {
    return 'z.number().int()';
  }

  switch (parts.local) {
    case 'string':
    case 'token':
    case 'date':
    case 'dateTime':
      return 'z.string()';
    case 'boolean':
      return 'z.boolean()';
    case 'decimal':
    case 'float':
    case 'double':
      return 'z.number()';
    default:
      return 'z.string()';
  }
};

const isStringType = (zodExpr: string): boolean => zodExpr.startsWith('z.string()');
const isNumberType = (zodExpr: string): boolean => zodExpr.startsWith('z.number()');

// fixed/default values arrive as XSD lexicals; emit them coerced to the JS type
// the runtime produces for the field's (resolved) primitive kind (#68, #87).
const typedLiteral = (kind: 'number' | 'boolean' | 'string', raw: string): string => {
  if (kind === 'number') {
    return String(Number(raw));
  }
  if (kind === 'boolean') {
    return raw === 'true' || raw === '1' ? 'true' : 'false';
  }
  return JSON.stringify(raw);
};

const toFieldKey = (field: IrField): string => {
  if (field.kind === 'text') {
    return '_text';
  }
  const local = clarkToLocal(field.qname);
  return field.kind === 'attribute' ? `@${local}` : local;
};

// xs:annotation/xs:documentation surfaces as zod .describe() — IDE tooltips and
// downstream form generators pick it up from the schema (#25).
const withDescription = (expr: string, description: string | undefined): string =>
  description === undefined ? expr : `${expr}.describe(${JSON.stringify(description)})`;

type FacetUsage = { totalDigits: boolean; fractionDigits: boolean };

// Enum facet values arrive as XSD lexicals; emit them coerced to the JS type
// the runtime produces for the resolved primitive kind — same rule as
// fixed/default values (#68, #84).
const withFacets = (base: string, facets: Facet[], usage: FacetUsage, kind: 'number' | 'boolean' | 'string'): string => {
  if (!facets.length) return base;

  const enumFacets = facets.filter(f => f.kind === 'enumeration');
  const whiteSpace = facets.find(f => f.kind === 'whiteSpace');
  const otherFacets = facets.filter(f => f.kind !== 'enumeration' && f.kind !== 'whiteSpace');
  const enumLiterals = enumFacets.map(f => typedLiteral(kind, f.value));

  let result = base;
  if (enumFacets.length > 0 && otherFacets.length === 0) {
    if (isStringType(base)) {
      result = `z.enum([${enumLiterals.join(', ')}])`;
    } else if (isNumberType(base) || base === 'z.boolean()') {
      result = `z.union([${enumLiterals.map(lit => `z.literal(${lit})`).join(', ')}])`;
    } else {
      // Base is a reference to another type's schema — keep it and constrain.
      result += `.refine((val) => [${enumLiterals.join(', ')}].includes(val), { message: 'value is not one of the allowed values' })`;
    }
  } else {
    for (const facet of otherFacets) {
      switch (facet.kind) {
        case 'pattern':
          result += `.regex(new RegExp(${JSON.stringify(facet.value)}))`;
          break;
        case 'length':
          result += `.length(${facet.value})`;
          break;
        case 'minLength':
          result += `.min(${facet.value})`;
          break;
        case 'maxLength':
          result += `.max(${facet.value})`;
          break;
        case 'minInclusive':
          result += `.min(${facet.value})`;
          break;
        case 'maxInclusive':
          result += `.max(${facet.value})`;
          break;
        case 'minExclusive':
          result += `.gt(${facet.value})`;
          break;
        case 'maxExclusive':
          result += `.lt(${facet.value})`;
          break;
        case 'totalDigits':
          usage.totalDigits = true;
          result += `.refine(xsdTotalDigits(${facet.value}), { message: ${JSON.stringify(`expected at most ${facet.value} total digits`)} })`;
          break;
        case 'fractionDigits':
          usage.fractionDigits = true;
          result += `.refine(xsdFractionDigits(${facet.value}), { message: ${JSON.stringify(`expected at most ${facet.value} fraction digits`)} })`;
          break;
      }
    }

    if (enumFacets.length > 0) {
      result += `.refine((val) => [${enumLiterals.join(', ')}].includes(val), { message: 'value is not one of the allowed values' })`;
    }
  }

  // whiteSpace applies before the other facets per XSD, so it wraps the
  // checked schema in a preprocess (#69). 'preserve' is deliberately a no-op.
  if (whiteSpace?.value === 'collapse') {
    result = `z.preprocess((v) => typeof v === "string" ? v.replace(/\\s+/g, " ").trim() : v, ${result})`;
  } else if (whiteSpace?.value === 'replace') {
    result = `z.preprocess((v) => typeof v === "string" ? v.replace(/[\\t\\n\\r]/g, " ") : v, ${result})`;
  }

  return result;
};

// Emit simple types in dependency order — a restriction/list/union can
// reference a user-defined type declared later in the XSD, and the generated
// module evaluates these assignments eagerly (#72).
const sortSimpleTypes = (ir: XsdIr): SimpleTypeDef[] => {
  const types = Object.values(ir.simpleTypes);
  const byName = new Map(types.map((t) => [t.name, t]));
  const dependencies = (t: SimpleTypeDef): SimpleTypeDef[] => {
    const deps = t.kind === 'restriction' ? [t.baseType] : t.kind === 'list' ? [t.itemType] : t.memberTypes;
    return deps
      .map((dep) => byName.get(dep))
      .filter((dep): dep is SimpleTypeDef => dep !== undefined);
  };

  const sorted: SimpleTypeDef[] = [];
  const visited = new Set<string>();
  const visit = (t: SimpleTypeDef): void => {
    if (visited.has(t.name)) {
      return;
    }
    visited.add(t.name);
    for (const dep of dependencies(t)) {
      visit(dep);
    }
    sorted.push(t);
  };
  for (const t of types) {
    visit(t);
  }
  return sorted;
};

const withCardinality = (schema: string, field: IrField, ir: XsdIr, forceOptional: boolean): string => {
  const kind = resolvePrimitiveKind(field.typeName, ir);
  let result = field.fixedValue !== undefined ? `z.literal(${typedLiteral(kind, field.fixedValue)})` : schema;
  if (field.nillable) {
    result += '.nullable()';
  }
  if (field.maxOccurs === 'unbounded' || field.maxOccurs > 1) {
    result = `z.array(${result})`;
    // Skip .min() for choice fields (forceOptional): absent choice branches
    // materialise as [] and must not fail cardinality validation (#73).
    if (field.minOccurs > 0 && !forceOptional) {
      result += `.min(${field.minOccurs})`;
    }
    if (field.maxOccurs !== 'unbounded') {
      result += `.max(${field.maxOccurs})`;
    }
  }
  if (field.minOccurs === 0 || forceOptional) {
    result += '.optional()';
  }
  // Attribute defaults apply on absence — zod .default() (after .optional(),
  // which would otherwise make it dead). Element defaults are NOT emitted as
  // .default(): XSD applies them to present-but-empty elements, not absent
  // ones, so the runtime substitutes them via meta.defaultValue (#66).
  if (field.kind === 'attribute' && field.defaultValue !== undefined && field.fixedValue === undefined) {
    result += `.default(${typedLiteral(kind, field.defaultValue)})`;
  }
  return result;
};

// Choice groups with more than one branch: mutual exclusion is not expressible
// as a plain zod type (and discriminated unions only scale to one group per
// type), so branch fields become optional plus a refine per group (#73).
// Branches come from the IR's choiceBranch: a group ref or nested compositor
// keeps its fields together as one branch (ipo-style shipTo+billTo vs
// singleAddress). Single-branch groups need no check — exactly-one-of-one is
// the field cardinality itself.
const choiceBranches = (type: ComplexTypeDef, group: string): IrField[][] => {
  const byBranch = new Map<string, IrField[]>();
  for (const field of type.fields) {
    if (field.choiceGroup !== group || field.kind !== 'element') {
      continue;
    }
    const key = field.choiceBranch ?? toFieldKey(field);
    const branch = byBranch.get(key) ?? [];
    branch.push(field);
    byBranch.set(key, branch);
  }
  return [...byBranch.values()];
};

const multiBranchGroups = (type: ComplexTypeDef): Set<string> => {
  const groups = new Set<string>();
  for (const field of type.fields) {
    if (field.choiceGroup && field.kind === 'element' && choiceBranches(type, field.choiceGroup).length > 1) {
      groups.add(field.choiceGroup);
    }
  }
  return groups;
};

const choiceRefines = (type: ComplexTypeDef): string[] => {
  const keyOf = (field: IrField): string => `val[${JSON.stringify(toFieldKey(field))}]`;

  const refines: string[] = [];
  for (const group of multiBranchGroups(type)) {
    const branches = choiceBranches(type, group);
    const requiredChoice = branches.flat().some((f) => f.minOccurs > 0);

    const lines: string[] = [];
    const completeNames: string[] = [];
    const partialNames: string[] = [];
    // Presence, not just definedness: the runtime materializes an absent
    // repeated field as [] (readField), and [] !== undefined would count the
    // branch as selected — an empty array is zero occurrences, i.e. absent.
    lines.push(`const has = (v: unknown): boolean => v !== undefined && !(Array.isArray(v) && v.length === 0);`);
    branches.forEach((branch, i) => {
      const requiredKeys = branch.filter((f) => f.minOccurs > 0).map(keyOf);
      const allKeys = branch.map(keyOf);
      // A branch is complete when all its required fields are present (or, for
      // branches of only-optional fields, when any field is present). Partial
      // presence — some but not all required fields — is always rejected.
      if (requiredKeys.length === 1 && branch.length === 1) {
        lines.push(`const b${i} = has(${allKeys[0]});`);
      } else if (requiredKeys.length > 0) {
        lines.push(`const b${i} = [${requiredKeys.join(', ')}].every(has);`);
      } else {
        lines.push(`const b${i} = [${allKeys.join(', ')}].some(has);`);
      }
      completeNames.push(`b${i}`);
      if (requiredKeys.length > 0 && branch.length > 1) {
        lines.push(`const p${i} = !b${i} && [${allKeys.join(', ')}].some(has);`);
        partialNames.push(`p${i}`);
      }
    });

    const countCheck = requiredChoice ? '=== 1' : '<= 1';
    const partialCheck = partialNames.length > 0 ? ` && ![${partialNames.join(', ')}].some(Boolean)` : '';
    lines.push(`return [${completeNames.join(', ')}].filter(Boolean).length ${countCheck}${partialCheck};`);

    const names = branches.map((b) => b.map((f) => clarkToLocal(f.qname)).join('+')).join(', ');
    const message = `${requiredChoice ? 'choice requires exactly one of' : 'choice allows at most one of'}: ${names}`;
    refines.push(`.refine((val) => {\n${lines.join('\n')}\n}, { message: ${JSON.stringify(message)} })`);
  }
  return refines;
};

// Per-field XML knowledge lives on the containing object schema: a named type
// can be referenced by several elements with different qnames, so field-level
// meta on shared schemas would conflict.
const fieldsMetaFor = (type: ComplexTypeDef, ir: XsdIr): string => {
  const entries = type.fields.map((field) => {
    const parts = [`kind: ${JSON.stringify(field.kind)}`, `qname: ${JSON.stringify(field.qname)}`];
    if (field.kind === 'element' && field.defaultValue !== undefined && field.fixedValue === undefined) {
      parts.push(`defaultValue: ${typedLiteral(resolvePrimitiveKind(field.typeName, ir), field.defaultValue)}`);
    }
    return `${JSON.stringify(toFieldKey(field))}: { ${parts.join(', ')} }`;
  });
  return `qname: ${JSON.stringify(type.name)}, fields: { ${entries.join(', ')} }`;
};

// ---------------------------------------------------------------------------
// Small emitter layer — systematic codegen helpers instead of raw string
// concatenation.  Centralises schema-reference formatting, .register() calls,
// with-description wrapping, and reserved-keyword / forward-ref wiring so that
// the structural logic in irToZod stays readable (#84).
// ---------------------------------------------------------------------------

/** `schemas["{ns}local"]` — a reference to a named schema in the module. */
const schemaRef = (name: QName): string => `schemas[${JSON.stringify(name)}]`;

/**
 * Wrap an expression with `.describe()` (when a description is present) and
 * `.register(xmlRegistry, { … })` — the standard suffix for every schema
 * definition.
 */
/**
 * Build a `.register(xmlRegistry, { … })` suffix with optional `.describe()`.
 * `metaBody` is the pre-formatted interior of the meta object literal (e.g.
 * `qname: "...", fields: { ... }`).
 */
const registered = (expr: string, description: string | undefined, metaBody: string): string =>
  `${withDescription(expr, description)}.register(xmlRegistry, { ${metaBody} })`;

export type IrToZodOptions = {
  // Emit plain JavaScript (no TS type annotations) so the output can be
  // imported directly as .mjs — used by the CLI validate subcommand.
  js?: boolean;
};

export const irToZod = (ir: XsdIr, opts?: IrToZodOptions): { schemas: string } => {
  const schemaLines: string[] = [];
  const definedTypes = new Set<string>([...Object.keys(ir.simpleTypes), ...Object.keys(ir.complexTypes)]);
  const usage: FacetUsage = { totalDigits: false, fractionDigits: false };

  schemaLines.push('// AUTO-GENERATED — DO NOT EDIT');
  const importLineIndex = schemaLines.length;
  schemaLines.push(''); // import line, filled in at the end once facet usage is known
  schemaLines.push(opts?.js ? 'const schemas = {};' : 'const schemas: Record<string, z.ZodTypeAny> = {};');

  // Simple and complex types share the `schemas[...]` namespace in the
  // generated module — a qname collision would silently overwrite. Fail loud.
  const claimedTypeNames = new Set<string>();
  const claimTypeName = (qname: string): void => {
    if (claimedTypeNames.has(qname)) {
      throw new Xsd2ZodError('type-name-collision', `type name collision: ${qname} is declared as both a simpleType and a complexType`);
    }
    claimedTypeNames.add(qname);
  };

  for (const simpleType of sortSimpleTypes(ir)) {
    claimTypeName(simpleType.name);
    let expr: string;
    if (simpleType.kind === 'list') {
      const itemExpr = primitiveToZod(simpleType.itemType, definedTypes);
      expr = `z.preprocess((v) => typeof v === "string" ? v.trim().split(/\\s+/) : v, z.array(${itemExpr}))`;
    } else if (simpleType.kind === 'union') {
      const memberExprs = simpleType.memberTypes.map(mt => primitiveToZod(mt, definedTypes));
      expr = `z.union([${memberExprs.join(', ')}])`;
    } else {
      const baseExpr = primitiveToZod(simpleType.baseType, definedTypes);
      expr = simpleType.facets
        ? withFacets(baseExpr, simpleType.facets, usage, resolvePrimitiveKind(simpleType.name, ir))
        : baseExpr;
    }
    schemaLines.push(`${schemaRef(simpleType.name)} = ${registered(expr, simpleType.description, `qname: ${JSON.stringify(simpleType.name)}`)};`);
  }

  for (const complexType of Object.values(ir.complexTypes)) {
    claimTypeName(complexType.name);
    const multiBranch = multiBranchGroups(complexType);
    const props = complexType.fields
      .map((field) => `${JSON.stringify(toFieldKey(field))}: ${withDescription(withCardinality(
        primitiveToZod(field.typeName, definedTypes),
        field,
        ir,
        field.choiceGroup !== undefined && multiBranch.has(field.choiceGroup)
      ), field.description)}`)
      .join(', ');

    schemaLines.push(
      `${schemaRef(complexType.name)} = ${registered(
        `z.lazy(() => z.object({${props}})${choiceRefines(complexType).join('')})`,
        complexType.description,
        fieldsMetaFor(complexType, ir),
      )};`
    );
  }

  const exportNames = rootSchemaExportNames(ir.rootElements);
  for (const root of ir.rootElements) {
    const rootDef = ir.elements[root];
    // Root exports are fresh wrapper objects: registry meta is keyed by schema
    // object identity, so registering { root } on the shared type schema would
    // clobber its type meta (and collide when two roots share one type).
    const base = `z.lazy(() => ${primitiveToZod(rootDef.typeName, definedTypes)})`;
    const expr = rootDef.nillable ? `${base}.nullable()` : base;
    schemaLines.push(`export const ${exportNames.get(root)} = ${registered(expr, rootDef.description, `root: ${JSON.stringify(root)}`)};`);
  }

  const xsdImports = [
    usage.totalDigits ? 'xsdTotalDigits' : undefined,
    usage.fractionDigits ? 'xsdFractionDigits' : undefined
  ].filter((name): name is string => name !== undefined);
  schemaLines[importLineIndex] =
    `import { z } from 'zod';\n` +
    `import { xmlRegistry${xsdImports.length > 0 ? `, ${xsdImports.join(', ')}` : ''} } from 'xsd-to-zod';`;

  return { schemas: `${schemaLines.join('\n')}\n` };
};

export const fieldKeyFromIr = toFieldKey;

// JS reserved words — an export/identifier matching one of these must be
// prefixed so the generated module is valid JavaScript (#70, #84).
const JS_RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'let', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'async', 'await', 'of', 'from', 'as', 'get', 'set', 'static',
  'implements', 'interface', 'package', 'private', 'protected', 'public',
]);

// Generated export identifiers must be valid JS identifiers and unique across
// all roots — legal XSD names (unicode letters, or the same local name in two
// namespaces) otherwise produce invalid TypeScript (#70).
export const sanitizeIdentifier = (name: string): string => {
  const cleaned = name.replace(/[^\p{L}\p{N}_$]/gu, '_');
  const valid = /^[\p{L}_$]/u.test(cleaned) ? cleaned : `_${cleaned}`;
  return JS_RESERVED.has(valid) ? `_${valid}` : valid;
};

export const rootSchemaExportNames = (rootElements: QName[]): Map<string, string> => {
  const seen = new Map<string, number>();
  const names = new Map<string, string>();
  for (const root of rootElements) {
    const base = `${sanitizeIdentifier(clarkToLocal(root))}Schema`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    names.set(root, count === 0 ? base : `${base}${count + 1}`);
  }
  return names;
};
