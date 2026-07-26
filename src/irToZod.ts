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

// Builtins whose lexical space the zod tier can check (xsdLexicals.ts has the
// validators): builtin local name → exported validator function. QName,
// NOTATION, anyURI, normalizedString and token are absent on purpose — see
// xsdLexicals.ts for why their lexical check is impossible or vacuous.
const XSD_LEXICAL_VALIDATORS: ReadonlyMap<string, string> = new Map([
  ['date', 'xsdDate'],
  ['dateTime', 'xsdDateTime'],
  ['time', 'xsdTime'],
  ['gYear', 'xsdGYear'],
  ['gYearMonth', 'xsdGYearMonth'],
  ['gMonth', 'xsdGMonth'],
  ['gMonthDay', 'xsdGMonthDay'],
  ['gDay', 'xsdGDay'],
  ['duration', 'xsdDuration'],
  ['hexBinary', 'xsdHexBinary'],
  ['base64Binary', 'xsdBase64Binary'],
  ['language', 'xsdLanguage'],
  ['Name', 'xsdName'],
  ['NCName', 'xsdNCName'],
  ['ID', 'xsdNCName'],
  ['IDREF', 'xsdNCName'],
  ['ENTITY', 'xsdNCName'],
  ['NMTOKEN', 'xsdNMTOKEN'],
  ['NMTOKENS', 'xsdNMTOKENS'],
  ['IDREFS', 'xsdNCNames'],
  ['ENTITIES', 'xsdNCNames'],
]);

// Value-space bounds for the bounded integer builtins. long/unsignedLong are
// absent: their bounds exceed Number.MAX_SAFE_INTEGER, so a min/max on the
// coerced JS number would be unsound — they stay z.number().int().
const XSD_INTEGER_BOUNDS: ReadonlyMap<string, { min?: number; max?: number }> = new Map([
  ['byte', { min: -128, max: 127 }],
  ['short', { min: -32768, max: 32767 }],
  ['int', { min: -2147483648, max: 2147483647 }],
  ['unsignedByte', { min: 0, max: 255 }],
  ['unsignedShort', { min: 0, max: 65535 }],
  ['unsignedInt', { min: 0, max: 4294967295 }],
  ['nonNegativeInteger', { min: 0 }],
  ['nonPositiveInteger', { max: 0 }],
  ['negativeInteger', { max: -1 }],
  ['positiveInteger', { min: 1 }],
]);

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

// The XSD builtin local name a (possibly user-defined) simple type derives
// from, e.g. 'NOTATION' or 'date'; undefined for lists/unions/unresolvable.
const resolveBuiltinLocal = (typeName: QName, ir: XsdIr, seen?: Set<string>): string | undefined => {
  const parts = trySplitClark(typeName);
  if (!parts) {
    return undefined;
  }
  if (parts.ns === XSD_NS) {
    return parts.local;
  }
  const seenNames = seen ?? new Set<string>();
  if (seenNames.has(typeName)) {
    return undefined;
  }
  seenNames.add(typeName);
  const simple = ir.simpleTypes[typeName];
  if (!simple || simple.kind !== 'restriction') {
    return undefined;
  }
  return resolveBuiltinLocal(simple.baseType, ir, seenNames);
};

