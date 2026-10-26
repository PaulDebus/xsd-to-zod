import { describe, expect, it } from "vitest";
import { corpusAvailable, corpusTestSets, NEGATIVE_CORPUS_SHARDS } from "../w3cCorpus.js";

describe("W3C corpus negative shard partition", () => {
  if (!corpusAvailable()) {
    it("skip — W3C submodule not checked out", () => {});
    return;
  }

  it("assigns every corpus test set to exactly one negative shard", () => {
    const problems = corpusTestSets().flatMap((file) => {
      const labels = NEGATIVE_CORPUS_SHARDS.filter((shard) =>
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
