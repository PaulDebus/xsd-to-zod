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
};

export type SimpleTypeDef = {
  name: QName;
  baseType: QName;
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
};

export type RuntimeTypeMetadata = {
  typeName: QName;
  fields: RuntimeFieldMetadata[];
};

export type RuntimeRootMetadata = {
  rootElement: QName;
  typeName: QName;
  fields: RuntimeFieldMetadata[];
};