const primitiveToZod = (typeName: QName, definedTypes: Set<string>, constName: ReadonlyMap<QName, string>, usedHelpers: Set<string>): string => {
  const parts = trySplitClark(typeName);
  if (!parts) {
    return 'z.unknown()';
  }
  if (parts.ns !== XSD_NS) {
    // Unresolvable references (e.g. type="string" in a schema whose default
    // namespace is the targetNamespace) must not emit a dangling reference.
    const ref = constName.get(typeName);
    return definedTypes.has(typeName) && ref !== undefined ? ref : 'z.unknown()';
  }

  if (XSD_INTEGER_TYPE_NAMES.has(parts.local)) {
    const bounds = XSD_INTEGER_BOUNDS.get(parts.local);
    let expr = 'z.number().int()';
    if (bounds?.min !== undefined) {
      expr += `.min(${bounds.min})`;
    }
    if (bounds?.max !== undefined) {
      expr += `.max(${bounds.max})`;
    }
    return expr;
  }

  const validator = XSD_LEXICAL_VALIDATORS.get(parts.local);
  if (validator) {
    usedHelpers.add(validator);
    return `z.string().refine(${validator}, { message: 'invalid xs:${parts.local} lexical' })`;
  }

  switch (parts.local) {
    case 'anyType':
      // Open content: the runtime walks/serializes it generically (open shape);
      // zod stays permissive for this lax tier.
      return 'z.unknown()';
    case 'string':
    case 'token':
      return 'z.string()';
    case 'boolean':
      return 'z.boolean()';
    case 'decimal':
      return 'z.number()';
    case 'float':
    case 'double':
      // xs:float/xs:double include INF/-INF/NaN in their value space; zod's
      // z.number() rejects non-finite numbers at the base-type level (#116).
      return 'z.union([z.number(), z.literal(Infinity), z.literal(-Infinity), z.nan()])';
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
const withFacets = (base: string, facets: Facet[], usage: FacetUsage, kind: 'number' | 'boolean' | 'string', builtinLocal?: string): string => {
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
          // .regex() exists only on string schemas; elsewhere the pattern is
          // checked against the coerced value's string form (#114).
          if (isStringType(result)) {
            result += `.regex(new RegExp(${JSON.stringify(facet.value)}))`;
          } else {
            result += `.refine((val) => new RegExp(${JSON.stringify(facet.value)}).test(String(val)), { message: 'value does not match the pattern' })`;
          }
          break;
        case 'length':
        case 'minLength':
        case 'maxLength': {
          const op = facet.kind === 'length' ? '===' : facet.kind === 'minLength' ? '>=' : '<=';
          // XSD 1.0 vacuous rule: every QName/NOTATION value satisfies any
          // length facet — skip them (with a diagnostic) rather than reject
          // valid values (#124 review).
          if (builtinLocal === 'NOTATION' || builtinLocal === 'QName') {
            result += ` /* facet ${facet.kind} skipped: vacuous for xs:${builtinLocal} in XSD 1.0 */`;
          } else if (builtinLocal === 'hexBinary') {
            // Length unit is octets: two hex digits per octet.
            result += `.refine((val) => typeof val === 'string' && val.length % 2 === 0 && val.length / 2 ${op} ${facet.value}, { message: 'octet length constraint violated' })`;
          } else if (builtinLocal === 'base64Binary') {
            // Length unit is octets: four base64 chars per three octets, less padding.
            result += `.refine((val) => typeof val === 'string' && ((s) => Math.floor(s.length / 4) * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0))(val.replace(/\\s+/g, '')) ${op} ${facet.value}, { message: 'octet length constraint violated' })`;
          } else if (builtinLocal === 'IDREFS' || builtinLocal === 'NMTOKENS' || builtinLocal === 'ENTITIES') {
            // Length unit is list items (whitespace-separated tokens).
            result += `.refine((val) => typeof val === 'string' && (val.trim() === '' ? 0 : val.trim().split(/\\s+/).length) ${op} ${facet.value}, { message: 'item count constraint violated' })`;
          } else if (isStringType(result)) {
            result += facet.kind === 'length' ? `.length(${facet.value})` : facet.kind === 'minLength' ? `.min(${facet.value})` : `.max(${facet.value})`;
          } else {
            // Non-string base (type reference, enum, list): the convenience
            // methods don't exist there — refine on the .length of strings
            // (characters) and arrays (list items) instead (#114).
            result += `.refine((val) => (typeof val === 'string' || Array.isArray(val)) && val.length ${op} ${facet.value}, { message: 'length constraint violated' })`;
          }
          break;
        }
        case 'minInclusive':
        case 'maxInclusive':
        case 'minExclusive':
        case 'maxExclusive': {
          if (isNumberType(result)) {
            result += facet.kind === 'minInclusive' ? `.min(${facet.value})` : facet.kind === 'maxInclusive' ? `.max(${facet.value})` : facet.kind === 'minExclusive' ? `.gt(${facet.value})` : `.lt(${facet.value})`;
          } else if (kind === 'number') {
            // Numeric user-type reference: compare via refine, which any
            // schema supports (#114).
            const op = facet.kind === 'minInclusive' ? '>=' : facet.kind === 'maxInclusive' ? '<=' : facet.kind === 'minExclusive' ? '>' : '<';
            result += `.refine((val) => val ${op} ${facet.value}, { message: 'value out of range' })`;
          } else {
            // Order facets on non-numeric kinds (dates, durations) are
            // skipped: the coerced/string value cannot be compared soundly —
            // the libxml2 tier stays the conformance authority (#114).
            result += ` /* facet ${facet.kind} skipped: order facets unsupported on non-numeric types */`;
          }
          break;
        }
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
    const flatFields = branches.flat();
    // A choice group is only required when it is not emptiable: a single
    // branch with minOccurs="0" makes the whole group match empty (verified
    // against libxml2). Field minOccurs already folds in the choice particle's
    // own minOccurs (combineCardinality multiplies).
    const requiredChoice = flatFields.every((f) => f.minOccurs > 0);
    const groupCard = type.choiceGroups?.[group];
    const repeatedChoice = groupCard !== undefined && (groupCard.maxOccurs === 'unbounded' || groupCard.maxOccurs > 1);

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

    if (repeatedChoice && !requiredChoice) {
      continue;
    }

    const countCheck = repeatedChoice
      ? '> 0'
      : requiredChoice
        ? '=== 1'
        : '<= 1';
    const partialCheck = partialNames.length > 0 ? ` && ![${partialNames.join(', ')}].some(Boolean)` : '';
    lines.push(`return [${completeNames.join(', ')}].filter(Boolean).length ${countCheck}${partialCheck};`);

    const names = branches.map((b) => b.map((f) => clarkToLocal(f.qname)).join('+')).join(', ');
    const message = repeatedChoice
      ? `choice requires at least one of: ${names}`
      : `${requiredChoice ? 'choice requires exactly one of' : 'choice allows at most one of'}: ${names}`;
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
    if (field.typeName === '{http://www.w3.org/2001/XMLSchema}anyType') {
      parts.push('open: true');
    }
    if (field.kind === 'element' && field.defaultValue !== undefined && field.fixedValue === undefined) {
      parts.push(`defaultValue: ${typedLiteral(resolvePrimitiveKind(field.typeName, ir), field.defaultValue)}`);
    }
    return `${JSON.stringify(toFieldKey(field))}: { ${parts.join(', ')} }`;
  });
  // Wildcard sentinels: '*' sweeps unmatched child elements, '@*' unmatched
  // attributes into the open shape.
  for (const wildcard of type.wildcards ?? []) {
    if (wildcard.kind === 'any') {
      entries.push(`"*": { kind: "any", qname: "{}*" }`);
    } else {
      entries.push(`"@*": { kind: "anyAttribute", qname: "{}*" }`);
    }
  }
  return `qname: ${JSON.stringify(type.name)}, fields: { ${entries.join(', ')} }`;
};

