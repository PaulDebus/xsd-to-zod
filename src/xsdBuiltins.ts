// XSD builtin type names with integer value space — shared between codegen
// (irToZod maps them to z.number().int()) and the runtime (integer lexical
// coercion) so the two mappings can never drift apart (#75).
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
