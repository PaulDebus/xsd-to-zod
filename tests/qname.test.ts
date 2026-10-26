import { describe, expect, it } from "vitest";
import {
  clarkToLocal,
  splitClark,
  splitQName,
  syntheticChildName,
  toClark,
  trySplitClark,
} from "../src/qname.js";

describe("QName helpers", () => {
  it("splits prefixed and unprefixed names", () => {
    expect(splitQName("t:Thing")).toEqual({ prefix: "t", local: "Thing" });
    expect(splitQName("Thing")).toEqual({ prefix: "", local: "Thing" });
  });

  it("builds Clark notation with and without a namespace", () => {
    expect(toClark("urn:types", "Thing")).toBe("{urn:types}Thing");
    expect(toClark(undefined, "Thing")).toBe("{}Thing");
  });

  it("splits Clark notation leniently, falling back on malformed input", () => {
    expect(splitClark("{urn:types}Thing")).toEqual({ namespace: "urn:types", local: "Thing" });
    expect(splitClark("Thing")).toEqual({ namespace: "", local: "Thing" });
    expect(splitClark("{unterminated")).toEqual({ namespace: "", local: "{unterminated" });
  });

  it("returns undefined from the strict split for non-Clark input", () => {
    expect(trySplitClark("{urn:types}Thing")).toEqual({ ns: "urn:types", local: "Thing" });
    expect(trySplitClark("Thing")).toBeUndefined();
    expect(trySplitClark("{unterminated")).toBeUndefined();
  });

  it("reads the local part and derives synthetic child names", () => {
    expect(clarkToLocal("{urn:types}Thing")).toBe("Thing");
    expect(syntheticChildName("{urn:types}Thing", "_item")).toBe("{urn:types}Thing_item");
  });
});
