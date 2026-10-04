import test from "node:test";
import assert from "node:assert/strict";
import { rememberLogic, memorySearchLogic, forgetLogic } from "../src/tools-core.ts";
import { pointId } from "../src/ids.ts";
import { createMemoryStore } from "./support/memory-store.ts";
import type { MemoryStore } from "./support/memory-store.ts";
import type { QdrantLike } from "../src/qdrant.ts";
import type { PointPayload, RuntimeDeps } from "../src/types.ts";

const PROJECT = "pi-mem-p";

function payload(over: Partial<PointPayload> = {}): PointPayload {
  return { type: "decision", text: "use REST", project_id: PROJECT, ts: 1, source_kind: "remember_tool", ...over };
}

function deps(over: Partial<RuntimeDeps> = {}): RuntimeDeps & { q: MemoryStore; embeds: string[] } {
  const embeds: string[] = [];
  // A caller-provided qdrant is also the `q` handle tests inspect; a spread
  // override (e.g. a failing search) still carries the store's helpers.
  const q = (over.qdrant as MemoryStore | undefined) ?? createMemoryStore({ name: PROJECT });
  const base = {
    cfg: {
      qdrantUrl: "http://localhost:6333", qdrantApiKey: null,
      embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text",
      embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10, mode: "auto",
    },
    agentDir: "/tmp/agent", cwd: "/repo", projectId: PROJECT,
    embed: async (t: string) => { embeds.push(t); return new Array(768).fill(0.1); },
    qdrant: q,
    q,
    embeds,
  };
  return { ...base, ...over, qdrant: q, q } as RuntimeDeps & { q: MemoryStore; embeds: string[] };
}

test("rememberLogic upserts a deterministic point", async () => {
  const d = deps();
  const res = await rememberLogic(d, "always use REST for sync");
  assert.ok(res.ok);
  const pts = d.q.points();
  assert.equal(pts.length, 1);
  assert.equal(pts[0]!.id, pointId("always use REST for sync", "remember_tool", ""));
  assert.equal(pts[0]!.payload.type, "decision");
  assert.equal(pts[0]!.payload.source_kind, "remember_tool");
});

test("rememberLogic respects explicit type", async () => {
  const d = deps();
  const res = await rememberLogic(d, "prefer tabs", "preference");
  assert.ok(res.ok);
  assert.equal(d.q.points()[0]!.payload.type, "preference");
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
  assert.equal(d.q.points().length, 0);
});

test("rememberLogic embeds before ensureCollection so a failed embed leaves collection untouched (OI-001)", async () => {
  const d = deps({ embed: async () => { throw new Error("embed down"); } });
  const res = await rememberLogic(d, "important fact");
  assert.ok(!res.ok);
  // ensureCollection is a modeled mutation — a failed embed must not perform it.
  assert.equal(d.q.indexOfOp((op) => op.op === "ensure"), -1);
  assert.equal(d.q.dimensionOf(), undefined, "no collection may be created");
  assert.equal(d.q.points().length, 0);
});

test("rememberLogic reports an ensure failure as a bare reason (no throw)", async () => {
  const store = createMemoryStore({ name: PROJECT });
  const broken: QdrantLike = {
    ...store,
    async ensureCollection() { throw new Error("collection boom"); },
  };
  const d = deps({ qdrant: broken });
  const res = await rememberLogic(d, "important fact");
  assert.ok(!res.ok);
  assert.equal((res as { error: string }).error, "Error: collection boom");
  assert.equal(store.dimensionOf(), undefined, "a failed ensure leaves no collection behind");
  assert.equal(store.points().length, 0);
});

test("rememberLogic passes onDimensionMismatch: 'recreate' so a mismatched collection is rebuilt on write (OI-001)", async () => {
  // A collection created by a previous embedding model (384 dims).
  const store = createMemoryStore({ name: PROJECT, dimension: 384 });
  store.seed([{ id: "old-point", payload: payload({ text: "old memory" }) }]);
  const d = deps({ qdrant: store });
  const res = await rememberLogic(d, "recreate on write");
  assert.ok(res.ok);
  assert.equal(store.dimensionOf(), d.cfg.expectedDimension);
  assert.equal(store.points().some((p) => p.id === "old-point"), false, "the incompatible collection is deliberately wiped");
  assert.equal(store.points().length, 1);
  assert.equal(store.points()[0]!.payload.text, "recreate on write");
});

