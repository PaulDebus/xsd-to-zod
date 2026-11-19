import { parseXml, serializeXml } from "xsd-to-zod";
import type { Collection, Group, Item, Link, Setting } from "../generated/inherited-choices.zod.js";
import { CollectionSchema } from "../generated/inherited-choices.zod.js";

const COLLECTION_ID = "collection-1";
const GROUP_ID = "group-1";
const ITEM_ID = "item-1";

const link = (target: string): Link => ({ target });

const numeric: Setting = {
  kind: "NUMERIC",
  choice: [{ Min: { value: "0" } }],
};

export const item: Item = {
  id: ITEM_ID,
  createdAt: "2026-08-02T00:00:00Z",
  Label: [{ _text: "height", lang: "en" }],
  Setting: numeric,
};

export const firstGroup: Group = {
  id: GROUP_ID,
  createdAt: "2026-08-02T00:00:00Z",
  Label: [{ _text: "first", lang: "en" }],
  choice2: [{ ItemRef: link(ITEM_ID) }],
};

export const collection: Collection = {
  id: COLLECTION_ID,
  choice: [{ Group: firstGroup }, { Item: item }],
};

export function renameGroup(collection: Collection, name: string): Collection {
  return {
    ...collection,
    choice: collection.choice.map((entry) =>
      "Group" in entry
        ? {
            Group: {
              ...entry.Group,
              Label: [{ _text: name, lang: "en" }],
            },
          }
        : entry,
    ),
  };
}

export function addItemRef(group: Group, target: string): Group {
  return {
    ...group,
    choice2: [...(group.choice2 ?? []), { ItemRef: link(target) }],
  };
}

export function roundTrip(collection: Collection): string {
  const xml = serializeXml(CollectionSchema, collection);
  const parsed = parseXml(CollectionSchema, xml);
  return parsed.id;
}
