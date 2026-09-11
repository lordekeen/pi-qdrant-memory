import test from "node:test";
import assert from "node:assert/strict";
import { rememberLogic, memorySearchLogic } from "../src/tools-core.ts";
import { pointId } from "../src/ids.ts";
import type { QdrantLike, QdrantPoint } from "../src/qdrant.ts";
import type { MemoryType, PointPayload, RuntimeDeps, SearchHit } from "../src/types.ts";

function deps(over: Partial<RuntimeDeps> = {}): RuntimeDeps & { q: { upserted: QdrantPoint[][] }; embeds: string[] } {
  const upserted: QdrantPoint[][] = [];
  const embeds: string[] = [];
  const q: QdrantLike & { upserted: QdrantPoint[][] } = {
    upserted, // exposed so tests can assert d.q.upserted (methods push into the same array)
    async ensureCollection(_n, _d) { return "exists"; },
    async upsert(_n, points) { upserted.push(points); },
    async search(): Promise<SearchHit[]> { return []; },
    async count() { return 0; },
    async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
  };
  return {
    cfg: {
      qdrantUrl: "http://localhost:6333", qdrantApiKey: null,
      embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text",
      embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10, mode: "auto",
    },
    agentDir: "/tmp/agent", cwd: "/repo",
    embed: async (t: string) => { embeds.push(t); return new Array(768).fill(0.1); },
    qdrant: q,
    q,
    embeds,
    ...over,
  } as RuntimeDeps & { q: { upserted: QdrantPoint[][] }; embeds: string[] };
}

test("rememberLogic upserts a deterministic point", async () => {
  const d = deps();
  const res = await rememberLogic(d, "always use REST for sync");
  assert.ok(res.ok);
  assert.equal(d.q.upserted.length, 1);
  const pts = d.q.upserted[0];
  assert.equal(pts[0].id, pointId("always use REST for sync", "remember_tool", ""));
  assert.equal(pts[0].payload.type, "decision");
  assert.equal(pts[0].payload.source_kind, "remember_tool");
});

test("rememberLogic respects explicit type", async () => {
  const d = deps();
  const res = await rememberLogic(d, "prefer tabs", "preference");
  assert.ok(res.ok);
  assert.equal(d.q.upserted[0][0].payload.type, "preference");
});

test("rememberLogic rejects empty text with a bare reason", async () => {
  const d = deps();
  const res = await rememberLogic(d, "   ");
  assert.ok(!res.ok);
  // tools-core returns bare reason text — no tool name, no `failed:` prefix.
  assert.equal((res as { error: string }).error, "text is empty");
});

test("rememberLogic rejects over-long text with a bare reason", async () => {
  const d = deps();
  const res = await rememberLogic(d, "x".repeat(4001));
  assert.ok(!res.ok);
  assert.equal((res as { error: string }).error, "text too long (>4000 chars)");
});

test("rememberLogic returns a bare error reason (no throw) when embed fails", async () => {
  const d = deps({ embed: async () => { throw new Error("down"); } });
  const res = await rememberLogic(d, "x");
  assert.ok(!res.ok);
  // Just the underlying error text — the caller composes the final message.
  assert.equal((res as { error: string }).error, "Error: down");
});

test("memorySearchLogic rejects an empty query with a bare reason", async () => {
  const res = await memorySearchLogic(deps(), "   ");
  assert.ok(!res.ok);
  assert.equal((res as { error: string }).error, "query is empty");
});

test("memorySearchLogic returns a bare error reason when the search fails", async () => {
  const q: QdrantLike = {
    async ensureCollection() { return "exists"; },
    async upsert() {},
    async search() { throw new Error("connection refused"); },
    async count() { return 0; },
    async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
  };
  const res = await memorySearchLogic(deps({ qdrant: q }), "q");
  assert.ok(!res.ok);
  assert.equal((res as { error: string }).error, "Error: connection refused");
});

test("memorySearchLogic embeds query and searches with type filter and capped limit", async () => {
  const searched: Array<{ type?: string; limit: number; threshold: number }> = [];
  const payload: PointPayload = { type: "decision", text: "use REST", project_id: "pi-mem-p", ts: 1, source_kind: "blackhole_reflection", source_entry_id: "id1" };
  const q: QdrantLike = {
    async ensureCollection() { return "exists"; },
    async upsert() {},
    async search(_n, _v, opts) { searched.push({ type: opts.type, limit: opts.limit, threshold: opts.threshold }); return [{ id: "a", score: 0.5, payload }]; },
    async count() { return 0; },
    async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
  };
  const d = deps({ qdrant: q });
  const res = await memorySearchLogic(d, "what did we decide about transport", "decision", 3);
  assert.ok(res.ok);
  assert.equal(searched[0].type, "decision");
  assert.equal(searched[0].limit, 3);
  assert.equal(searched[0].threshold, 0.18);
});

test("memorySearchLogic caps limit at maxResults", async () => {
  let sawLimit = 0;
  const q: QdrantLike = {
    async ensureCollection() { return "exists"; },
    async upsert() {},
    async search(_n, _v, opts) { sawLimit = opts.limit; return []; },
    async count() { return 0; },
    async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
  };
  const d = deps({ qdrant: q });
  await memorySearchLogic(d, "q", undefined, 1000);
  assert.equal(sawLimit, 10); // cfg.maxResults
});

test("memory_search uses codeScoreThreshold for code queries, scoreThreshold otherwise", async () => {
  const seen: Array<{ threshold: number; type?: MemoryType }> = [];
  const d = deps({
    cfg: {
      qdrantUrl: "http://localhost:6333", qdrantApiKey: null,
      embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text",
      embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10,
      mode: "auto", codeKnowledge: "on", codeScoreThreshold: 0.4,
    },
    qdrant: {
      async ensureCollection() { return "exists" as const; },
      async upsert() {},
      async search(_n: string, _v: number[], opts: { threshold: number; type?: MemoryType }) {
        seen.push({ threshold: opts.threshold, type: opts.type });
        return [];
      },
      async count() { return 0; },
      async clearCollection() {},
      async deletePointsByFiles() {},
      async codeIndexSnapshot() { return new Map<string, string>(); },
    } as unknown as RuntimeDeps["qdrant"],
  });
  await memorySearchLogic(d, "why is auth like this");
  await memorySearchLogic(d, "how does auth work", "code");
  assert.equal(seen[0]!.threshold, 0.18);
  assert.equal(seen[1]!.threshold, 0.4);
  assert.equal(seen[1]!.type, "code");
});