test("memorySearchLogic returns error and leaves collection untouched on dimension mismatch (OI-001)", async () => {
  const store = createMemoryStore({ name: PROJECT, dimension: 384 });
  store.seed([{ id: "keep", payload: payload() }]);
  const d = deps({ qdrant: store });
  const res = await memorySearchLogic(d, "search query");
  assert.ok(!res.ok);
  assert.match((res as { error: string }).error, /collection .* dim 384 ≠ expectedDimension 768/);
  assert.equal(store.dimensionOf(), 384, "the read path must never recreate the collection");
  assert.equal(store.points().some((p) => p.id === "keep"), true, "the read path must never delete stored memories");
});

test("memorySearchLogic rejects an empty query with a bare reason", async () => {
  const d = deps();
  const res = await memorySearchLogic(d, "   ");
  assert.ok(!res.ok);
  assert.equal((res as { error: string }).error, "query is empty");
  assert.equal(d.q.timeline.length, 0, "validation happens before any collection work");
});

test("memorySearchLogic returns a bare error reason when the search fails", async () => {
  const store = createMemoryStore({ name: PROJECT });
  const failing: QdrantLike = {
    ...store,
    async search() { throw new Error("connection refused"); },
  };
  const res = await memorySearchLogic(deps({ qdrant: failing }), "q");
  assert.ok(!res.ok);
  assert.equal((res as { error: string }).error, "Error: connection refused");
});

test("memorySearchLogic embeds the query, filters by type, and hides code points from untyped searches", async () => {
  const d = deps();
  d.q.seed([
    { id: "decision-1", payload: payload({ source_kind: "blackhole_reflection" }) },
    { id: "code-1", payload: payload({ type: "code", text: "function auth()", source_kind: "code_summary", file_path: "src/auth.ts", file_sha: "abc", symbol: "auth" }) },
  ]);

  const res = await memorySearchLogic(d, "what did we decide about transport", "decision", 3);
  assert.ok(res.ok);
  assert.deepEqual(d.embeds, ["what did we decide about transport"]);
  assert.deepEqual(res.value.map((h) => h.id), ["decision-1"]);

  // Untyped search applies the same code-point exclusion (must_not type: code).
  const untyped = await memorySearchLogic(d, "what did we decide");
  assert.ok(untyped.ok);
  assert.deepEqual(untyped.value.map((h) => h.id), ["decision-1"]);
});

test("memorySearchLogic caps limit at maxResults", async () => {
  const d = deps();
  d.q.seed(Array.from({ length: 12 }, (_v, i) => ({
    id: `p-${String(i)}`,
    payload: payload({ text: `fact ${String(i)}`, ts: i }),
  })));
  const res = await memorySearchLogic(d, "q", undefined, 1000);
  assert.ok(res.ok);
  assert.equal(res.value.length, 10); // cfg.maxResults
});

test("memory_search uses codeScoreThreshold for code queries, scoreThreshold otherwise", async () => {
  // Fixed scores: the decision sits just above the conversation bar and the
  // code point just below the code bar, so each search must use its own
  // threshold — the wrong one flips the result in both directions.
  const store = createMemoryStore({
    name: PROJECT,
    scoreOf: (_query, point) => (point.payload.type === "code" ? 0.35 : 0.2),
  });
  const d = deps({
    cfg: {
      qdrantUrl: "http://localhost:6333", qdrantApiKey: null,
      embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text",
      embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10,
      mode: "auto", codeKnowledge: "on", codeScoreThreshold: 0.4, memoryForget: "off",
    },
    qdrant: store,
  });
  store.seed([
    { id: "decision-1", payload: payload() },
    { id: "code-1", payload: payload({ type: "code", source_kind: "code_summary", file_path: "src/a.ts", file_sha: "sha" }) },
  ]);

  const memories = await memorySearchLogic(d, "why is auth like this");
  assert.ok(memories.ok);
  assert.deepEqual(memories.value.map((h) => h.id), ["decision-1"], "0.2 ≥ 0.18; a 0.4 conversation bar would have dropped it");

  const code = await memorySearchLogic(d, "how does auth work", "code");
  assert.ok(code.ok);
  assert.equal(code.value.length, 0, "0.35 < 0.4; a 0.18 code bar would have let it through");
});

test("rememberLogic skips embed and upsert when point already exists (Shape C)", async () => {
  const store = createMemoryStore({ name: PROJECT });
  const targetId = pointId("already remembered fact", "remember_tool", "");
  store.seed([{ id: targetId, payload: payload({ type: "fact", text: "already remembered fact" }) }]);

  const d = deps({ qdrant: store });

  const res = await rememberLogic(d, "already remembered fact", "fact");
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.skipped, true);
    assert.equal(res.value.text, "already remembered fact");
  }
  assert.equal(d.embeds.length, 0, "embed must not be called when point already exists");
  assert.equal(store.timeline.length, 0, "no ensure and no upsert when point already exists");
  assert.equal(store.points().length, 1, "the stored point is untouched");
});

