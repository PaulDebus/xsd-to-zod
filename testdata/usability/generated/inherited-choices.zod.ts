// AUTO-GENERATED — DO NOT EDIT
import { z } from 'zod';
import { xmlRegistry, xsdDateTime, xsdLanguage, xsdPattern } from 'xsd-to-zod';
import type { QName, XmlFieldMeta, XmlMeta } from 'xsd-to-zod';

const stringComplexXsiTypes: QName[] = ["{urn:usability:inherited-choices}Label"];

// Generator version stamp — the runtime warns when its major version differs.
export const generatedBy = "xsd-to-zod@1.0.1";

export interface Collection {
  /** One of: Label, Group, Item */
  "choice": ({ "Label": Label } | { "Group": Group } | { "Item": Item })[];
  "id": string;
}
export type CollectionIn = z.input<typeof CollectionTypeSchema>;
export interface Label {
  "_text": string;
  "lang": string;
}
export type LabelIn = z.input<typeof LabelSchema>;
export interface Link {
  "target"?: string | undefined;
  "href"?: string | undefined;
}
export type LinkIn = z.input<typeof LinkSchema>;
export interface Limit {
  "value"?: string | undefined;
}
export type LimitIn = z.input<typeof LimitSchema>;
export interface Setting {
  /** One of: Min, Max, Pattern */
  "choice"?: ({ "Min": Limit } | { "Max": Limit } | { "Pattern": Limit })[] | undefined;
  "kind"?: "ALPHA" | "NUMERIC" | "TEMPORAL" | undefined;
}
export type SettingIn = z.input<typeof SettingSchema>;
export interface Base {
  /** One of: Label, Title, Note, Version */
  "choice"?: ({ "Label": Label } | { "Title": Label } | { "Note": string } | { "Version": number })[] | undefined;
  "about"?: string | undefined;
  "id": string;
  "createdAt": string;
}
export type BaseIn = z.input<typeof BaseSchema>;
export interface Node extends Base {
  /** One of: ChildRef, ParentRef */
  "choice2"?: ({ "ChildRef": Link } | { "ParentRef": Link })[] | undefined;
}
export type NodeIn = z.input<typeof NodeSchema>;
export interface Group extends Node {
  /** One of: ItemRef, GroupRef */
  "choice3"?: ({ "ItemRef": Link } | { "GroupRef": Link })[] | undefined;
}
export type GroupIn = z.input<typeof GroupSchema>;
export interface Item extends Base {
  "Setting": Setting;
}
export type ItemIn = z.input<typeof ItemSchema>;
export const IdentifierSchema = z.lazy(() => z.string().regex(xsdPattern("[A-Za-z][A-Za-z0-9-]{0,31}"))).register(xmlRegistry, { qname: "{urn:usability:inherited-choices}Identifier" });
export const Setting_kind_SimpleTypeSchema = z.lazy(() => z.string().pipe(z.enum(["ALPHA", "NUMERIC", "TEMPORAL"]))).register(xmlRegistry, { qname: "{urn:usability:inherited-choices}Setting_kind_SimpleType" });
const BaseObjectSchema = z.object({"choice": z.array(z.union([z.strictObject({ "Label": z.lazy(() => LabelSchema) }), z.strictObject({ "Title": z.lazy(() => LabelSchema) }), z.strictObject({ "Note": z.string() }), z.strictObject({ "Version": z.number().int().min(0).register(xmlRegistry, { simpleType: {"primitive":"decimal","lexical":"integer"}, lexicalType: "integer" }) })])).optional(), "about": z.string().optional(), "id": IdentifierSchema, "createdAt": z.string().refine(xsdDateTime, { message: 'invalid xs:dateTime lexical' })});
const NodeObjectSchema = BaseObjectSchema.extend({"choice2": z.array(z.union([z.strictObject({ "ChildRef": z.lazy(() => LinkSchema) }), z.strictObject({ "ParentRef": z.lazy(() => LinkSchema) })])).optional()});
const GroupObjectSchema = NodeObjectSchema.extend({"choice3": z.array(z.union([z.strictObject({ "ItemRef": z.lazy(() => LinkSchema) }), z.strictObject({ "GroupRef": z.lazy(() => LinkSchema) })])).optional()});
const ItemObjectSchema = BaseObjectSchema.extend({"Setting": z.lazy(() => SettingSchema)});
export const CollectionTypeSchema = z.lazy(() => z.object({"choice": z.array(z.union([z.strictObject({ "Label": LabelSchema }), z.strictObject({ "Group": GroupSchema }), z.strictObject({ "Item": ItemSchema })])).min(1), "id": IdentifierSchema})).register(xmlRegistry, { qname: "{urn:usability:inherited-choices}anonymous_Collection_Type", fields: { "choice": { kind: "choice", qname: "{urn:usability:inherited-choices}Label", choice: { branches: [{ tag: "Label", qname: "{urn:usability:inherited-choices}Label" }, { tag: "Group", qname: "{urn:usability:inherited-choices}Group" }, { tag: "Item", qname: "{urn:usability:inherited-choices}Item" }], minOccurs: 1, maxOccurs: "unbounded" } }, "id": { kind: "attribute", qname: "{urn:usability:inherited-choices}id" } } });
export const LabelSchema = z.lazy(() => z.object({"_text": z.string(), "lang": z.preprocess((v) => typeof v === "string" ? v.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "") : v, z.string().refine(xsdLanguage, { message: 'invalid xs:language lexical' }))})).register(xmlRegistry, { qname: "{urn:usability:inherited-choices}Label", fields: { "_text": { kind: "text", qname: "{urn:usability:inherited-choices}_text" }, "lang": { kind: "attribute", qname: "{}lang" } } });
export const LinkSchema = z.lazy(() => z.object({"target": IdentifierSchema.optional(), "href": z.string().optional()})).register(xmlRegistry, { qname: "{urn:usability:inherited-choices}Link", fields: { "target": { kind: "attribute", qname: "{}target" }, "href": { kind: "attribute", qname: "{}href" } } });
export const LimitSchema = z.lazy(() => z.object({"value": z.string().optional()})).register(xmlRegistry, { qname: "{urn:usability:inherited-choices}Limit", fields: { "value": { kind: "attribute", qname: "{}value", anySimpleType: true } } });
export const SettingSchema = z.lazy(() => z.object({"choice": z.array(z.union([z.strictObject({ "Min": LimitSchema }), z.strictObject({ "Max": LimitSchema }), z.strictObject({ "Pattern": LimitSchema })])).optional(), "kind": Setting_kind_SimpleTypeSchema.optional()})).register(xmlRegistry, { qname: "{urn:usability:inherited-choices}Setting", fields: { "choice": { kind: "choice", qname: "{urn:usability:inherited-choices}Min", choice: { branches: [{ tag: "Min", qname: "{urn:usability:inherited-choices}Min" }, { tag: "Max", qname: "{urn:usability:inherited-choices}Max" }, { tag: "Pattern", qname: "{urn:usability:inherited-choices}Pattern" }], minOccurs: 0, maxOccurs: "unbounded" } }, "kind": { kind: "attribute", qname: "{}kind" } } });
const BaseFields: { [key: string]: XmlFieldMeta } = { "choice": { kind: "choice", qname: "{urn:usability:inherited-choices}Label", choice: { branches: [{ tag: "Label", qname: "{urn:usability:inherited-choices}Label" }, { tag: "Title", qname: "{urn:usability:inherited-choices}Title" }, { tag: "Note", qname: "{urn:usability:inherited-choices}Note", complexXsiTypes: stringComplexXsiTypes }, { tag: "Version", qname: "{urn:usability:inherited-choices}Version" }], minOccurs: 0, maxOccurs: "unbounded" } }, "about": { kind: "attribute", qname: "{}about" }, "id": { kind: "attribute", qname: "{urn:usability:inherited-choices}id" }, "createdAt": { kind: "attribute", qname: "{}createdAt" } };
const BaseMeta: XmlMeta = { qname: "{urn:usability:inherited-choices}Base", fields: BaseFields };
export const BaseSchema = z.lazy(() => BaseObjectSchema).register(xmlRegistry, BaseMeta);
const NodeFields: { [key: string]: XmlFieldMeta } = { ...BaseFields, "choice2": { kind: "choice", qname: "{urn:usability:inherited-choices}ChildRef", choice: { branches: [{ tag: "ChildRef", qname: "{urn:usability:inherited-choices}ChildRef" }, { tag: "ParentRef", qname: "{urn:usability:inherited-choices}ParentRef" }], minOccurs: 0, maxOccurs: "unbounded" } } };
const NodeMeta: XmlMeta = { qname: "{urn:usability:inherited-choices}Node", fields: NodeFields };
export const NodeSchema = z.lazy(() => NodeObjectSchema).register(xmlRegistry, NodeMeta);
const GroupMeta: XmlMeta = { qname: "{urn:usability:inherited-choices}Group", fields: { ...NodeFields, "choice3": { kind: "choice", qname: "{urn:usability:inherited-choices}ItemRef", choice: { branches: [{ tag: "ItemRef", qname: "{urn:usability:inherited-choices}ItemRef" }, { tag: "GroupRef", qname: "{urn:usability:inherited-choices}GroupRef" }], minOccurs: 0, maxOccurs: "unbounded" } } } };
export const GroupSchema = z.lazy(() => GroupObjectSchema).register(xmlRegistry, GroupMeta);
const ItemMeta: XmlMeta = { qname: "{urn:usability:inherited-choices}Item", fields: { ...BaseFields, "Setting": { kind: "element", qname: "{urn:usability:inherited-choices}Setting" } } };
export const ItemSchema = z.lazy(() => ItemObjectSchema).register(xmlRegistry, ItemMeta);
export const CollectionSchema = z.lazy(() => CollectionTypeSchema).register(xmlRegistry, { root: "{urn:usability:inherited-choices}Collection", generatedBy, namespacePrefixes: {"urn:usability:inherited-choices":"t"} });
