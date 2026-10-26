import { describe, expect, it } from "vitest";
import { CORPUS_SHARDS, corpusAvailable, corpusTestSets } from "../w3cCorpus.js";

describe("W3C corpus shard partition", () => {
  if (!corpusAvailable()) {
    it("skip — W3C submodule not checked out", () => {});
    return;
  }

  it("assigns every corpus test set to exactly one shard", () => {
    const problems = corpusTestSets().flatMap((file) => {
      const labels = CORPUS_SHARDS.filter((shard) =>
        shard.markers.some((marker) => file.includes(marker)),
      ).map((shard) => shard.label);
      if (labels.length === 1) {
        return [];
      }
      return [
        `${file}: ${labels.length === 0 ? "matches no shard" : `matches ${labels.join(", ")}`}`,
      ];
    });
    expect(problems).toEqual([]);
  });
});
