import { describe, it } from "vitest";
import { corpusAvailable, corpusTestSets, registerCorpusNegativeTests } from "../w3cCorpus.js";

describe("W3C corpus negative (boeing/common/wg)", () => {
  if (!corpusAvailable()) {
    it("skip — W3C submodule not checked out", () => {});
    return;
  }
  registerCorpusNegativeTests(
    "misc",
    corpusTestSets().filter(
      (f) => f.includes("boeingMeta") || f.includes("common") || f.includes("wgMeta"),
    ),
  );
});
