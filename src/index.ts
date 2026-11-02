// Runtime API: everything generated modules import, plus the XML parse /
// serialize surface. The compiler lives at `xsd-to-zod/compiler`; codegen
// internals and build-time-only dependencies must not leak into this entry.

export type { ParseXmlOptions, SerializeXmlOptions } from "./runtime.js";
export { coerceXmlValue, parseXml, safeParseXml, serializeXml } from "./runtime.js";
export type { QName } from "./types.js";
export type {
  XmlChoiceArrayMeta,
  XmlChoiceBranchMeta,
  XmlChoiceFieldMeta,
  XmlChoiceMeta,
  XmlFieldMeta,
  XmlLexicalFacets,
  XmlMeta,
  XmlSimpleTypeMeta,
  XmlWrappedMeta,
} from "./xmlMeta.js";
export { xmlRegistry } from "./xmlMeta.js";
export type { XsdOrderDatatype } from "./xsdChecks.js";
export {
  xsdDecimalLexical,
  xsdFractionDigits,
  xsdOrderCompare,
  xsdTotalDigits,
} from "./xsdChecks.js";
export type {
  XsdDatatypeName,
  XsdDate,
  XsdDateTime,
  XsdDuration,
  XsdGDay,
  XsdGMonth,
  XsdGMonthDay,
  XsdGYear,
  XsdGYearMonth,
  XsdStructuredValue,
  XsdTime,
} from "./xsdDateTime.js";
export {
  parseXsdDatatype,
  parseXsdDate,
  parseXsdDateTime,
  parseXsdDuration,
  parseXsdGDay,
  parseXsdGMonth,
  parseXsdGMonthDay,
  parseXsdGYear,
  parseXsdGYearMonth,
  parseXsdTime,
  writeXsdDatatype,
  writeXsdDate,
  writeXsdDateTime,
  writeXsdDuration,
  writeXsdGDay,
  writeXsdGMonth,
  writeXsdGMonthDay,
  writeXsdGYear,
  writeXsdGYearMonth,
  writeXsdTime,
} from "./xsdDateTime.js";
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
  xsdQName,
  xsdTime,
} from "./xsdLexicals.js";
export { xsdPattern } from "./xsdPattern.js";
