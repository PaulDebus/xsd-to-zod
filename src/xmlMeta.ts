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
  /** Declared default lexical, retained on substitution like fixedLexical. */
  defaultLexical?: string;
  /** Per-index fixed lexicals for merged same-qname siblings (undefined = unconstrained position). */
  fixedLexicals?: (string | undefined)[];
  substitutes?: QName[];
  position?: number;
  namespaceConstraint?: string;
  qnameValue?: boolean;
};

/** One branch of an xs:choice: the result keys its fields occupy. */
export type XmlChoiceBranchMeta = {
  /** Branch identity (matches XmlChoiceMeta.guard.branch of nested groups). */
  id: string;
  keys: { key: string; required: boolean }[];
};

/** xs:choice group semantics, precomputed by codegen; enforced by the runtime. */
export type XmlChoiceMeta = {
  required: boolean;
  repeated: boolean;
  /** Precomputed user-facing message, e.g. "choice requires exactly one of: card, iban". */
  message: string;
  branches: XmlChoiceBranchMeta[];
  /** Set when this group is nested inside a branch of an enclosing group. */
  guard?: { group: string; branch: string };
  /** Group has a wildcard branch: always satisfiable, content invisible to key checks. */
  wildcard?: true;
  /** Runtime enforces this group top-level (multi-branch, non-wildcard, not repeated-optional). */
  enforce?: true;
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
  /** Declared default lexical, retained on substitution like fixedLexical. */
  defaultLexical?: string;
  facets?: XmlLexicalFacets;
  substElement?: QName;
  qnameValue?: boolean;
  fields?: Record<string, XmlFieldMeta>;
  choices?: Record<string, XmlChoiceMeta>;
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
