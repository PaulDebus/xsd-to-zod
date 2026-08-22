import { z } from "zod";
import type { QName } from "./types.js";
import type { XsdDatatypeName } from "./xsdDateTime.js";

/** Lexical-space facets enforced by the runtime. */
export type XmlLexicalFacets = {
  whiteSpace?: "replace" | "collapse";
  /** Patterns per derivation step (OR within, AND across). */
  patterns?: string[][];
  enumerations?: string[];
  minInclusive?: string;
  maxInclusive?: string;
  minExclusive?: string;
  maxExclusive?: string;
  datatype?: XsdDatatypeName;
};

/** Per-field XML knowledge stored on the containing object schema. */
export type XmlFieldMeta = {
  kind: "element" | "attribute" | "text" | "any" | "anyAttribute";
  qname: QName;
  defaultValue?: unknown;
  fixedValue?: unknown;
  datatype?: XsdDatatypeName;
  open?: boolean;
  fixedLexical?: string;
  substitutes?: QName[];
  position?: number;
  namespaceConstraint?: string;
  qnameValue?: boolean;
};

/** XML knowledge attached to generated zod schemas via xmlRegistry. */
export type XmlMeta = {
  qname?: QName;
  root?: QName;
  defaultValue?: unknown;
  fixedValue?: unknown;
  open?: boolean;
  datatype?: XsdDatatypeName;
  fixedLexical?: string;
  facets?: XmlLexicalFacets;
  substElement?: QName;
  qnameValue?: boolean;
  fields?: Record<string, XmlFieldMeta>;
};

/** Typed registry — globalThis singleton so generated modules and runtime share the instance. */
const globalStore = globalThis as {
  __xsd_to_zod_xmlRegistry__?: z.core.$ZodRegistry<XmlMeta>;
};

export const xmlRegistry: z.core.$ZodRegistry<XmlMeta> =
  globalStore.__xsd_to_zod_xmlRegistry__ ?? z.registry<XmlMeta>();
if (!globalStore.__xsd_to_zod_xmlRegistry__) {
  globalStore.__xsd_to_zod_xmlRegistry__ = xmlRegistry;
}