// ---------------------------------------------------------------------------
// Small emitter layer — systematic codegen helpers instead of raw string
// concatenation.  Centralises schema-reference formatting, .register() calls,
// with-description wrapping, and reserved-keyword / forward-ref wiring so that
// the structural logic in irToZod stays readable (#84).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Static types (#146). Every named type becomes a standalone const so its
// inferred zod type survives; the old `schemas: Record<string, z.ZodTypeAny>`
// registry erased all of it (z.infer → any). Complex types additionally get
// an exported TS interface, and their schema const is annotated
// z.ZodType<Interface> — the annotation breaks the circular type inference
// that mutually recursive types would otherwise trigger.
// ---------------------------------------------------------------------------

// Parenthesize union type expressions when nested in an array.
const tsArrayOf = (type: string): string => `${type.includes(' | ') ? `(${type})` : type}[]`;

// TS output type for a type reference, mirroring the runtime output of the
// generated zod expression. Interfaces exist only for complex types; simple
// types are inlined structurally.
const tsTypeOfTypeName = (
  typeName: QName,
  ir: XsdIr,
  ifaceName: ReadonlyMap<QName, string>,
  seen: Set<QName>
): string => {
  const parts = trySplitClark(typeName);
  if (!parts) {
    return 'unknown';
  }
  if (parts.ns === XSD_NS) {
    if (XSD_INTEGER_TYPE_NAMES.has(parts.local)) {
      return 'number';
    }
    switch (parts.local) {
      case 'anyType':
        return 'unknown';
      case 'boolean':
        return 'boolean';
      case 'decimal':
      case 'float':
      case 'double':
        return 'number';
      default:
        return 'string';
    }
  }
  if (ir.complexTypes[typeName] !== undefined) {
    return ifaceName.get(typeName) ?? 'unknown';
  }
  const simple = ir.simpleTypes[typeName];
  if (simple === undefined || seen.has(typeName)) {
    return 'unknown';
  }
  seen.add(typeName);
  if (simple.kind === 'list') {
    return tsArrayOf(tsTypeOfTypeName(simple.itemType, ir, ifaceName, seen));
  }
  if (simple.kind === 'union') {
    const members = simple.memberTypes.map(mt => tsTypeOfTypeName(mt, ir, ifaceName, seen));
    return members.length > 0 ? members.join(' | ') : 'unknown';
  }
  // Restriction: a pure enumeration on a direct builtin base becomes a
  // literal union (mirrors withFacets); anything else has the base's type.
  const facets = simple.facets ?? [];
  const enumFacets = facets.filter(f => f.kind === 'enumeration');
  const otherFacets = facets.filter(f => f.kind !== 'enumeration' && f.kind !== 'whiteSpace');
  const baseParts = trySplitClark(simple.baseType);
  if (enumFacets.length > 0 && otherFacets.length === 0 && baseParts?.ns === XSD_NS && baseParts.local !== 'anyType') {
    const kind = resolvePrimitiveKind(simple.baseType, ir);
    return enumFacets.map(f => typedLiteral(kind, f.value)).join(' | ');
  }
  return tsTypeOfTypeName(simple.baseType, ir, ifaceName, seen);
};

