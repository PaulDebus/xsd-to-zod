// AUTO-GENERATED — DO NOT EDIT
import { z } from 'zod';
import { xmlRegistry } from 'xsd-to-zod';
// Generator version stamp — the runtime warns when its major version differs.
export const generatedBy = "xsd-to-zod@1.0.1";

export interface Contact {
  "name": string;
  "email"?: string | undefined;
  "tag"?: string[] | undefined;
  "id": number;
  "active"?: boolean | undefined;
}
export type ContactIn = z.input<typeof ContactSchema>;
export const ContactSchema = z.lazy(() => z.object({"name": z.string(), "email": z.string().optional(), "tag": z.array(z.string()).optional(), "id": z.number().int().min(-2147483648).max(2147483647).register(xmlRegistry, { simpleType: {"primitive":"decimal","lexical":"integer"}, lexicalType: "integer" }), "active": z.boolean().optional()})).register(xmlRegistry, { qname: "{urn:usability:simple}Contact", fields: { "name": { kind: "element", qname: "{urn:usability:simple}name" }, "email": { kind: "element", qname: "{urn:usability:simple}email" }, "tag": { kind: "element", qname: "{urn:usability:simple}tag" }, "id": { kind: "attribute", qname: "{}id" }, "active": { kind: "attribute", qname: "{}active" } } });
export const contactSchema = z.lazy(() => ContactSchema).register(xmlRegistry, { root: "{urn:usability:simple}contact", generatedBy, namespacePrefixes: {"urn:usability:simple":"t"} });
