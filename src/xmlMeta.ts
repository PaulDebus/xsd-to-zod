import { z } from "zod";
import type { QName } from "./types.js";
import type { XsdDatatypeName } from "./xsdDateTime.js";

/**
 * Lexical-space facets of a simple type, enforced by the runtime during
 * parseXml against the ORIGINAL XML lexical (see runtime.ts checkLexicalFacets).
 * These constraints cannot live in the generated zod schema: a zod refine
 * only sees the coerced JS value, whose String() form is not the XML lexical
 * (`007` → 7, exact decimal boundaries → rounded doubles). The generated
 * schema keeps the value-space-correct checks only.
 *
 * All values are the raw XSD facet lexicals. Enumeration membership is a
 * value-space compare (both sides coerced the same way; date/time builtins —
 * `datatype` — canonicalized), decimal order boundaries compare exactly in
 * BigInt arithmetic.
 */
export type XmlLexicalFacets = {
  /** whiteSpace processing applied to the lexical before the facet checks. */
  whiteSpace?: "replace" | "collapse";
  /**
   * XSD pattern sources, one alternative set per derivation step: any one
   * pattern per set must match (XSD ORs patterns within a step, ANDs across
   * steps). Each pattern must match the whole processed lexical.
   */
  patterns?: string[][];
  /** Enumeration values as XSD lexicals. */
  enumerations?: string[];
  /** xs:decimal order-facet boundaries (exact lexical compare). */
  minInclusive?: string;
  maxInclusive?: string;
  minExclusive?: string;
  maxExclusive?: string;
  /** Date/time builtin of the type — selects canonicalizing enum compare. */
  datatype?: XsdDatatypeName;
};

/**
 * Per-field XML knowledge, stored on the containing object schema (not on the
 * field schemas): a named type can be referenced by several elements with
 * different qnames, so field-level meta would conflict on shared schemas.
 */
export type XmlFieldMeta = {
  kind: "element" | "attribute" | "text" | "any" | "anyAttribute";
  qname: QName;
  /**
   * Element default (coerced JS value). XSD applies an element default to
   * present-but-empty elements — not to absent ones — so it cannot be a zod
   * `.default()`; the runtime substitutes it while walking (#66). Attribute
   * defaults are plain `.default()` on the field schema instead — except in
   * structured date/time mode, where the meta carries the lexical and the
   * schema's transform produces the structured value.
   */
  defaultValue?: unknown;
  /**
   * Structured date/time fixed value (datatypes: "structured" only), held as
   * its XSD lexical: objects cannot ride a z.literal (reference equality), so
   * the fixed constraint is a canonical-lexical refine and the runtime
   * substitutes from here — validation then transforms it, like any content.
   */
  fixedValue?: unknown;
  /**
   * Structured date/time builtin of the field's values (datatypes:
   * "structured" only). The serializer canonicalizes non-string values back
   * to XSD lexicals with the matching writer; strings pass through.
   */
  datatype?: XsdDatatypeName;
  /**
   * Open (xs:anyType) content: the field holds the normalized open shape
   * (clark-keyed children, '@'-prefixed attributes, '_text') rather than a
   * schema-driven structure; the runtime walks/serializes it generically.
   */
  open?: boolean;
};

/**
 * XML knowledge attached to generated zod schemas via {@link xmlRegistry}.
 * - `qname`: the XSD type name (named types).
 * - `root`: the document root element qname (root element schemas only).
 * - `fields`: per-field XML info on object schemas, keyed by object property
 *   (`@local` for attributes, `_text` for simpleContent text, local element
 *   names otherwise). Cardinality, nillable and defaults stay encoded in the
 *   zod schema itself; the runtime reads them from the schema def.
 */
export type XmlMeta = {
  qname?: QName;
  root?: QName;
  /**
   * Root element default/fixed (coerced JS value). Same rule as field
   * defaults: applies to a present-but-empty root element, so the runtime
   * substitutes it while walking rather than encoding a zod default.
   */
  defaultValue?: unknown;
  fixedValue?: unknown;
  /** Open (xs:anyType) root element — see XmlFieldMeta.open. */
  open?: boolean;
  /** Structured date/time builtin of a simple-typed root — see XmlFieldMeta.datatype. */
  datatype?: XsdDatatypeName;
  /** Lexical-space facets of a simple type — enforced by the runtime. */
  facets?: XmlLexicalFacets;
  fields?: Record<string, XmlFieldMeta>;
};

/**
 * Typed registry carrying XML metadata on generated schemas — one generated
 * artifact instead of a parallel `.meta.ts` structure. A dedicated registry
 * (not zod's global one) keeps consumers' `GlobalMeta` unpolluted.
 *
 * Stored as a globalThis singleton (same trick as zod's globalRegistry):
 * generated modules import it from the *installed* xsd-to-zod package while tests
 * and the CLI may hold a *different* copy of the library — without a shared
 * instance, registrations would land in a registry the runtime never reads.
 */
const globalStore = globalThis as {
  __xsd_to_zod_xmlRegistry__?: z.core.$ZodRegistry<XmlMeta>;
};

export const xmlRegistry: z.core.$ZodRegistry<XmlMeta> =
  globalStore.__xsd_to_zod_xmlRegistry__ ?? z.registry<XmlMeta>();
if (!globalStore.__xsd_to_zod_xmlRegistry__) {
  globalStore.__xsd_to_zod_xmlRegistry__ = xmlRegistry;
}
