import { describe, it } from "vitest";
import { corpusAvailable, negativeCorpusSlice, registerCorpusNegativeTests } from "../w3cCorpus.js";

describe("W3C corpus negative (ms)", () => {
  if (!corpusAvailable()) {
    it("skip — W3C submodule not checked out", () => {});
    return;
  }
  registerCorpusNegativeTests("ms", negativeCorpusSlice("ms"));
});