test("rememberLogic proceeds to embed and upsert when point does not exist (Shape C)", async () => {
  const store = createMemoryStore({ name: PROJECT });
  const d = deps({ qdrant: store });

  const res = await rememberLogic(d, "brand new fact", "fact");
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.skipped, undefined);
    assert.equal(res.value.text, "brand new fact");
  }
  assert.equal(d.embeds.length, 1);
  assert.equal(store.points().length, 1);
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
  const d = deps();
  const res = await forgetLogic(d, "fact not saved");
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, "no memory_save point with that exact text");
  assert.equal(d.q.points().length, 0, "nothing to delete, nothing changed");
});

test("forgetLogic deletes existing point without calling embed or ensureCollection", async () => {
  const store = createMemoryStore({ name: PROJECT });
  const text = "we use Postgres";
  const id = pointId(text, "remember_tool", "");
  store.seed([{ id, payload: payload({ text }) }]);
  const d = deps({ qdrant: store });

  const res = await forgetLogic(d, text);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.text, text);
    assert.equal(res.value.removed, 1);
  }
  assert.equal(store.points().length, 0, "the point is really removed");
  assert.equal(store.indexOfOp((op) => op.op === "ensure"), -1, "forgetLogic must never ensure");
  assert.equal(d.embeds.length, 0, "forgetLogic must never call embed");
});

test("ensureCollection is memoized across multiple calls when collectionReady is provided (OI-010)", async () => {
  const collectionReady = new Set<string>();
  const d = deps({ collectionReady });
  await rememberLogic(d, "fact 1");
  await rememberLogic(d, "fact 2");
  await memorySearchLogic(d, "query 1");
  await memorySearchLogic(d, "query 2");
  const ensures = d.q.timeline.filter((op) => op.op === "ensure").length;
  assert.equal(ensures, 1, "ensureCollection should only be called once when memoized");
  assert.ok(collectionReady.has(d.projectId));
});

test("memorySearchLogic queries count and attaches totalCount when hits are empty (OI-018)", async () => {
  // Scores fixed below every threshold → no hits; the counts are real.
  const store = createMemoryStore({ name: PROJECT, scoreOf: () => 0 });
  const d = deps({ qdrant: store });
  store.seed(Array.from({ length: 42 }, (_v, i) => i < 10
    ? { id: `code-${String(i)}`, payload: payload({ type: "code", source_kind: "code_summary", file_path: `src/f${String(i)}.ts`, file_sha: "sha" }) }
    : { id: `mem-${String(i)}`, payload: payload({ text: `memory ${String(i)}`, ts: i }) }));

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

test("forgetLogic propagates error when existingPointIds fails", async () => {
  const store = createMemoryStore({ name: PROJECT });
  const failing: QdrantLike = {
    ...store,
    async existingPointIds() { throw new Error("Qdrant connection refused"); },
  };
  const d = deps({ qdrant: failing });
  const res = await forgetLogic(d, "some memory");
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /Qdrant connection refused/);
  }
});

test("forgetLogic fails cleanly when deletePointsByIds is absent", async () => {
  const store = createMemoryStore({ name: PROJECT });
  const text = "important memory";
  const id = pointId(text, "remember_tool", "");
  store.seed([{ id, payload: payload({ text }) }]);
  const q: QdrantLike = { ...store, deletePointsByIds: undefined };
  const d = deps({ qdrant: q });
  const res = await forgetLogic(d, text);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error, "client does not support point deletion by id");
  assert.equal(store.points().length, 1, "nothing may be deleted");
});

test("forgetLogic with the shared stateful store actually removes the memory", async () => {
  const store = createMemoryStore({ name: PROJECT });
  const text = "temp fact";
  const id = pointId(text, "remember_tool", "");
  store.seed([{ id, payload: payload({ text }) }]);

  const d = deps({ qdrant: store });
  const res = await forgetLogic(d, text);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.removed, 1);
  }
  assert.equal(store.points().some((p) => p.id === id), false, "point should be removed from store");

  // Forgetting it a second time now fails because it was deleted
  const res2 = await forgetLogic(d, text);
  assert.equal(res2.ok, false);
  if (!res2.ok) {
    assert.equal(res2.error, "no memory_save point with that exact text");
  }
});
