export type QName = `{${string}}${string}`;

export type Cardinality = {
  minOccurs: number;
  maxOccurs: number | 'unbounded';
};

export type FieldKind = 'attribute' | 'element' | 'text';

export type IrField = Cardinality & {
  kind: FieldKind;
  qname: QName;
  typeName: QName;
  nillable?: boolean;
  choiceGroup?: string;
  defaultValue?: string;
  fixedValue?: string;
};

export type Facet =
  | { kind: 'enumeration'; value: string }
  | { kind: 'pattern'; value: string }
  | { kind: 'length'; value: number }
  | { kind: 'minLength'; value: number }
  | { kind: 'maxLength'; value: number }
  | { kind: 'minInclusive'; value: number }
  | { kind: 'maxInclusive'; value: number }
  | { kind: 'minExclusive'; value: number }
  | { kind: 'maxExclusive'; value: number }
  | { kind: 'totalDigits'; value: number }
  | { kind: 'fractionDigits'; value: number }
  | { kind: 'whiteSpace'; value: 'preserve' | 'replace' | 'collapse' };

export type SimpleTypeDef = {
  name: QName;
  baseType: QName;
  facets?: Facet[];
};

export type ComplexTypeDef = {
  name: QName;
  baseType?: QName;
  fields: IrField[];
};

export type ElementDef = {
  name: QName;
  typeName: QName;
  cardinality: Cardinality;
  nillable?: boolean;
};

export type XsdIr = {
  targetNamespaces: string[];
  simpleTypes: Record<string, SimpleTypeDef>;
  complexTypes: Record<string, ComplexTypeDef>;
  elements: Record<string, ElementDef>;
  rootElements: QName[];
};

export type RuntimeFieldMetadata = IrField & {
  key: string;
  facets?: Facet[];
};

export type RuntimeTypeMetadata = {
  typeName: QName;
  fields: RuntimeFieldMetadata[];
  facets?: Facet[];
};

export type RuntimeRootMetadata = {
  rootElement: QName;
  typeName: QName;
  fields: RuntimeFieldMetadata[];
};

export type RuntimeMetadata = {
  types: Record<string, RuntimeTypeMetadata>;
  roots: RuntimeRootMetadata[];
};
