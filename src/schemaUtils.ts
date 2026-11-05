// Pure zod-schema helpers shared by the XML runtime and the standalone
// identity checker. Keep this module free of XML parsing, stores, and
// registry lookups so it can be inlined into generated standalone modules.

import type { z } from "zod";

export type AnyDef = z.core.$ZodTypeDef;
export type AnySchema = z.core.$ZodType;

const defAs = <T extends AnyDef>(def: AnyDef, type: T["type"]): T | undefined =>
  def.type === type ? (def as T) : undefined;

// Peel exactly one wrapper level (lazy/optional/nullable/default/readonly);
// returns the input unchanged when it is not a wrapper.
export const peelOnce = (schema: AnySchema): AnySchema => {
  const def = schema._zod.def;
  if (def.type === "lazy") {
    // Read zod's cached inner type instead of calling the getter: generated
    // code wraps every type in a z.lazy whose getter builds the whole object
    // literal, so calling it on each peel would reconstruct the schema.
    return (schema as z.core.$ZodLazy)._zod.innerType;
  }
  const wrapper =
    defAs<z.core.$ZodOptionalDef>(def, "optional") ??
    defAs<z.core.$ZodNullableDef>(def, "nullable") ??
    defAs<z.core.$ZodDefaultDef>(def, "default") ??
    defAs<z.core.$ZodReadonlyDef>(def, "readonly");
  return wrapper ? wrapper.innerType : schema;
};

// Peel all modifier wrappers down to the structural schema (leaf, object,
// array, pipe, …).
export const unwrapModifiers = (schema: AnySchema): AnySchema => {
  let current = schema;
  let checkpoint = schema;
  let span = 1;
  let steps = 0;
  for (;;) {
    const next = peelOnce(current);
    if (next === current) {
      if (current._zod.def.type === "lazy") {
        throw new Error("Cyclic XML schema wrappers have no structural value type");
      }
      return current;
    }
    current = next;
    if (current === checkpoint) {
      throw new Error("Cyclic XML schema wrappers have no structural value type");
    }
    if (++steps === span) {
      checkpoint = current;
      span *= 2;
      steps = 0;
    }
  }
};

export const objectDefOf = (schema: AnySchema): z.core.$ZodObjectDef | undefined =>
  defAs<z.core.$ZodObjectDef>(unwrapModifiers(schema)._zod.def, "object");

export type FieldAnalysis = {
  itemSchema: AnySchema;
  isArray: boolean;
  hasDefault: boolean;
  defaultValue: unknown;
  hasFixed: boolean;
  fixedValue: unknown;
};

const analyzeFieldCache = new WeakMap<AnySchema, FieldAnalysis>();

export const analyzeField = (schema: AnySchema): FieldAnalysis => {
  const cached = analyzeFieldCache.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  let current = schema;
  let isArray = false;
  let hasDefault = false;
  let defaultValue: unknown;
  let hasFixed = false;
  let fixedValue: unknown;
  for (;;) {
    const def = current._zod.def;
    const as = <T extends AnyDef>(t: T["type"]): T | undefined => defAs<T>(def, t);
    const opt = as<z.core.$ZodOptionalDef>("optional");
    if (opt) {
      current = opt.innerType;
      continue;
    }
    const nul = as<z.core.$ZodNullableDef>("nullable");
    if (nul) {
      current = nul.innerType;
      continue;
    }
    const ro = as<z.core.$ZodReadonlyDef>("readonly");
    if (ro) {
      current = ro.innerType;
      continue;
    }
    const arr = as<z.core.$ZodArrayDef>("array");
    if (arr) {
      isArray = true;
      current = arr.element;
      continue;
    }
    const dflt = as<z.core.$ZodDefaultDef>("default");
    if (dflt) {
      hasDefault = true;
      defaultValue = dflt.defaultValue;
      current = dflt.innerType;
      continue;
    }
    const lit = as<z.core.$ZodLiteralDef<z.core.util.Literal>>("literal");
    if (lit) {
      hasFixed = true;
      fixedValue = lit.values[0];
    }
    const analysis: FieldAnalysis = {
      itemSchema: current,
      isArray,
      hasDefault,
      defaultValue,
      hasFixed,
      fixedValue,
    };
    analyzeFieldCache.set(schema, analysis);
    return analysis;
  }
};

export const XSI_TYPE_FIELD = "xsiType";

export const xsiTypeUnionDef = (
  schema: AnySchema,
): z.core.$ZodDiscriminatedUnionDef | undefined => {
  const def = unwrapModifiers(schema)._zod.def;
  if (def.type !== "union" || !("discriminator" in def)) {
    return undefined;
  }
  return def.discriminator === XSI_TYPE_FIELD
    ? (def as z.core.$ZodDiscriminatedUnionDef)
    : undefined;
};
