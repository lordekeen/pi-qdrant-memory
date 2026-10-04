/**
 * memory-store tests — the shared write-path store adapter. Every suite that
 * imports `createMemoryStore` trusts it to model real side effects, so the
 * model's contract is pinned here: add/replace, every delete, clear, the
 * ensure/recreate policy, the search filter policy and the mutation timeline.
 * If this model and `QdrantClient` disagree, the shared adapter lies to every
 * test that uses it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "./support/memory-store.ts";
import { DimensionMismatchError, QdrantError } from "../src/qdrant.ts";
import type { QdrantPoint } from "../src/qdrant.ts";
import type { PointPayload } from "../src/types.ts";

const NAME = "pi-mem-test";

function payload(over: Partial<PointPayload> = {}): PointPayload {
  return { type: "decision", text: "use REST", project_id: NAME, ts: 1, source_kind: "remember_tool", ...over };
}

function decision(id: string, over: Partial<PointPayload> = {}): QdrantPoint {
  return { id, vector: [1, 0, 0], payload: payload(over) };
}

function codePoint(id: string, over: Partial<PointPayload> = {}): QdrantPoint {
  return {
    id,
    vector: [1, 0, 0],
    payload: {
      type: "code",
      text: `code ${id}`,
      project_id: NAME,
      ts: 1,
      source_kind: "code_summary",
      file_path: `src/${id}.ts`,
      file_sha: `sha-${id}`,
      ...over,
    },
  };
}

test("upsert adds new points, replaces in place by id, and records a timeline", async () => {
  const store = createMemoryStore({ name: NAME, dimension: 3 });
  await store.ensureCollection(NAME, 3);
  await store.upsert(NAME, [decision("a"), decision("b")]);
  assert.deepEqual(store.points().map((p) => p.id), ["a", "b"]);

  await store.upsert(NAME, [decision("a", { text: "updated", type: "fact" })]);
  assert.equal(store.points().length, 2, "same id must replace, not duplicate");
  assert.equal(store.points()[0]!.payload.text, "updated");
  assert.equal(store.points()[0]!.payload.type, "fact");

  assert.deepEqual(store.upsertBatches(), [["a", "b"], ["a"]]);
  assert.deepEqual(store.timeline.map((op) => op.op), ["ensure", "upsert", "upsert"]);
});

test("ensureCollection returns created/exists, throws on mismatch, and recreates only when asked", async () => {
  const store = createMemoryStore({ name: NAME, dimension: 3 });
  assert.equal(await store.ensureCollection(NAME, 3), "created");
  assert.equal(await store.ensureCollection(NAME, 3), "exists");
  await store.upsert(NAME, [decision("a")]);

  await assert.rejects(
    () => store.ensureCollection(NAME, 4),
    (err: unknown) => {
      assert.ok(err instanceof DimensionMismatchError);
      assert.equal(err.stored, 3);
      assert.equal(err.expected, 4);
      return true;
    },
  );
  assert.equal(store.dimensionOf(), 3, "the error policy leaves the stored collection untouched");
  assert.equal(store.points().length, 1);

  assert.equal(await store.ensureCollection(NAME, 4, { onDimensionMismatch: "recreate" }), "recreated");
  assert.equal(store.dimensionOf(), 4);
  assert.equal(store.points().length, 0, "recreate wipes the collection");

  const outcomes = store.timeline.flatMap((op) => (op.op === "ensure" ? [op.outcome] : []));
  assert.deepEqual(outcomes, ["created", "exists", "recreated"]);
});

test("deletePointsByFiles removes only the stored points for those paths", async () => {
  const store = createMemoryStore({ name: NAME, dimension: 3 });
  await store.ensureCollection(NAME, 3);
  await store.upsert(NAME, [
    codePoint("a-node", { file_path: "src/a.ts", symbol: "alpha" }),
    codePoint("b"),
    codePoint("a-anchor", { file_path: "src/a.ts" }),
  ]);
  await store.deletePointsByFiles(NAME, ["src/a.ts"]);
  assert.deepEqual(store.points().map((p) => p.id), ["b"]);
  assert.deepEqual(store.deletedFileBatches(), [["src/a.ts"]]);

  const before = store.timeline.length;
  await store.deletePointsByFiles(NAME, []); // client parity: no request, no op
  assert.equal(store.timeline.length, before);
});

test("deletePointsBySourceKind and deletePointsBySourceEntryIds remove the matching points", async () => {
  const store = createMemoryStore({ name: NAME, dimension: 3 });
  await store.ensureCollection(NAME, 3);
  await store.upsert(NAME, [
    decision("obs-1", { text: "old observation", source_entry_id: "obs-1" }),
    decision("obs-2", { text: "other", source_entry_id: "obs-2" }),
    codePoint("c"),
  ]);
  await store.deletePointsBySourceEntryIds(NAME, ["obs-1"]);
  assert.deepEqual(store.points().map((p) => p.id), ["obs-2", "c"]);

  const before = store.timeline.length;
  await store.deletePointsBySourceEntryIds(NAME, []); // client parity: no request, no op
  assert.equal(store.timeline.length, before);

  await store.deletePointsBySourceKind(NAME, "code_summary");
  assert.deepEqual(store.points().map((p) => p.id), ["obs-2"]);
});

test("deletePointsByIds returns the number of points actually removed", async () => {
  const store = createMemoryStore({ name: NAME, dimension: 3 });
  await store.ensureCollection(NAME, 3);
  await store.upsert(NAME, [decision("a"), decision("b")]);
  assert.equal(await store.deletePointsByIds(NAME, ["a", "missing"]), 1);
  assert.deepEqual(store.points().map((p) => p.id), ["b"]);
  assert.equal(await store.deletePointsByIds(NAME, []), 0);
});

test("existingPointIds returns the intersection with the stored ids", async () => {
  const store = createMemoryStore({ name: NAME, dimension: 3 });
  await store.ensureCollection(NAME, 3);
  await store.upsert(NAME, [decision("a")]);
  assert.deepEqual([...(await store.existingPointIds(NAME, ["a", "b"]))], ["a"]);
  // A missing collection reads as empty (client parity).
  assert.deepEqual([...(await store.existingPointIds("nope", ["a"]))], []);
});

test("clearCollection empties the collection and drops it", async () => {
  const store = createMemoryStore({ name: NAME, dimension: 3 });
  await store.ensureCollection(NAME, 3);
  await store.upsert(NAME, [decision("a")]);
  await store.clearCollection(NAME);
  assert.equal(store.dimensionOf(), undefined);
  assert.equal(store.points().length, 0);
  assert.equal(store.indexOfOp((op) => op.op === "clear"), 2);
  assert.equal(await store.ensureCollection(NAME, 3), "created", "a cleared collection is recreated on next use");
});

test("operations on a missing collection match QdrantClient", async () => {
  const store = createMemoryStore({ name: NAME, dimension: 3 });
  await assert.rejects(() => store.count(NAME), (err: unknown) => err instanceof QdrantError && err.status === 404);
  await assert.rejects(() => store.search(NAME, [1, 0, 0], { projectId: NAME, limit: 5, threshold: 0 }), QdrantError);
  await assert.rejects(() => store.upsert(NAME, [decision("a")]), QdrantError);
  await assert.rejects(() => store.codeIndexSnapshot(NAME), QdrantError);
  // notFound-tolerant paths are empty / no-ops.
  assert.equal(await store.countBySourceKind(NAME, "code_summary"), 0);
  assert.equal(await store.countCodeSymbols(NAME), 0);
  assert.equal((await store.existingPointIds(NAME, ["a"])).size, 0);
  await store.deletePointsByFiles(NAME, ["src/a.ts"]);
  await store.deletePointsByIds(NAME, ["a"]);
});

test("codeIndexSnapshot maps file_path → file_sha over code points only", async () => {
  const store = createMemoryStore({ name: NAME, dimension: 3 });
  await store.ensureCollection(NAME, 3);
  await store.upsert(NAME, [
    codePoint("a", { file_path: "src/a.ts", file_sha: "sha-a" }),
    codePoint("b", { file_path: "src/b.ts", file_sha: "sha-b" }),
    codePoint("malformed", { file_path: "src/no-sha.ts", file_sha: undefined }),
    decision("d", { file_path: "src/not-code.ts", file_sha: "sha-d" }),
  ]);
  assert.deepEqual(
    [...(await store.codeIndexSnapshot(NAME))],
    [["src/a.ts", "sha-a"], ["src/b.ts", "sha-b"]],
  );
});

test("counts are real and countCodeSymbols excludes file anchors", async () => {
  const store = createMemoryStore({ name: NAME, dimension: 3 });
  await store.ensureCollection(NAME, 3);
  await store.upsert(NAME, [decision("d"), codePoint("sym", { symbol: "alpha" }), codePoint("anchor")]);
  assert.equal(await store.count(NAME), 3);
  assert.equal(await store.countBySourceKind(NAME, "code_summary"), 2);
  assert.equal(await store.countBySourceKind(NAME, "remember_tool"), 1);
  assert.equal(await store.countCodeSymbols(NAME), 1, "file anchors carry no symbol");
});

test("search applies the QdrantClient filter policy: project, type, code exclusion, threshold, limit", async () => {
  // `ts` doubles as the injected score, so the expected order is explicit.
  const store = createMemoryStore({ name: NAME, dimension: 3, scoreOf: (_query, point) => point.payload.ts });
  await store.ensureCollection(NAME, 3);
  await store.upsert(NAME, [
    decision("d1", { ts: 0.9 }),
    decision("d2", { ts: 0.1 }),
    decision("d3", { ts: 0.8 }),
    codePoint("c1", { ts: 0.5 }),
    decision("foreign", { ts: 1, project_id: "pi-mem-other" }),
  ]);
  const query = [1, 0, 0];

  const untyped = await store.search(NAME, query, { projectId: NAME, limit: 10, threshold: 0 });
  assert.deepEqual(untyped.map((h) => h.id), ["d1", "d3", "d2"], "code points and other projects are hidden");

  const typed = await store.search(NAME, query, { projectId: NAME, type: "decision", limit: 10, threshold: 0 });
  assert.deepEqual(typed.map((h) => h.id), ["d1", "d3", "d2"]);

  const code = await store.search(NAME, query, { projectId: NAME, type: "code", limit: 10, threshold: 0 });
  assert.deepEqual(code.map((h) => h.id), ["c1"]);

  const above = await store.search(NAME, query, { projectId: NAME, limit: 10, threshold: 0.8 });
  assert.deepEqual(above.map((h) => h.id), ["d1", "d3"], "threshold is inclusive and excludes d2");

  const limited = await store.search(NAME, query, { projectId: NAME, limit: 2, threshold: 0 });
  assert.deepEqual(limited.map((h) => h.id), ["d1", "d3"]);
  assert.deepEqual(limited.map((h) => h.score), [0.9, 0.8]);
});

test("default scoring is cosine similarity over the stored vectors", async () => {
  const store = createMemoryStore({ name: NAME, dimension: 2 });
  await store.ensureCollection(NAME, 2);
  await store.upsert(NAME, [
    { id: "same", vector: [1, 0], payload: payload() },
    { id: "orthogonal", vector: [0, 1], payload: payload() },
    { id: "zero", vector: [0, 0], payload: payload() },
  ]);
  const hits = await store.search(NAME, [1, 0], { projectId: NAME, limit: 10, threshold: 0 });
  assert.deepEqual(hits.map((h) => [h.id, h.score]), [["same", 1], ["orthogonal", 0], ["zero", 0]]);
});

test("seed establishes pre-existing state without recording mutations", async () => {
  const store = createMemoryStore({ name: NAME, dimension: 3 });
  store.seed([{ id: "a", payload: payload() }]);
  assert.equal(store.points().length, 1);
  assert.equal(store.dimensionOf(), 3, "seeding creates the collection at the configured dimension");
  assert.equal(store.timeline.length, 0, "seeding is setup, not a modeled write");
  assert.deepEqual(store.points()[0]!.vector, [0.1, 0.1, 0.1]);
});

test("indexOfOp finds the first matching mutation and returns -1 when absent", async () => {
  const store = createMemoryStore({ name: NAME, dimension: 3 });
  await store.ensureCollection(NAME, 3);
  await store.upsert(NAME, [decision("a")]);
  await store.deletePointsByIds(NAME, ["a"]);
  assert.equal(store.indexOfOp((op) => op.op === "delete"), 2);
  assert.equal(store.indexOfOp((op) => op.op === "clear"), -1);
});
