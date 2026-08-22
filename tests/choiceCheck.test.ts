import { describe, expect, it } from "vitest";
import { choiceGroupIssues } from "../src/choiceCheck.js";
import type { XmlChoiceMeta } from "../src/xmlMeta.js";

const group = (
  partial: Partial<XmlChoiceMeta> & Pick<XmlChoiceMeta, "branches">,
): XmlChoiceMeta => ({
  required: true,
  repeated: false,
  message: "choice requires exactly one of: card, iban",
  enforce: true,
  ...partial,
});

describe("choiceGroupIssues", () => {
  const exactlyOne = {
    "0": group({
      branches: [
        { id: "0.0", keys: [{ key: "card", required: true }] },
        { id: "0.1", keys: [{ key: "iban", required: true }] },
      ],
    }),
  };

  it("exactly one: one branch present passes, neither and both fail", () => {
    expect(choiceGroupIssues(exactlyOne, { card: "c" })).toEqual([]);
    expect(choiceGroupIssues(exactlyOne, {})).toEqual([
      "choice requires exactly one of: card, iban",
    ]);
    expect(choiceGroupIssues(exactlyOne, { card: "c", iban: "i" })).toEqual([
      "choice requires exactly one of: card, iban",
    ]);
  });

  it("at most one: neither passes, both fail", () => {
    const atMostOne = {
      "0": group({
        required: false,
        message: "choice allows at most one of: card, iban",
        branches: [
          { id: "0.0", keys: [{ key: "card", required: false }] },
          { id: "0.1", keys: [{ key: "iban", required: false }] },
        ],
      }),
    };
    expect(choiceGroupIssues(atMostOne, {})).toEqual([]);
    expect(choiceGroupIssues(atMostOne, { card: "c" })).toEqual([]);
    expect(choiceGroupIssues(atMostOne, { card: "c", iban: "i" })).toEqual([
      "choice allows at most one of: card, iban",
    ]);
  });

  it("repeated required: [] means absent, at least one occurrence required", () => {
    const repeated = {
      "0": group({
        repeated: true,
        message: "choice requires at least one of: tag, code",
        branches: [
          { id: "0.0", keys: [{ key: "tag", required: true }] },
          { id: "0.1", keys: [{ key: "code", required: true }] },
        ],
      }),
    };
    expect(choiceGroupIssues(repeated, { tag: [] })).toEqual([
      "choice requires at least one of: tag, code",
    ]);
    expect(choiceGroupIssues(repeated, { tag: ["a"], code: undefined })).toEqual([]);
    // A selected single-occurrence branch still counts exactly once.
    expect(choiceGroupIssues(repeated, { tag: [], code: "c" })).toEqual([]);
  });

  it("repeated-optional and wildcard groups are not enforced", () => {
    const relaxed = {
      "0": group({
        required: false,
        repeated: true,
        branches: [
          { id: "0.0", keys: [{ key: "a", required: false }] },
          { id: "0.1", keys: [{ key: "b", required: false }] },
        ],
      }),
      "1": group({
        wildcard: true,
        branches: [
          { id: "1.0", keys: [{ key: "c", required: false }] },
          { id: "1.1", keys: [] },
        ],
      }),
    };
    // Non-enforced groups never produce issues, whatever the value holds.
    const unenforced: Record<string, XmlChoiceMeta> = Object.fromEntries(
      Object.entries(relaxed).map(([id, g]) => {
        const { enforce: _enforce, ...rest } = g;
        return [id, rest];
      }),
    );
    expect(choiceGroupIssues(unenforced, {})).toEqual([]);
    expect(choiceGroupIssues(unenforced, { a: ["x"], b: ["y"] })).toEqual([]);
  });

  it("rejects a partial branch: shows up but required keys are missing", () => {
    const partial = {
      "0": group({
        branches: [
          {
            id: "0.0",
            keys: [
              { key: "name", required: true },
              { key: "addr", required: true },
            ],
          },
          { id: "0.1", keys: [{ key: "ref", required: true }] },
        ],
      }),
    };
    expect(choiceGroupIssues(partial, { name: "n", addr: "a" })).toEqual([]);
    expect(choiceGroupIssues(partial, { ref: "r" })).toEqual([]);
    expect(choiceGroupIssues(partial, { name: "n" })).toEqual([
      "choice requires exactly one of: card, iban",
    ]);
  });

  it("nested choice: enforced only when its enclosing branch is selected", () => {
    const nested: Record<string, XmlChoiceMeta> = {
      "0": group({
        branches: [
          { id: "0.0", keys: [{ key: "plain", required: true }] },
          { id: "0.1", keys: [] },
        ],
      }),
      "1": group({
        guard: { group: "0", branch: "0.1" },
        branches: [
          { id: "1.0", keys: [{ key: "x", required: true }] },
          { id: "1.1", keys: [{ key: "y", required: true }] },
        ],
      }),
    };
    // Outer branch 0.0 selected: the nested choice is not reachable.
    expect(choiceGroupIssues(nested, { plain: "p" })).toEqual([]);
    // Enclosing branch selected through the nested group's own presence: the
    // inner choice must be satisfied.
    expect(choiceGroupIssues(nested, { x: "1" })).toEqual([]);
    // Both inner branches selected: the inner group fails — and with it the
    // field-less outer branch it hangs off, so the outer group fails too
    // (both groups carry the same fixture message here).
    expect(choiceGroupIssues(nested, { x: "1", y: "2" })).toEqual([
      "choice requires exactly one of: card, iban",
      "choice requires exactly one of: card, iban",
    ]);
  });

  it("overlapping branches: a covering branch fully explains the smaller one", () => {
    const overlapping = {
      "0": group({
        branches: [
          { id: "0.0", keys: [{ key: "a", required: true }] },
          {
            id: "0.1",
            keys: [
              { key: "a", required: true },
              { key: "b", required: true },
            ],
          },
        ],
      }),
    };
    // {a} alone is a partial match of the {a,b} branch: rejected.
    expect(choiceGroupIssues(overlapping, { a: "1" })).toEqual([
      "choice requires exactly one of: card, iban",
    ]);
    // Without absorber dedup both branches would count and exactly-one would fail.
    expect(choiceGroupIssues(overlapping, { a: "1", b: "2" })).toEqual([]);
    expect(choiceGroupIssues(overlapping, { b: "2" })).toEqual([
      "choice requires exactly one of: card, iban",
    ]);
  });
});
