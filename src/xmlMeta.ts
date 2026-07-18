import { z } from 'zod';
import type { QName } from './types.js';

/**
 * Per-field XML knowledge, stored on the containing object schema (not on the
 * field schemas): a named type can be referenced by several elements with
 * different qnames, so field-level meta would conflict on shared schemas.
 */
export type XmlFieldMeta = {
  kind: 'element' | 'attribute' | 'text';
  qname: QName;
  choiceGroup?: string;
  /**
   * Element default (coerced JS value, elements only). XSD applies an element
   * default to present-but-empty elements — not to absent ones — so it cannot
   * be a zod `.default()`; the runtime substitutes it while walking (#66).
   * Attribute defaults are plain `.default()` on the field schema instead.
   */
  defaultValue?: unknown;
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
  fields?: Record<string, XmlFieldMeta>;
};

/**
 * Typed registry carrying XML metadata on generated schemas — one generated
 * artifact instead of a parallel `.meta.ts` structure. A dedicated registry
 * (not zod's global one) keeps consumers' `GlobalMeta` unpolluted.
 *
 * Stored as a globalThis singleton (same trick as zod's globalRegistry):
 * generated modules import it from the *installed* xsd2zod package while tests
 * and the CLI may hold a *different* copy of the library — without a shared
 * instance, registrations would land in a registry the runtime never reads.
 */
const globalStore = globalThis as { __xsd2zod_xmlRegistry__?: z.core.$ZodRegistry<XmlMeta> };

export const xmlRegistry: z.core.$ZodRegistry<XmlMeta> = (globalStore.__xsd2zod_xmlRegistry__ ??= z.registry<XmlMeta>());
