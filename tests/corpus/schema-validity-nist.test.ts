import { describe, it } from "vitest";
import { corpusAvailable, corpusSlice, registerCorpusSchemaValidityTests } from "../w3cCorpus.js";

describe("W3C corpus invalid schemas (nist)", () => {
  if (!corpusAvailable()) {
    it("skip — W3C submodule not checked out", () => {});
    return;
  }
  registerCorpusSchemaValidityTests("nist", corpusSlice("nist"));
});