// One interface property line for a field, mirroring withCardinality:
// optionality from minOccurs/choice, [] from maxOccurs, null from nillable,
// literal types for fixed values. Attribute defaults make the zod output
// non-optional (.default() fills absence).
const tsFieldLine = (
  field: IrField,
  ir: XsdIr,
  ifaceName: ReadonlyMap<QName, string>,
  forceOptional: boolean
): string => {
  let type = field.fixedValue !== undefined
    ? typedLiteral(resolvePrimitiveKind(field.typeName, ir), field.fixedValue)
    : tsTypeOfTypeName(field.typeName, ir, ifaceName, new Set());
  if (field.nillable) {
    type += ' | null';
  }
  if (field.maxOccurs === 'unbounded' || field.maxOccurs > 1) {
    type = tsArrayOf(type);
  }
  const hasAttributeDefault =
    field.kind === 'attribute' && field.defaultValue !== undefined && field.fixedValue === undefined;
  const optional = (field.minOccurs === 0 || forceOptional) && !hasAttributeDefault;
  return `  ${JSON.stringify(toFieldKey(field))}${optional ? '?' : ''}: ${type};`;
};

/**
 * Build a `.register(xmlRegistry, { … })` suffix with optional `.describe()`.
 * `metaBody` is the pre-formatted interior of the meta object literal (e.g.
 * `qname: "...", fields: { ... }`).
 */
const registered = (expr: string, description: string | undefined, metaBody: string): string =>
  `${withDescription(expr, description)}.register(xmlRegistry, { ${metaBody} })`;

// Names TS forbids as interface identifiers (primitive/literal type keywords).
// An XSD type named "boolean" or "any" gets a Type suffix instead.
const TS_TYPE_RESERVED = new Set([
  'any', 'unknown', 'never', 'void', 'undefined', 'null', 'string', 'number',
  'boolean', 'object', 'symbol', 'bigint', 'true', 'false', 'this', 'infer',
  'function', 'intrinsic',
]);

export type IrToZodOptions = {
  // Emit plain JavaScript (no TS type annotations) so the output can be
  // imported directly as .mjs — used by the CLI validate subcommand.
  js?: boolean;
};

