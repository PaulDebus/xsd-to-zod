import { describe, it } from "vitest";
import { corpusAvailable, corpusSlice, registerCorpusNegativeTests } from "../w3cCorpus.js";

describe("W3C corpus negative (nist)", () => {
  if (!corpusAvailable()) {
    it("skip — W3C submodule not checked out", () => {});
    return;
  }
  registerCorpusNegativeTests("nist", corpusSlice("nist"));
});
