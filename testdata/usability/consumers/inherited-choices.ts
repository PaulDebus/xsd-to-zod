import { parseXml, serializeXml } from "xsd-to-zod";
import type {
  Base,
  Collection,
  Group,
  Item,
  Label,
  Setting,
} from "../generated/inherited-choices.zod.js";
import { CollectionSchema } from "../generated/inherited-choices.zod.js";

export interface LabelModel {
  text: string;
  language: string;
}

export interface LimitModel {
  min?: string;
  max?: string;
  pattern?: string;
}

export interface NodeModel {
  id: string;
  createdAt: string;
  about?: string;
  labels: LabelModel[];
  title?: LabelModel;
  notes: string[];
  version?: number;
}

export interface GroupModel extends NodeModel {
  childRefs: string[];
  parentRef?: string;
  itemRefs: string[];
  groupRef?: string;
}

export interface ItemModel extends NodeModel {
  limits: LimitModel;
  kind?: Setting["kind"];
}

export type CollectionEntry =
  | { kind: "label"; index: number }
  | { kind: "group"; index: number }
  | { kind: "item"; index: number };

export interface CollectionModel {
  id: string;
  labels: LabelModel[];
  groups: GroupModel[];
  items: ItemModel[];
  order: CollectionEntry[];
}

const toLabelModel = (label: Label): LabelModel => ({
  text: label._text,
  language: label.lang,
});

const fromLabelModel = (label: LabelModel): Label => ({
  _text: label.text,
  lang: label.language,
});

const readBase = (node: Base): NodeModel => {
  const model: NodeModel = {
    id: node.id,
    createdAt: node.createdAt,
    labels: [],
    notes: [],
  };
  if (node.about !== undefined) {
    model.about = node.about;
  }
  for (const branch of node.choice ?? []) {
    if ("Label" in branch) {
      model.labels.push(toLabelModel(branch.Label));
    } else if ("Title" in branch) {
      model.title = toLabelModel(branch.Title);
    } else if ("Note" in branch) {
      model.notes.push(branch.Note);
    } else {
      model.version = branch.Version;
    }
  }
  return model;
};

const writeBase = (model: NodeModel): Pick<Base, "id" | "createdAt" | "about" | "choice"> => {
  const choice: NonNullable<Base["choice"]> = model.labels.map((label) => ({
    Label: fromLabelModel(label),
  }));
  if (model.title !== undefined) {
    choice.push({ Title: fromLabelModel(model.title) });
  }
  for (const note of model.notes) {
    choice.push({ Note: note });
  }
  if (model.version !== undefined) {
    choice.push({ Version: model.version });
  }
  const base: Pick<Base, "id" | "createdAt" | "about" | "choice"> = {
    id: model.id,
    createdAt: model.createdAt,
  };
  if (model.about !== undefined) {
    base.about = model.about;
  }
  if (choice.length > 0) {
    base.choice = choice;
  }
  return base;
};

export const toGroupModel = (group: Group): GroupModel => {
  const model: GroupModel = {
    ...readBase(group),
    childRefs: [],
    itemRefs: [],
  };
  for (const branch of group.choice2 ?? []) {
    if ("ChildRef" in branch) {
      if (branch.ChildRef.target !== undefined) {
        model.childRefs.push(branch.ChildRef.target);
      }
    } else if (branch.ParentRef.target !== undefined) {
      model.parentRef = branch.ParentRef.target;
    }
  }
  for (const branch of group.choice3 ?? []) {
    if ("ItemRef" in branch) {
      if (branch.ItemRef.target !== undefined) {
        model.itemRefs.push(branch.ItemRef.target);
      }
    } else if (branch.GroupRef.target !== undefined) {
      model.groupRef = branch.GroupRef.target;
    }
  }
  return model;
};

export const fromGroupModel = (model: GroupModel): Group => {
  const group: Group = { ...writeBase(model) };
  const references: NonNullable<Group["choice2"]> = model.childRefs.map((target) => ({
    ChildRef: { target },
  }));
  if (model.parentRef !== undefined) {
    references.push({ ParentRef: { target: model.parentRef } });
  }
  if (references.length > 0) {
    group.choice2 = references;
  }
  const itemReferences: NonNullable<Group["choice3"]> = model.itemRefs.map((target) => ({
    ItemRef: { target },
  }));
  if (model.groupRef !== undefined) {
    itemReferences.push({ GroupRef: { target: model.groupRef } });
  }
  if (itemReferences.length > 0) {
    group.choice3 = itemReferences;
  }
  return group;
};

