import { clarkToLocal } from './parseXsd.js';
import type {
  ComplexTypeDef,
  IrField,
  QName,
  RuntimeFieldMetadata,
  RuntimeRootMetadata,
  RuntimeTypeMetadata,
  XsdIr
} from './types.js';

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
  const isArray = field.maxOccurs === 'unbounded' || field.maxOccurs > 1;
  const arrWrapped = isArray ? `z.array(${schema})` : schema;
  return field.minOccurs === 0 ? `${arrWrapped}.optional()` : arrWrapped;
};

const toFieldKey = (field: IrField): string => {
  if (field.kind === 'text') {
    return '_text';
  }
  const local = clarkToLocal(field.qname);
  return field.kind === 'attribute' ? `@${local}` : local;
};

const metadataForType = (type: ComplexTypeDef): RuntimeTypeMetadata => ({
  typeName: type.name,
  fields: type.fields.map((field) => ({
    ...field,
    key: toFieldKey(field)
  }))
});

export const irToZod = (ir: XsdIr): { schemas: string; metadata: string } => {
  const schemaLines: string[] = [];
  const metadataTypes: RuntimeTypeMetadata[] = Object.values(ir.complexTypes).map(metadataForType);

  schemaLines.push('// AUTO-GENERATED — DO NOT EDIT');
  schemaLines.push("import { z } from 'zod';");
  schemaLines.push('const schemas: Record<string, z.ZodTypeAny> = {};');

  for (const simpleType of Object.values(ir.simpleTypes)) {
    schemaLines.push(`schemas[${JSON.stringify(simpleType.name)}] = ${primitiveToZod(simpleType.baseType)};`);
  }

  for (const complexType of Object.values(ir.complexTypes)) {
    const props = complexType.fields
      .map((field) => `${JSON.stringify(toFieldKey(field))}: ${withCardinality(primitiveToZod(field.typeName), field)}`)
      .join(', ');

    const choiceGroups = [...new Set(complexType.fields.map((field) => field.choiceGroup).filter(Boolean))] as string[];
    if (choiceGroups.length === 1) {
      const branches = complexType.fields.filter((field) => field.choiceGroup === choiceGroups[0] && field.kind === 'element');
      if (branches.length > 1) {
        const branchSchemas = branches
          .map((branch) => {
            const key = toFieldKey(branch);
            return `z.object({ __choice: z.literal(${JSON.stringify(key)}), ${JSON.stringify(key)}: ${withCardinality(
              primitiveToZod(branch.typeName),
              branch
            )} })`;
          })
          .join(', ');

        schemaLines.push(`schemas[${JSON.stringify(complexType.name)}] = z.discriminatedUnion('__choice', [${branchSchemas}]);`);
        continue;
      }
    }

    schemaLines.push(`schemas[${JSON.stringify(complexType.name)}] = z.object({${props}});`);
  }

  for (const root of ir.rootElements) {
    const rootDef = ir.elements[root];
    schemaLines.push(`export const ${clarkToLocal(root)}Schema = schemas[${JSON.stringify(rootDef.typeName)}];`);
  }

  const rootMetadata: RuntimeRootMetadata[] = ir.rootElements
    .map((root) => {
      const rootDef = ir.elements[root];
      const typeMetadata = metadataTypes.find((type) => type.typeName === rootDef.typeName);
      if (!typeMetadata) {
        return undefined;
      }
      return {
        rootElement: root,
        typeName: rootDef.typeName,
        fields: typeMetadata.fields
      };
    })
    .filter((entry): entry is RuntimeRootMetadata => Boolean(entry));

  return {
    schemas: `${schemaLines.join('\n')}\n`,
    metadata: `// AUTO-GENERATED — DO NOT EDIT\nexport const runtimeMetadata = ${JSON.stringify(
      {
        types: metadataTypes,
        roots: rootMetadata
      },
      null,
      2
    )} as const;\n`
  };
};

export const fieldKeyFromIr = toFieldKey;
export type { RuntimeFieldMetadata };
