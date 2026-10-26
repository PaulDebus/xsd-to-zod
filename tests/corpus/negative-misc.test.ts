import { describe, it } from "vitest";
import { corpusAvailable, negativeCorpusSlice, registerCorpusNegativeTests } from "../w3cCorpus.js";

describe("W3C corpus negative (boeing/common/wg)", () => {
  if (!corpusAvailable()) {
    it("skip — W3C submodule not checked out", () => {});
    return;
  }
  registerCorpusNegativeTests("misc", negativeCorpusSlice("misc"));
});
