import type { XmlChoiceMeta } from "./xmlMeta.js";

// Presence, not just definedness: the walker materializes an absent repeated
// field as [], and [] is zero occurrences — absent.
const has = (value: unknown): boolean =>
  value !== undefined && !(Array.isArray(value) && value.length === 0);

// Ids of the choice groups nested directly under a group (or one branch of it).
const childGroupIds = (
  choices: Record<string, XmlChoiceMeta>,
  groupId: string,
  branchId?: string,
): string[] =>
  Object.entries(choices)
    .filter(
      ([, group]) =>
        group.guard !== undefined &&
        group.guard.group === groupId &&
        (branchId === undefined || group.guard.branch === branchId),
    )
    .map(([id]) => id);

// Every result key a group's whole subtree occupies, recursively through
// nested groups (guard ids grow along the nesting chain, so this bottoms out).
const subtreeKeys = (choices: Record<string, XmlChoiceMeta>, id: string): Set<string> => {
  const keys = new Set<string>();
  const group = choices[id];
  if (group === undefined) {
    return keys;
  }
  for (const branch of group.branches) {
    for (const entry of branch.keys) {
      keys.add(entry.key);
    }
  }
  for (const childId of childGroupIds(choices, id)) {
    for (const key of subtreeKeys(choices, childId)) {
      keys.add(key);
    }
  }
  return keys;
};

type GroupEval = {
  /** The group's cardinality check holds and no partial branch shows up. */
  ok: boolean;
  /** Any key of the whole subtree is present (gates enclosing branches). */
  any: boolean;
};

const evalGroup = (
  choices: Record<string, XmlChoiceMeta>,
  id: string,
  value: Record<string, unknown>,
): GroupEval => {
  const group = choices[id];
  if (group === undefined) {
    return { ok: true, any: false };
  }
  // A choice with a wildcard branch is always satisfiable through it: wildcard
  // content lands in the open shape, invisible to the key presence checks.
  if (group.wildcard === true) {
    return { ok: true, any: [...subtreeKeys(choices, id)].some((key) => has(value[key])) };
  }
  if (group.repeated && !group.required) {
    return { ok: true, any: false };
  }

  const oks: boolean[] = [];
  const partials: boolean[] = [];
  const sels: boolean[] = [];
  const keySets: Set<string>[] = [];
  for (const branch of group.branches) {
    const childIds = childGroupIds(choices, id, branch.id);
    const children = childIds.map((childId) => evalGroup(choices, childId, value));
    const sel = branch.keys.some((entry) => has(value[entry.key])) || children.some((c) => c.any);
    const requiredKeys = branch.keys.filter((entry) => entry.required);
    const directOk =
      requiredKeys.length === 1 && branch.keys.length === 1
        ? has(value[branch.keys[0]?.key ?? ""])
        : requiredKeys.length > 0
          ? requiredKeys.every((entry) => has(value[entry.key]))
          : branch.keys.length > 0
            ? branch.keys.some((entry) => has(value[entry.key]))
            : true;
    // A branch is complete when its own fields check out and every nested
    // choice hanging off it is satisfied. A field-less branch must show up at
    // all: an absent optional nested choice must not complete its branch.
    const ok = (branch.keys.length === 0 ? sel : true) && directOk && children.every((c) => c.ok);
    // Partial presence — the branch shows up but is incomplete — is rejected.
    const tracked =
      (requiredKeys.length > 0 && branch.keys.length > 1) ||
      childIds.some((childId) => {
        const child = choices[childId];
        return (
          child !== undefined && child.wildcard !== true && !(child.repeated && !child.required)
        );
      });
    if (tracked) {
      partials.push(!ok && sel);
    }
    oks.push(ok);
    sels.push(sel);
    keySets.push(new Set(branch.keys.map((entry) => entry.key)));
  }

  // Overlapping branches: when a complete branch's key set covers a smaller
  // complete branch's, the smaller match is fully explained by the larger one
  // and is not counted separately.
  const counted = oks.map((ok, j) => {
    const keysJ = keySets[j] ?? new Set<string>();
    return (
      ok &&
      !oks.some((okI, i) => {
        const keysI = keySets[i] ?? new Set<string>();
        return (
          okI &&
          i !== j &&
          keysJ.size > 0 &&
          keysJ.size <= keysI.size &&
          (keysJ.size < keysI.size || i < j) &&
          [...keysJ].every((key) => keysI.has(key))
        );
      })
    );
  });

  const count = counted.filter(Boolean).length;
  const countOk = group.repeated ? count > 0 : group.required ? count === 1 : count <= 1;
  return { ok: countOk && !partials.some(Boolean), any: sels.some(Boolean) };
};

/**
 * Messages of the enforced choice groups `value` violates. Pure — driven by
 * the precomputed registry meta (see choicesMetaFor in irToZod).
 */
export const choiceGroupIssues = (
  choices: Record<string, XmlChoiceMeta>,
  value: Record<string, unknown>,
): string[] => {
  const issues: string[] = [];
  for (const [id, group] of Object.entries(choices)) {
    if (group.enforce !== true) {
      continue;
    }
    const guard = group.guard;
    if (guard !== undefined) {
      // A nested choice is enforced only when its enclosing branch is actually
      // selected: any key of that branch's subtree present.
      const enclosing = choices[guard.group];
      const branch = enclosing?.branches.find((b) => b.id === guard.branch);
      const gateKeys = new Set<string>((branch?.keys ?? []).map((entry) => entry.key));
      for (const childId of childGroupIds(choices, guard.group, guard.branch)) {
        for (const key of subtreeKeys(choices, childId)) {
          gateKeys.add(key);
        }
      }
      if (![...gateKeys].some((key) => has(value[key]))) {
        continue;
      }
    }
    if (!evalGroup(choices, id, value).ok) {
      issues.push(group.message);
    }
  }
  return issues;
};
