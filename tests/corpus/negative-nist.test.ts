import { describe, it } from "vitest";
import { corpusAvailable, corpusTestSets, registerCorpusNegativeTests } from "../w3cCorpus.js";

describe("W3C corpus negative (nist)", () => {
  if (!corpusAvailable()) {
    it("skip — W3C submodule not checked out", () => {});
    return;
  }
  registerCorpusNegativeTests(
    "nist",
    corpusTestSets().filter((f) => f.includes("nistMeta")),
  );
});
