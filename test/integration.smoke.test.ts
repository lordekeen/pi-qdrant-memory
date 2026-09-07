import test from "node:test";
import assert from "node:assert/strict";
import { QdrantClient } from "../src/qdrant.ts";
import { EmbeddingClient } from "../src/embeddings.ts";
import { rememberLogic, memorySearchLogic } from "../src/tools-core.ts";
import type { RuntimeDeps } from "../src/types.ts";

const smoke = process.env.QDRANT_MEMORY_SMOKE === "1";
const o = { skip: !smoke } as const;

// Server endpoints are overridable so the smoke test can target whatever real
// servers are running locally (defaults match the shipped config defaults).
const QDRANT_URL = process.env.QDRANT_MEMORY_URL ?? "http://localhost:6333";
const EMBED_URL = process.env.QDRANT_MEMORY_EMBED_URL ?? "http://localhost:8080/v1";
const EMBED_MODEL = process.env.QDRANT_MEMORY_EMBED_MODEL ?? "nomic-embed-text";
const EMBED_DIM = Number(process.env.QDRANT_MEMORY_EMBED_DIM ?? 768);

test("end-to-end remember then search against real servers", o, async () => {
  const qdrant = new QdrantClient(QDRANT_URL, null);
  const embedder = new EmbeddingClient(EMBED_URL, EMBED_MODEL, null, EMBED_DIM);
  const projectId = `pi-mem-smoke-${Date.now().toString(36)}`;
  const rt: RuntimeDeps = {
    cfg: {
      qdrantUrl: QDRANT_URL, qdrantApiKey: null,
      embeddingBaseURL: EMBED_URL, embeddingModel: EMBED_MODEL,
      embeddingApiKey: null, expectedDimension: EMBED_DIM, scoreThreshold: 0.15, maxResults: 5, mode: "own",
    },
    agentDir: "/tmp/agent", cwd: "/repo", projectId,
    embed: (t) => embedder.embed(t),
    qdrant, readConfig: () => rt.cfg, writeConfig: () => {}, print: () => {},
  };
  try {
    const saved = await rememberLogic(rt, "we decided the sync layer uses REST over gRPC", "decision");
    assert.ok(saved.ok);
    const found = await memorySearchLogic(rt, "what transport did we choose for sync?");
    assert.ok(found.ok);
    assert.ok(found.value.length >= 1, "expected at least one hit");
  } finally {
    await qdrant.clearCollection(projectId).catch(() => {});
  }
});
