import test from "node:test";
import assert from "node:assert/strict";
import { rememberLogic, memorySearchLogic, forgetLogic } from "../src/tools-core.ts";
import { pointId } from "../src/ids.ts";
import { DimensionMismatchError, type EnsureCollectionOptions, type QdrantLike, type QdrantPoint } from "../src/qdrant.ts";
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
    async countBySourceKind() { return 0; },
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

test("rememberLogic embeds before ensureCollection so a failed embed leaves collection untouched (OI-001)", async () => {
  let ensureCalled = false;
  const q: QdrantLike = {
    async ensureCollection() { ensureCalled = true; return "exists"; },
    async upsert() {},
    async search() { return []; },
    async count() { return 0; },
    async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
    async countBySourceKind() { return 0; },
  };
  const d = deps({
    qdrant: q,
    embed: async () => { throw new Error("embed down"); },
  });
  const res = await rememberLogic(d, "important fact");
  assert.ok(!res.ok);
  assert.equal(ensureCalled, false);
});

test("rememberLogic passes onDimensionMismatch: 'recreate' to ensureCollection (OI-001)", async () => {
  let passedOpts: EnsureCollectionOptions | undefined;
  const q: QdrantLike = {
    async ensureCollection(_n, _d, opts) { passedOpts = opts; return "recreated"; },
    async upsert() {},
    async search() { return []; },
    async count() { return 0; },
    async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
    async countBySourceKind() { return 0; },
  };
  const d = deps({ qdrant: q });
  const res = await rememberLogic(d, "recreate on write");
  assert.ok(res.ok);
  assert.deepEqual(passedOpts, { onDimensionMismatch: "recreate" });
});

test("memorySearchLogic returns error and leaves collection untouched on dimension mismatch (OI-001)", async () => {
  let passedOpts: EnsureCollectionOptions | undefined;
  const q: QdrantLike = {
    async ensureCollection(n, d, opts) {
      passedOpts = opts;
      throw new DimensionMismatchError(n, 384, d);
    },
    async upsert() {},
    async search() { return []; },
    async count() { return 0; },
    async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
    async countBySourceKind() { return 0; },
  };
  const d = deps({ qdrant: q });
  const res = await memorySearchLogic(d, "search query");
  assert.ok(!res.ok);
  assert.deepEqual(passedOpts, { onDimensionMismatch: "error" });
  assert.match((res as { error: string }).error, /collection .* dim 384 ≠ expectedDimension 768/);
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
    async countBySourceKind() { return 0; },
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
    async countBySourceKind() { return 0; },
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
    async countBySourceKind() { return 0; },
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
      memoryForget: "off",
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
      async countBySourceKind() { return 0; },
    } as unknown as RuntimeDeps["qdrant"],
  });
  await memorySearchLogic(d, "why is auth like this");
  await memorySearchLogic(d, "how does auth work", "code");
  assert.equal(seen[0]!.threshold, 0.18);
  assert.equal(seen[1]!.threshold, 0.4);
  assert.equal(seen[1]!.type, "code");
});

test("rememberLogic skips embed and upsert when point already exists (Shape C)", async () => {
  let embedCalls = 0;
  let ensureCalls = 0;
  let upsertCalls = 0;
  const targetId = pointId("already remembered fact", "remember_tool", "");

  const q: QdrantLike = {
    async ensureCollection() { ensureCalls++; return "exists"; },
    async upsert() { upsertCalls++; },
    async search() { return []; },
    async count() { return 1; },
    async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
    async countBySourceKind() { return 0; },
    async existingPointIds(_name, ids) {
      return new Set(ids.filter((id) => id === targetId));
    },
  };

  const d = deps({
    qdrant: q,
    embed: async () => {
      embedCalls++;
      return new Array(768).fill(0.1);
    },
  });

  const res = await rememberLogic(d, "already remembered fact", "fact");
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.skipped, true);
    assert.equal(res.value.text, "already remembered fact");
  }
  assert.equal(embedCalls, 0, "embed must not be called when point already exists");
  assert.equal(ensureCalls, 0, "ensureCollection must not be called when point already exists");
  assert.equal(upsertCalls, 0, "upsert must not be called when point already exists");
});

