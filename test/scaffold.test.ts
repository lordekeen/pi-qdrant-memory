import test from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../src/types.ts";

test("node type-stripping runs TS and type-only imports work", () => {
  const cfg: Config = {
    qdrantUrl: "http://localhost:6333",
    qdrantApiKey: null,
    embeddingBaseURL: "http://localhost:8080/v1",
    embeddingModel: "nomic-embed-text",
    embeddingApiKey: null,
    expectedDimension: 768,
    scoreThreshold: 0.18,
    maxResults: 10,
    mode: "auto",
  };
  assert.equal(cfg.expectedDimension, 768);
});
