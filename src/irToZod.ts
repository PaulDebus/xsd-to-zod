import { clarkToLocal } from './parseXsd.js';
import type {
  ComplexTypeDef,
  Facet,
  IrField,
  QName,
  RuntimeFieldMetadata,
  RuntimeMetadata,
  RuntimeRootMetadata,
  RuntimeTypeMetadata,
  XsdIr
} from './types.js';

const XSD_NS = 'http://www.w3.org/2001/XMLSchema';

const primitiveToZod = (typeName: QName, definedTypes: Set<string>): string => {
  const builtin = typeName.match(/^\{(.*)}(.*)$/);
  if (!builtin) {
    return 'z.unknown()';
  }
  const [, ns, local] = builtin;
  if (ns !== XSD_NS) {
    // Unresolvable references (e.g. type="string" in a schema whose default
    // namespace is the targetNamespace) must not emit a dangling schemas lookup.
    return definedTypes.has(typeName) ? `schemas[${JSON.stringify(typeName)}]` : 'z.unknown()';
  }

  switch (local) {
    case 'string':
    case 'token':
    case 'date':
    case 'dateTime':
      return 'z.string()';
    case 'boolean':
      return 'z.boolean()';
    case 'int':
    case 'integer':
      return 'z.number().int()';
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

// fixed/default values arrive as XSD lexicals; emit them coerced to the field's
// JS type so the literal/default matches what the runtime parser produces (#68).
const typedLiteral = (schema: string, raw: string): string => {
  if (isNumberType(schema)) {
    return String(Number(raw));
  }
  if (schema === 'z.boolean()') {
    return raw === 'true' || raw === '1' ? 'true' : 'false';
  }
  return JSON.stringify(raw);
};

const withCardinality = (schema: string, field: IrField): string => {
  let result = field.fixedValue !== undefined ? `z.literal(${typedLiteral(schema, field.fixedValue)})` : schema;
  if (field.nillable) {
    result = `${result}.nullable()`;
  }
  if (field.defaultValue !== undefined && field.fixedValue === undefined) {
    result = `${result}.default(${typedLiteral(schema, field.defaultValue)})`;
  }
  if (field.maxOccurs === 'unbounded' || field.maxOccurs > 1) {
    result = `z.array(${result})`;
  }
  return field.minOccurs === 0 ? `${result}.optional()` : result;
};

const toFieldKey = (field: IrField): string => {
  if (field.kind === 'text') {
    return '_text';
  }
  const local = clarkToLocal(field.qname);
  return field.kind === 'attribute' ? `@${local}` : local;
};

const metadataForType = (type: ComplexTypeDef, ir: XsdIr): RuntimeTypeMetadata => ({
  typeName: type.name,
  fields: type.fields.map((field) => {
    const simpleType = ir.simpleTypes[field.typeName];
    return {
      ...field,
      key: toFieldKey(field),
      ...(simpleType?.facets ? { facets: simpleType.facets } : {})
    };
  })
});

export const buildRuntimeMetadata = (ir: XsdIr): RuntimeMetadata => {
  const metadataTypes: RuntimeTypeMetadata[] = Object.values(ir.complexTypes).map(t => metadataForType(t, ir));
  for (const simpleType of Object.values(ir.simpleTypes)) {
    if (simpleType.itemType) {
      metadataTypes.push({
        typeName: simpleType.name,
        fields: [],
        baseType: simpleType.baseType,
        listItemType: simpleType.itemType,
        ...(simpleType.facets ? { facets: simpleType.facets } : {})
      });
      continue;
    }
    if (simpleType.memberTypes) {
      metadataTypes.push({
        typeName: simpleType.name,
        fields: [],
        baseType: simpleType.baseType,
        unionMemberTypes: simpleType.memberTypes,
        ...(simpleType.facets ? { facets: simpleType.facets } : {})
      });
      continue;
    }
    // Plain restriction simple types carry no content-model fields: elements of
    // these types parse to the coerced base primitive, not a {_text} object (#71).
    metadataTypes.push({
      typeName: simpleType.name,
      fields: [],
      baseType: simpleType.baseType,
      ...(simpleType.facets ? { facets: simpleType.facets } : {})
    });
  }
  const typesByQName: Record<string, RuntimeTypeMetadata> = {};
  for (const type of metadataTypes) {
    typesByQName[type.typeName] = type;
  }

  const rootMetadata: RuntimeRootMetadata[] = ir.rootElements
    .map((root) => {
      const rootDef = ir.elements[root];
      const typeMetadata = metadataTypes.find((type) => type.typeName === rootDef.typeName);
      return {
        rootElement: root,
        typeName: rootDef.typeName,
        fields: typeMetadata?.fields ?? []
      };
    });

  return {
    types: typesByQName,
    roots: rootMetadata
  };
};

export const irToZod = (ir: XsdIr): { schemas: string; metadata: string } => {
  const schemaLines: string[] = [];
  const { types: typesByQName, roots: rootMetadata } = buildRuntimeMetadata(ir);
  const definedTypes = new Set<string>([...Object.keys(ir.simpleTypes), ...Object.keys(ir.complexTypes)]);

  schemaLines.push('// AUTO-GENERATED — DO NOT EDIT');
  schemaLines.push("import { z } from 'zod';");
  schemaLines.push('const schemas: Record<string, z.ZodTypeAny> = {};');

  const withFacets = (base: string, facets: Facet[]): string => {
    if (!facets.length) return base;

    const enumFacets = facets.filter(f => f.kind === 'enumeration');
    const otherFacets = facets.filter(f => f.kind !== 'enumeration' && f.kind !== 'whiteSpace');

    if (enumFacets.length > 0 && otherFacets.length === 0) {
      const values = enumFacets.map(f => f.value);
      if (isStringType(base)) {
        return `z.enum([${values.map(v => JSON.stringify(v)).join(', ')}])`;
      }
      if (isNumberType(base)) {
        return `z.union([${values.map(v => `z.literal(${v})`).join(', ')}])`;
      }
      return base;
    }

    let result = base;
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
        case 'totalDigits': {
          const limit = Math.pow(10, facet.value) - 1;
          result += `.min(${-limit}).max(${limit})`;
          break;
        }
        case 'fractionDigits': {
          const step = Math.pow(10, -facet.value);
          result += `.multipleOf(${step})`;
          break;
        }
      }
    }

    if (enumFacets.length > 0) {
      const values = enumFacets.map(f => JSON.stringify(f.value));
      result += `.refine((val) => [${values.join(', ')}].includes(val))`;
    }

    return result;
  };

  for (const simpleType of Object.values(ir.simpleTypes)) {
    if (simpleType.itemType) {
      const itemExpr = primitiveToZod(simpleType.itemType, definedTypes);
      schemaLines.push(`schemas[${JSON.stringify(simpleType.name)}] = z.preprocess((v) => typeof v === "string" ? v.trim().split(/\\s+/) : v, z.array(${itemExpr}));`);
      continue;
    }
    if (simpleType.memberTypes) {
      const memberExprs = simpleType.memberTypes.map(mt => primitiveToZod(mt, definedTypes));
      schemaLines.push(`schemas[${JSON.stringify(simpleType.name)}] = z.union([${memberExprs.join(', ')}]);`);
      continue;
    }
    const baseExpr = primitiveToZod(simpleType.baseType, definedTypes);
    const expr = simpleType.facets ? withFacets(baseExpr, simpleType.facets) : baseExpr;
    schemaLines.push(`schemas[${JSON.stringify(simpleType.name)}] = ${expr};`);
  }

  for (const complexType of Object.values(ir.complexTypes)) {
    const props = complexType.fields
      .map((field) => `${JSON.stringify(toFieldKey(field))}: ${withCardinality(primitiveToZod(field.typeName, definedTypes), field)}`)
      .join(', ');

    const choiceGroups = [...new Set(complexType.fields.map((field) => field.choiceGroup).filter(Boolean))] as string[];
    if (choiceGroups.length === 1) {
      const selectedChoiceGroup = choiceGroups[0];
      const branches = complexType.fields.filter((field) => field.choiceGroup === selectedChoiceGroup && field.kind === 'element');
      if (branches.length > 1) {
        const commonProps = complexType.fields
          .filter((field) => field.choiceGroup !== selectedChoiceGroup)
          .map((field) => `${JSON.stringify(toFieldKey(field))}: ${withCardinality(primitiveToZod(field.typeName, definedTypes), field)}`)
          .join(', ');
        const branchSchemas = branches
          .map((branch) => {
            const key = toFieldKey(branch);
            const branchProp = `${JSON.stringify(key)}: ${withCardinality(
              primitiveToZod(branch.typeName, definedTypes),
              branch
            )}`;
            const branchBody = [commonProps, `__choice: z.literal(${JSON.stringify(key)})`, branchProp].filter(Boolean).join(', ');
            return `z.object({ ${branchBody} })`;
          })
          .join(', ');

        const discriminatedUnion = `z.discriminatedUnion('__choice', [${branchSchemas}])`;
        if (branches.every((branch) => branch.minOccurs === 0)) {
          const withoutChoice = `z.object({ ${commonProps} })`;
          schemaLines.push(`schemas[${JSON.stringify(complexType.name)}] = z.lazy(() => z.union([${discriminatedUnion}, ${withoutChoice}]));`);
          continue;
        }

        schemaLines.push(`schemas[${JSON.stringify(complexType.name)}] = z.lazy(() => ${discriminatedUnion});`);
        continue;
      }
    }

    schemaLines.push(`schemas[${JSON.stringify(complexType.name)}] = z.lazy(() => z.object({${props}}));`);
  }

  const exportNames = rootSchemaExportNames(ir.rootElements);
  for (const root of ir.rootElements) {
    const rootDef = ir.elements[root];
    // primitiveToZod resolves builtins to literal zod expressions and named types
    // to schemas[...] lookups — indexing schemas directly breaks for builtin-typed
    // roots, which have no entry in the schemas record (#71).
    const base = primitiveToZod(rootDef.typeName, definedTypes);
    const expr = rootDef.nillable ? `${base}.nullable()` : base;
    schemaLines.push(`export const ${exportNames.get(root)} = ${expr};`);
  }

  return {
    schemas: `${schemaLines.join('\n')}\n`,
    metadata: `// AUTO-GENERATED — DO NOT EDIT\nexport const runtimeMetadata = ${JSON.stringify(
      {
        types: typesByQName,
        roots: rootMetadata
      },
      null,
      2
    )} as const;\n`
  };
};

export const fieldKeyFromIr = toFieldKey;
export type { RuntimeFieldMetadata };

// Generated export identifiers must be valid JS identifiers and unique across
// all roots — legal XSD names (unicode letters, or the same local name in two
// namespaces) otherwise produce invalid TypeScript (#70).
export const sanitizeIdentifier = (name: string): string => {
  const cleaned = name.replace(/[^\p{L}\p{N}_$]/gu, '_');
  return /^[\p{L}_$]/u.test(cleaned) ? cleaned : `_${cleaned}`;
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
