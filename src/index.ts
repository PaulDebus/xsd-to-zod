export { Xsd2ZodError } from "./errors.js";
export type { IrToZodOptions } from "./irToZod.js";
export {
  fieldKeyFromIr,
  irToZod,
  rootSchemaExportNames,
  sanitizeIdentifier,
} from "./irToZod.js";
export type { ParseXsdOptions } from "./parseXsd.js";
export { parseXsd } from "./parseXsd.js";
export { runPostGenerationFormatting } from "./postProcess.js";
export { readXmlFile } from "./readXmlFile.js";
export type { ParseXmlOptions } from "./runtime.js";
export {
  decodeTagNameCharRefs,
  decodeXmlEntities,
  parseXml,
  safeParseXml,
  serializeXml,
} from "./runtime.js";
export type {
  Cardinality,
  ComplexTypeDef,
  ElementDef,
  Facet,
  FieldKind,
  IrField,
  QName,
  SimpleTypeDef,
  XsdIr,
} from "./types.js";
export type { XmlFieldMeta, XmlMeta } from "./xmlMeta.js";
export { xmlRegistry } from "./xmlMeta.js";
export {
  countFractionDigits,
  countTotalDigits,
  xsdDecimalCompare,
  xsdFractionDigits,
  xsdTotalDigits,
} from "./xsdChecks.js";
export {
  xsdBase64Binary,
  xsdDate,
  xsdDateTime,
  xsdDuration,
  xsdGDay,
  xsdGMonth,
  xsdGMonthDay,
  xsdGYear,
  xsdGYearMonth,
  xsdHexBinary,
  xsdLanguage,
  xsdName,
  xsdNCName,
  xsdNCNames,
  xsdNMTOKEN,
  xsdNMTOKENS,
  xsdTime,
} from "./xsdLexicals.js";
