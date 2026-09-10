import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRuntime } from "../src/deps.ts";
import { configPath } from "../src/config.ts";

test("makeRuntime resolves mode2 and project id when no blackhole", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-deps-"));
  mkdirSync(join(dir, "repo"), { recursive: true });
  mkdirSync(join(dir, "repo", ".git"));
  try {
    const rt = await makeRuntime(dir, join(dir, "repo"), {}, {
      readConfig: () => ({ qdrantUrl: "http://localhost:6333", qdrantApiKey: null, embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text", embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10, mode: "auto", codeKnowledge: "off", codeScoreThreshold: 0.4 }),
      writeConfig: () => {},
      print: () => {},
      qdrant: {
        async ensureCollection() { return "exists"; },
        async upsert() {}, async search() { return []; }, async count() { return 0; }, async clearCollection() {},
      },
    });
    assert.ok(rt.projectId.startsWith("pi-mem-"));
    assert.equal(rt.cfg.qdrantUrl, "http://localhost:6333");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("configPath helper used by makeRuntime", () => {
  assert.match(configPath("/a"), /pi-qdrant-memory\/pi-qdrant-memory-config\.json$/);
});
