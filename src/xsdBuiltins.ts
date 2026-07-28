// XSD builtin type names with integer value space — used by codegen (irToZod
// maps them to z.number().int() or z.bigint()); the runtime detects int-ness
// from the generated schema's zod checks, so it no longer needs type names (#75).

// Bounded integer builtins whose value space fits Number.MAX_SAFE_INTEGER —
// these map to z.number().int().
export const XSD_SAFE_INTEGER_TYPE_NAMES: ReadonlySet<string> = new Set([
  "int",
  "short",
  "byte",
  "unsignedInt",
  "unsignedShort",
  "unsignedByte",
]);

// Integer builtins that are arbitrary-precision (integer + derivations) or
// 64-bit-bounded beyond MAX_SAFE_INTEGER (long/unsignedLong) — these map to
// z.bigint() so no valid lexical is lost to double rounding.
export const XSD_BIGINT_TYPE_NAMES: ReadonlySet<string> = new Set([
  "integer",
  "long",
  "unsignedLong",
  "nonNegativeInteger",
  "nonPositiveInteger",
  "negativeInteger",
  "positiveInteger",
]);

export const XSD_INTEGER_TYPE_NAMES: ReadonlySet<string> = new Set([
  ...XSD_SAFE_INTEGER_TYPE_NAMES,
  ...XSD_BIGINT_TYPE_NAMES,
]);
