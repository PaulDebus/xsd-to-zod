import { parseXml, serializeXml } from "xsd-to-zod";
import type { DataTemplate, DataType, Library, Property, Ref } from "../generated/iso-shaped.zod.js";
import { LibrarySchema } from "../generated/iso-shaped.zod.js";

const LIBRARY_GUID = "11111111-1111-1111-1111-111111111111";
const TEMPLATE_GUID = "22222222-2222-2222-2222-222222222222";
const PROPERTY_GUID = "33333333-3333-3333-3333-333333333333";

const ref = (guid: string): Ref => ({ guid });

const positiveNumber: DataType = {
  name: "REAL",
  choice: [{ MinExclusive: { value: "0" } }],
};

export const height: Property = {
  GUID: PROPERTY_GUID,
  dateOfCreation: "2026-08-02T00:00:00Z",
  Name: [{ _text: "height", language: "en" }],
  DataType: positiveNumber,
};

export const firstTemplate: DataTemplate = {
  GUID: TEMPLATE_GUID,
  dateOfCreation: "2026-08-02T00:00:00Z",
  Name: [{ _text: "first", language: "en" }],
  choice2: [{ HasPropertyRef: ref(PROPERTY_GUID) }],
};

export const library: Library = {
  GUID: LIBRARY_GUID,
  choice: [{ DataTemplate: firstTemplate }, { Property: height }],
};

export function renameTemplate(library: Library, name: string): Library {
  return {
    ...library,
    choice: library.choice.map((item) =>
      "DataTemplate" in item
        ? {
            DataTemplate: {
              ...item.DataTemplate,
              Name: [{ _text: name, language: "en" }],
            },
          }
        : item,
    ),
  };
}

export function addPropertyRef(template: DataTemplate, guid: string): DataTemplate {
  return {
    ...template,
    choice2: [...(template.choice2 ?? []), { HasPropertyRef: ref(guid) }],
  };
}

export function roundTrip(library: Library): string {
  const xml = serializeXml(LibrarySchema, library);
  const parsed = parseXml(LibrarySchema, xml);
  return parsed.GUID;
}
