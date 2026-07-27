import { describe, it } from "vitest";
import { corpusAvailable, corpusTestSets, registerCorpusTests } from "../w3cCorpus.js";

describe("W3C corpus round-trip (boeing/common/wg)", () => {
  if (!corpusAvailable()) {
    it("skip — W3C submodule not checked out", () => {});
    return;
  }
  registerCorpusTests(
    "misc",
    corpusTestSets().filter(
      (f) => f.includes("boeingMeta") || f.includes("common") || f.includes("wgMeta"),
    ),
  );
});