const toLimitModel = (setting: Setting): LimitModel => {
  const limits: LimitModel = {};
  for (const branch of setting.choice ?? []) {
    if ("Min" in branch) {
      if (branch.Min.value !== undefined) {
        limits.min = branch.Min.value;
      }
    } else if ("Max" in branch) {
      if (branch.Max.value !== undefined) {
        limits.max = branch.Max.value;
      }
    } else if (branch.Pattern.value !== undefined) {
      limits.pattern = branch.Pattern.value;
    }
  }
  return limits;
};

const fromLimitModel = (limits: LimitModel): Setting => {
  const setting: Setting = {};
  const choice: NonNullable<Setting["choice"]> = [];
  if (limits.min !== undefined) {
    choice.push({ Min: { value: limits.min } });
  }
  if (limits.max !== undefined) {
    choice.push({ Max: { value: limits.max } });
  }
  if (limits.pattern !== undefined) {
    choice.push({ Pattern: { value: limits.pattern } });
  }
  if (choice.length > 0) {
    setting.choice = choice;
  }
  return setting;
};

export const toItemModel = (item: Item): ItemModel => {
  const model: ItemModel = {
    ...readBase(item),
    limits: toLimitModel(item.Setting),
  };
  if (item.Setting.kind !== undefined) {
    model.kind = item.Setting.kind;
  }
  return model;
};

export const fromItemModel = (model: ItemModel): Item => {
  const setting = fromLimitModel(model.limits);
  if (model.kind !== undefined) {
    setting.kind = model.kind;
  }
  return { ...writeBase(model), Setting: setting };
};

export const toCollectionModel = (collection: Collection): CollectionModel => {
  const model: CollectionModel = {
    id: collection.id,
    labels: [],
    groups: [],
    items: [],
    order: [],
  };
  for (const entry of collection.choice) {
    if ("Label" in entry) {
      model.order.push({ kind: "label", index: model.labels.length });
      model.labels.push(toLabelModel(entry.Label));
    } else if ("Group" in entry) {
      model.order.push({ kind: "group", index: model.groups.length });
      model.groups.push(toGroupModel(entry.Group));
    } else {
      model.order.push({ kind: "item", index: model.items.length });
      model.items.push(toItemModel(entry.Item));
    }
  }
  return model;
};

export const fromCollectionModel = (model: CollectionModel): Collection => {
  const choice = model.order.map((entry) => {
    if (entry.kind === "label") {
      const label = model.labels[entry.index];
      if (label === undefined) {
        throw new Error(`missing label at index ${entry.index}`);
      }
      return { Label: fromLabelModel(label) };
    }
    if (entry.kind === "group") {
      const group = model.groups[entry.index];
      if (group === undefined) {
        throw new Error(`missing group at index ${entry.index}`);
      }
      return { Group: fromGroupModel(group) };
    }
    const item = model.items[entry.index];
    if (item === undefined) {
      throw new Error(`missing item at index ${entry.index}`);
    }
    return { Item: fromItemModel(item) };
  });
  return { id: model.id, choice };
};

export const renameGroup = (model: CollectionModel, index: number, name: string): CollectionModel => {
  const group = model.groups[index];
  if (group === undefined) {
    throw new Error(`missing group at index ${index}`);
  }
  return {
    ...model,
    groups: model.groups.map((entry, entryIndex) =>
      entryIndex === index
        ? { ...entry, labels: [{ text: name, language: "en" }, ...entry.labels.slice(1)] }
        : entry,
    ),
  };
};

export const addItemRef = (model: CollectionModel, index: number, target: string): CollectionModel => {
  const group = model.groups[index];
  if (group === undefined) {
    throw new Error(`missing group at index ${index}`);
  }
  return {
    ...model,
    groups: model.groups.map((entry, entryIndex) =>
      entryIndex === index ? { ...entry, itemRefs: [...entry.itemRefs, target] } : entry,
    ),
  };
};

export const parseModel = (xml: string): CollectionModel =>
  toCollectionModel(parseXml(CollectionSchema, xml));

export const serializeModel = (model: CollectionModel): string =>
  serializeXml(CollectionSchema, fromCollectionModel(model));

const limit = (value: string): { value: string } => ({ value });

export const buildCollection = (): Collection => ({
  id: "collection-1",
  choice: [
    { Label: { _text: "Collection", lang: "en" } },
    {
      Group: {
        id: "group-1",
        createdAt: "2026-08-02T00:00:00Z",
        choice: [
          { Label: { _text: "first", lang: "en" } },
          { Note: "group note" },
        ],
        choice2: [{ ChildRef: { target: "item-1" } }],
        choice3: [{ ItemRef: { target: "item-1" } }],
      },
    },
    {
      Item: {
        id: "item-1",
        createdAt: "2026-08-02T00:00:00Z",
        choice: [{ Label: { _text: "height", lang: "en" } }],
        Setting: {
          kind: "NUMERIC",
          choice: [{ Min: limit("0") }, { Max: limit("10") }],
        },
      },
    },
  ],
});
