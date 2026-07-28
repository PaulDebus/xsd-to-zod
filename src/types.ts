export type QName = `{${string}}${string}`;

export type Cardinality = {
  minOccurs: number;
  maxOccurs: number | "unbounded";
};

export type FieldKind = "attribute" | "element" | "text";

export type IrField = Cardinality & {
  kind: FieldKind;
  qname: QName;
  typeName: QName;
  nillable?: boolean;
  choiceGroup?: string;
  // Identity of the branch within the choice group (one per direct child of
  // the xs:choice) — a group/compositor branch keeps its fields together.
  choiceBranch?: string;
  defaultValue?: string;
  fixedValue?: string;
  /** Text of xs:annotation/xs:documentation, emitted as .describe() (#25). */
  description?: string;
};

export type Facet =
  | { kind: "enumeration"; value: string }
  | { kind: "pattern"; value: string }
  | { kind: "length"; value: number }
  | { kind: "minLength"; value: number }
  | { kind: "maxLength"; value: number }
  // Order facets keep the raw XSD lexical: the bound can exceed
  // Number.MAX_SAFE_INTEGER, and codegen picks the JS representation
  // (number vs bigint literal) per resolved base type.
  | { kind: "minInclusive"; value: string }
  | { kind: "maxInclusive"; value: string }
  | { kind: "minExclusive"; value: string }
  | { kind: "maxExclusive"; value: string }
  | { kind: "totalDigits"; value: number }
  | { kind: "fractionDigits"; value: number }
  | { kind: "whiteSpace"; value: "preserve" | "replace" | "collapse" };

export type SimpleTypeDef = {
  name: QName;
  description?: string;
} & (
  | { kind: "restriction"; baseType: QName; facets?: Facet[] }
  | { kind: "list"; itemType: QName }
  | { kind: "union"; memberTypes: QName[] }
);

export type ComplexTypeDef = {
  name: QName;
  baseType?: QName;
  fields: IrField[];
  description?: string;
  choiceGroups?: Record<string, Cardinality>;
  /** xs:any / xs:anyAttribute wildcards (lax tier: content is captured in the open shape). */
  wildcards?: WildcardDef[];
};

export type WildcardDef = {
  kind: "any" | "anyAttribute";
  /** Raw namespace constraint, e.g. '##any', '##other', '##targetNamespace ##local'. */
  namespaceConstraint: string;
};

export type ElementDef = {
  name: QName;
  typeName: QName;
  cardinality: Cardinality;
  nillable?: boolean;
  description?: string;
  /** Raw lexicals; coerced to the JS type at emission (#68). */
  defaultValue?: string;
  fixedValue?: string;
};

export type XsdIr = {
  targetNamespaces: string[];
  /** References and namespace prefixes that could not be resolved (fields are kept or skipped as before; this list makes the omissions visible). */
  unresolvedRefs: string[];
  simpleTypes: Record<string, SimpleTypeDef>;
  complexTypes: Record<string, ComplexTypeDef>;
  elements: Record<string, ElementDef>;
  rootElements: QName[];
};
