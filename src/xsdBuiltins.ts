// XSD builtin type names with integer value space — used by codegen (irToZod
// maps them to z.number().int()); the runtime detects int-ness from the
// generated schema's zod checks, so it no longer needs type names (#75).
export const XSD_INTEGER_TYPE_NAMES: ReadonlySet<string> = new Set([
  'int',
  'integer',
  'long',
  'short',
  'byte',
  'nonNegativeInteger',
  'nonPositiveInteger',
  'negativeInteger',
  'positiveInteger',
  'unsignedLong',
  'unsignedInt',
  'unsignedShort',
  'unsignedByte'
]);
