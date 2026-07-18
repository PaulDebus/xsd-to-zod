import { clarkToLocal } from './parseXsd.js';
import type {
  ComplexTypeDef,
  Facet,
  IrField,
  QName,
  RuntimeFieldMetadata,
  RuntimeRootMetadata,
  RuntimeTypeMetadata,
  XsdIr
} from './types.js';

const textFieldFor = (typeName: QName): RuntimeFieldMetadata => ({
  key: '_text',
  kind: 'text',
  qname: `{}_text` as QName,
  typeName,
  minOccurs: 1,
  maxOccurs: 1,
  nillable: false
});

const XSD_NS = 'http://www.w3.org/2001/XMLSchema';

const primitiveToZod = (typeName: QName): string => {
  const builtin = typeName.match(/^\{(.*)}(.*)$/);
  if (!builtin) {
    return 'z.unknown()';
  }
  const [, ns, local] = builtin;
  if (ns !== XSD_NS) {
    return `schemas[${JSON.stringify(typeName)}]`;
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

const withCardinality = (schema: string, field: IrField): string => {
  let result = schema;
  if (field.nillable) {
    result = `${result}.nullable()`;
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

export const irToZod = (ir: XsdIr): { schemas: string; metadata: string } => {
  const schemaLines: string[] = [];
  const metadataTypes: RuntimeTypeMetadata[] = Object.values(ir.complexTypes).map(t => metadataForType(t, ir));
  for (const simpleType of Object.values(ir.simpleTypes)) {
    const textField = textFieldFor(simpleType.baseType);
    if (simpleType.facets) {
      textField.facets = simpleType.facets;
    }
    metadataTypes.push({
      typeName: simpleType.name,
      fields: [textField],
      ...(simpleType.facets ? { facets: simpleType.facets } : {})
    });
  }
  const typesByQName: Record<string, RuntimeTypeMetadata> = {};
  for (const type of metadataTypes) {
    typesByQName[type.typeName] = type;
  }

  schemaLines.push('// AUTO-GENERATED — DO NOT EDIT');
  schemaLines.push("import { z } from 'zod';");
  schemaLines.push('const schemas: Record<string, z.ZodTypeAny> = {};');

  const isStringType = (zodExpr: string): boolean => zodExpr.startsWith('z.string()');
  const isNumberType = (zodExpr: string): boolean => zodExpr.startsWith('z.number()');

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
    const baseExpr = primitiveToZod(simpleType.baseType);
    const expr = simpleType.facets ? withFacets(baseExpr, simpleType.facets) : baseExpr;
    schemaLines.push(`schemas[${JSON.stringify(simpleType.name)}] = ${expr};`);
  }

  for (const complexType of Object.values(ir.complexTypes)) {
    const props = complexType.fields
      .map((field) => `${JSON.stringify(toFieldKey(field))}: ${withCardinality(primitiveToZod(field.typeName), field)}`)
      .join(', ');

    const choiceGroups = [...new Set(complexType.fields.map((field) => field.choiceGroup).filter(Boolean))] as string[];
    if (choiceGroups.length === 1) {
      const selectedChoiceGroup = choiceGroups[0];
      const branches = complexType.fields.filter((field) => field.choiceGroup === selectedChoiceGroup && field.kind === 'element');
      if (branches.length > 1) {
        const commonProps = complexType.fields
          .filter((field) => field.choiceGroup !== selectedChoiceGroup)
          .map((field) => `${JSON.stringify(toFieldKey(field))}: ${withCardinality(primitiveToZod(field.typeName), field)}`)
          .join(', ');
        const branchSchemas = branches
          .map((branch) => {
            const key = toFieldKey(branch);
            const branchProp = `${JSON.stringify(key)}: ${withCardinality(
              primitiveToZod(branch.typeName),
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

  for (const root of ir.rootElements) {
    const rootDef = ir.elements[root];
    schemaLines.push(`export const ${clarkToLocal(root)}Schema = schemas[${JSON.stringify(rootDef.typeName)}];`);
  }

  const rootMetadata: RuntimeRootMetadata[] = ir.rootElements
    .map((root) => {
      const rootDef = ir.elements[root];
      const typeMetadata = metadataTypes.find((type) => type.typeName === rootDef.typeName);
      return {
        rootElement: root,
        typeName: rootDef.typeName,
        fields: typeMetadata?.fields ?? [textFieldFor(rootDef.typeName)]
      };
    });

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