export const irToZod = (ir: XsdIr, opts?: IrToZodOptions): { schemas: string } => {
  const schemaLines: string[] = [];
  const definedTypes = new Set<string>([...Object.keys(ir.simpleTypes), ...Object.keys(ir.complexTypes)]);
  const usage: FacetUsage = { totalDigits: false, fractionDigits: false };
  const usedHelpers = new Set<string>();

  // Unique identifiers for the generated module, shared across value and type
  // space so an interface can never shadow a root export (public API of
  // generated modules — those names keep their historic shape).
  const exportNames = rootSchemaExportNames(ir.rootElements);
  const usedNames = new Set<string>(exportNames.values());
  const alloc = (base: string): string => {
    let name = base;
    let n = 2;
    while (usedNames.has(name)) {
      name = `${base}${n}`;
      n += 1;
    }
    usedNames.add(name);
    return name;
  };
  const constName = new Map<QName, string>();
  const ifaceName = new Map<QName, string>();
  const sortedSimpleTypes = sortSimpleTypes(ir);
  for (const t of sortedSimpleTypes) {
    constName.set(t.name, alloc(`${sanitizeIdentifier(clarkToLocal(t.name))}Schema`));
  }
  for (const t of Object.values(ir.complexTypes)) {
    const local = sanitizeIdentifier(clarkToLocal(t.name));
    constName.set(t.name, alloc(`${local}Schema`));
    ifaceName.set(t.name, alloc(TS_TYPE_RESERVED.has(local) ? `${local}Type` : local));
  }

  schemaLines.push('// AUTO-GENERATED — DO NOT EDIT');
  const importLineIndex = schemaLines.length;
  schemaLines.push(''); // import line, filled in at the end once facet usage is known

  // Simple and complex types share the generated module's value namespace —
  // a qname collision would silently reference the wrong const. Fail loud.
  const claimedTypeNames = new Set<string>();
  const claimTypeName = (qname: string): void => {
    if (claimedTypeNames.has(qname)) {
      throw new Xsd2ZodError('type-name-collision', `type name collision: ${qname} is declared as both a simpleType and a complexType`);
    }
    claimedTypeNames.add(qname);
  };

  // Interfaces first: exported so consumers can name the inferred types, and
  // the const annotations below refer to them. js mode has no type level.
  if (!opts?.js) {
    for (const complexType of Object.values(ir.complexTypes)) {
      claimTypeName(complexType.name);
      const multiBranch = multiBranchGroups(complexType);
      const props = complexType.fields
        .map((field) => tsFieldLine(field, ir, ifaceName, field.choiceGroup !== undefined && multiBranch.has(field.choiceGroup)))
        .join('\n');
      const indexSignature = complexType.wildcards && complexType.wildcards.length > 0 ? '\n  [key: string]: unknown;' : '';
      schemaLines.push(`export interface ${ifaceName.get(complexType.name)} {\n${props}${indexSignature}\n}`);
    }
  }

  for (const simpleType of sortedSimpleTypes) {
    claimTypeName(simpleType.name);
    let expr: string;
    if (simpleType.kind === 'list') {
      const itemExpr = primitiveToZod(simpleType.itemType, definedTypes, constName, usedHelpers);
      expr = `z.preprocess((v) => typeof v === "string" ? v.trim().split(/\\s+/) : v, z.array(${itemExpr}))`;
    } else if (simpleType.kind === 'union') {
      const memberExprs = simpleType.memberTypes.map(mt => primitiveToZod(mt, definedTypes, constName, usedHelpers));
      expr = `z.union([${memberExprs.join(', ')}])`;
    } else {
      const baseExpr = primitiveToZod(simpleType.baseType, definedTypes, constName, usedHelpers);
      expr = simpleType.facets
        ? withFacets(baseExpr, simpleType.facets, usage, resolvePrimitiveKind(simpleType.name, ir), resolveBuiltinLocal(simpleType.name, ir))
        : baseExpr;
    }
    schemaLines.push(`const ${constName.get(simpleType.name)} = ${registered(expr, simpleType.description, `qname: ${JSON.stringify(simpleType.name)}`)};`);
  }

  for (const complexType of Object.values(ir.complexTypes)) {
    const multiBranch = multiBranchGroups(complexType);
    const props = complexType.fields
      .map((field) => `${JSON.stringify(toFieldKey(field))}: ${withDescription(withCardinality(
        primitiveToZod(field.typeName, definedTypes, constName, usedHelpers),
        field,
        ir,
        field.choiceGroup !== undefined && multiBranch.has(field.choiceGroup)
      ), field.description)}`)
      .join(', ');

    const annotation = opts?.js ? '' : `: z.ZodType<${ifaceName.get(complexType.name)}>`;
    schemaLines.push(
      `const ${constName.get(complexType.name)}${annotation} = ${registered(
        `z.lazy(() => ${complexType.wildcards && complexType.wildcards.length > 0 ? 'z.looseObject' : 'z.object'}({${props}})${choiceRefines(complexType).join('')})`,
        complexType.description,
        fieldsMetaFor(complexType, ir),
      )};`
    );
  }

  for (const root of ir.rootElements) {
    const rootDef = ir.elements[root];
    // Root exports are fresh wrapper objects: registry meta is keyed by schema
    // object identity, so registering { root } on the shared type schema would
    // clobber its type meta (and collide when two roots share one type).
    const base = `z.lazy(() => ${primitiveToZod(rootDef.typeName, definedTypes, constName, usedHelpers)})`;
    const expr = rootDef.nillable ? `${base}.nullable()` : base;
    const rootMeta = [`root: ${JSON.stringify(root)}`];
    if (rootDef.typeName === '{http://www.w3.org/2001/XMLSchema}anyType') {
      rootMeta.push('open: true');
    }
    if (rootDef.defaultValue !== undefined) {
      rootMeta.push(`defaultValue: ${typedLiteral(resolvePrimitiveKind(rootDef.typeName, ir), rootDef.defaultValue)}`);
    }
    if (rootDef.fixedValue !== undefined) {
      rootMeta.push(`fixedValue: ${typedLiteral(resolvePrimitiveKind(rootDef.typeName, ir), rootDef.fixedValue)}`);
    }
    schemaLines.push(`export const ${exportNames.get(root)} = ${registered(expr, rootDef.description, rootMeta.join(', '))};`);
  }

  const xsdImports = [
    usage.totalDigits ? 'xsdTotalDigits' : undefined,
    usage.fractionDigits ? 'xsdFractionDigits' : undefined,
    ...[...usedHelpers].sort()
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