test("rememberLogic proceeds to embed and upsert when point does not exist (Shape C)", async () => {
  let embedCalls = 0;
  let upsertCalls = 0;

  const q: QdrantLike = {
    async ensureCollection() { return "exists"; },
    async upsert() { upsertCalls++; },
    async search() { return []; },
    async count() { return 0; },
    async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
    async countBySourceKind() { return 0; },
    async existingPointIds() { return new Set(); },
  };

  const d = deps({
    qdrant: q,
    embed: async () => {
      embedCalls++;
      return new Array(768).fill(0.1);
    },
  });

  const res = await rememberLogic(d, "brand new fact", "fact");
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.skipped, undefined);
    assert.equal(res.value.text, "brand new fact");
  }
  assert.equal(embedCalls, 1);
  assert.equal(upsertCalls, 1);
});

test("forgetLogic rejects empty text with bare reason", async () => {
  const d = deps();
  const res = await forgetLogic(d, "   ");
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, "text cannot be empty");
});

test("forgetLogic rejects over-long text with bare reason", async () => {
  const d = deps();
  const res = await forgetLogic(d, "x".repeat(4001));
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, "text exceeds 4000 characters");
});

test("forgetLogic rejects non-existing memory with bare reason", async () => {
  const q: QdrantLike = {
    async ensureCollection() { return "exists"; },
    async upsert() {},
    async search() { return []; },
    async count() { return 0; },
    async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
    async countBySourceKind() { return 0; },
    async existingPointIds() { return new Set(); },
  };
  const d = deps({ qdrant: q });
  const res = await forgetLogic(d, "fact not saved");
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, "no memory_save point with that exact text");
});

test("forgetLogic deletes existing point without calling embed or ensureCollection", async () => {
  let embedCalls = 0;
  let ensureCalls = 0;
  const deleted: string[] = [];
  const text = "we use Postgres";
  const id = pointId(text, "remember_tool", "");
  const q: QdrantLike = {
    async ensureCollection() { ensureCalls++; return "exists"; },
    async upsert() {},
    async search() { return []; },
    async count() { return 0; },
    async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
    async countBySourceKind() { return 0; },
    async existingPointIds() { return new Set([id]); },
    async deletePointsByIds(_n, ids) { deleted.push(...ids); return ids.length; },
  };
  const d = deps({
    qdrant: q,
    embed: async () => { embedCalls++; return []; },
  });
  const res = await forgetLogic(d, text);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.text, text);
    assert.equal(res.value.removed, 1);
  }
  assert.deepEqual(deleted, [id]);
  assert.equal(embedCalls, 0, "forgetLogic must never call embed");
  assert.equal(ensureCalls, 0, "forgetLogic must never call ensureCollection");
});

test("ensureCollection is memoized across multiple calls when collectionReady is provided (OI-010)", async () => {
  let ensureCalls = 0;
  const q: QdrantLike = {
    async ensureCollection() { ensureCalls++; return "exists"; },
    async upsert() {},
    async search() { return []; },
    async count() { return 0; },
    async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
    async countBySourceKind() { return 0; },
  };
  const collectionReady = new Set<string>();
  const d = deps({ qdrant: q, collectionReady });
  await rememberLogic(d, "fact 1");
  await rememberLogic(d, "fact 2");
  await memorySearchLogic(d, "query 1");
  await memorySearchLogic(d, "query 2");
  assert.equal(ensureCalls, 1, "ensureCollection should only be called once when memoized");
  assert.ok(collectionReady.has(d.projectId));
});

test("memorySearchLogic queries count and attaches totalCount when hits are empty (OI-018)", async () => {
  const q: QdrantLike = {
    async ensureCollection() { return "exists"; },
    async upsert() {},
    async search() { return []; },
    async count() { return 42; },
    async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
    async countBySourceKind() { return 10; },
  };
  const d = deps({ qdrant: q });
  const res = await memorySearchLogic(d, "find something");
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.length, 0);
    assert.equal((res.value as unknown as { totalCount?: number }).totalCount, 42);
  }

  const codeRes = await memorySearchLogic(d, "find code", "code");
  assert.equal(codeRes.ok, true);
  if (codeRes.ok) {
    assert.equal(codeRes.value.length, 0);
    assert.equal((codeRes.value as unknown as { totalCount?: number }).totalCount, 10);
  }
});
