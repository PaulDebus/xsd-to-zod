export { parseXsd } from './parseXsd.js';
export { fieldKeyFromIr, irToZod, rootSchemaExportNames, sanitizeIdentifier } from './irToZod.js';
export type { IrToZodOptions } from './irToZod.js';
export { readXmlFile } from './readXmlFile.js';
export { decodeTagNameCharRefs, decodeXmlEntities, parseXml, safeParseXml, serializeXml } from './runtime.js';
export type { ParseXmlOptions } from './runtime.js';
export { runPostGenerationFormatting } from './postProcess.js';
export { xmlRegistry } from './xmlMeta.js';
export type { XmlFieldMeta, XmlMeta } from './xmlMeta.js';
export { countFractionDigits, countTotalDigits, xsdFractionDigits, xsdTotalDigits } from './xsdChecks.js';
export type {
  ComplexTypeDef,
  ElementDef,
  IrField,
  QName,
  SimpleTypeDef,
  XsdIr
} from './types.js';
