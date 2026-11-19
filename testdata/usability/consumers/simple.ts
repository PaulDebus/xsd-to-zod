import { parseXml, serializeXml } from "xsd-to-zod";
import type { Contact } from "../generated/simple.zod.js";
import { contactSchema } from "../generated/simple.zod.js";

export function buildContact(): Contact {
  return {
    id: 7,
    name: "Ada",
    tag: ["engineer", "mathematician"],
  };
}

export function readEmail(contact: Contact): string | undefined {
  return contact.email;
}

export function roundTrip(contact: Contact): string {
  const xml = serializeXml(contactSchema, contact);
  const parsed = parseXml(contactSchema, xml);
  if (parsed.name !== contact.name) {
    throw new Error("round-trip changed the contact name");
  }
  return xml;
}
