import test from "node:test";
import assert from "node:assert/strict";
import { ingestItems } from "../src/ingest.ts";
import { pointId } from "../src/ids.ts";
import { createMemoryStore } from "./support/memory-store.ts";
import type { MemoryStore } from "./support/memory-store.ts";
import type { QdrantLike } from "../src/qdrant.ts";
import type { PointPayload } from "../src/types.ts";

const PROJECT = "pi-mem-abc";
const DIM = 768;

function newStore(): MemoryStore {
  return createMemoryStore({ name: PROJECT, dimension: DIM });
}

function payload(over: Partial<PointPayload> = {}): PointPayload {
  return { type: "decision", text: "use REST", project_id: PROJECT, ts: 1, source_kind: "remember_tool", ...over };
}

test("ingestItems embeds and upserts with deterministic ids", async () => {
  const store = newStore();
  const embedded: string[] = [];
  const deps = {
    embed: async (t: string) => { embedded.push(t); return new Array(DIM).fill(0.5); },
    qdrant: store, projectId: PROJECT,
  };
  const res = await ingestItems(deps, DIM, [
    { text: "use REST", sourceKind: "remember_tool" as const, contextId: "s1",
      payload: { type: "decision" as const, project_id: PROJECT, ts: 1, source_kind: "remember_tool" as const } },
  ]);
  assert.equal(res.ingested, 1);
  assert.equal(embedded.length, 1);
  const stored = store.points();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.id, pointId("use REST", "remember_tool", "s1"));
  assert.equal(stored[0]!.vector.length, DIM);
  assert.equal(stored[0]!.payload.text, "use REST", "the canonical text is injected into the stored payload");
});

test("ingestItems never throws and reports embed failures as skipped", async () => {
  const store = newStore();
  const deps = {
    embed: async () => { throw new Error("embed down"); },
    qdrant: store, projectId: PROJECT,
  };
  const res = await ingestItems(deps, DIM, [
    { text: "x", sourceKind: "remember_tool" as const, contextId: "s1",
      payload: { type: "decision" as const, project_id: PROJECT, ts: 1, source_kind: "remember_tool" as const } },
  ]);
  assert.equal(res.attempted, 1);
  assert.equal(res.ingested, 0);
  assert.equal(store.points().length, 0);
});

test("ingestItems skips items that already exist in Qdrant and makes 0 embed calls (#17)", async () => {
  const store = newStore();
  const existingId = pointId("already stored", "remember_tool", "s1");
  store.seed([{ id: existingId, payload: payload({ text: "already stored" }) }]);

  const embedded: string[] = [];
  const deps = {
    embed: async (t: string) => { embedded.push(t); return new Array(DIM).fill(0.1); },
    qdrant: store, projectId: PROJECT,
  };

  const res = await ingestItems(deps, DIM, [
    { text: "already stored", sourceKind: "remember_tool" as const, contextId: "s1",
      payload: { type: "decision" as const, project_id: PROJECT, ts: 1, source_kind: "remember_tool" as const } },
  ]);
  assert.equal(res.attempted, 1);
  assert.equal(res.ingested, 0);
  assert.equal(embedded.length, 0);
  // The pre-existing point is neither duplicated nor rewritten.
  assert.equal(store.points().length, 1);
  assert.equal(store.points()[0]!.payload.text, "already stored");
  assert.equal(store.indexOfOp((op) => op.op === "upsert"), -1);
});

test("ingestItems uses embedBatch when available for pending items (#17)", async () => {
  const store = newStore();
  const batchCalls: string[][] = [];
  const deps = {
    embed: async () => { throw new Error("should not be called"); },
    embedBatch: async (texts: string[]) => {
      batchCalls.push(texts);
      return texts.map(() => new Array(DIM).fill(0.2));
    },
    qdrant: store, projectId: PROJECT,
  };

  const res = await ingestItems(deps, DIM, [
    { text: "item1", sourceKind: "remember_tool" as const, contextId: "s1",
      payload: { type: "decision" as const, project_id: PROJECT, ts: 1, source_kind: "remember_tool" as const } },
    { text: "item2", sourceKind: "remember_tool" as const, contextId: "s2",
      payload: { type: "decision" as const, project_id: PROJECT, ts: 2, source_kind: "remember_tool" as const } },
  ]);
  assert.equal(res.attempted, 2);
  assert.equal(res.ingested, 2);
  assert.equal(batchCalls.length, 1);
  assert.deepEqual(batchCalls[0], ["item1", "item2"]);
  assert.deepEqual(store.upsertBatches(), [[
    pointId("item1", "remember_tool", "s1"),
    pointId("item2", "remember_tool", "s2"),
  ]], "both points land in one upsert");
  assert.equal(store.points().length, 2);
});

test("ingestItems calls deletePointsBySourceEntryIds before upserting new points (OI-004)", async () => {
  const store = newStore();
  // The previously ingested revision of the same blackhole observation.
  const oldId = "old-revision";
  store.seed([{ id: oldId, payload: payload({ type: "fact", text: "old observation text", source_entry_id: "obs-1" }) }]);

  let embedCalls = 0;
  const deps = {
    embed: async () => {
      embedCalls++;
      // The supersede delete has not happened yet: a failed or late embed must
      // never invalidate the previous revision.
      assert.ok(store.points().some((p) => p.id === oldId), "the old revision must survive until the embed succeeds");
      return new Array(DIM).fill(0.1);
    },
    qdrant: store,
    projectId: PROJECT,
  };

  const res = await ingestItems(deps, DIM, [
    {
      text: "revised observation text",
      sourceKind: "blackhole_observation" as const,
      contextId: "obs-1",
      payload: {
        type: "fact" as const,
        project_id: PROJECT,
        ts: 2,
        source_kind: "blackhole_observation" as const,
        source_entry_id: "obs-1",
      },
    },
  ]);

  assert.equal(res.ingested, 1);
  assert.equal(embedCalls, 1);
  const deleteAt = store.indexOfOp((op) => op.op === "delete" && op.by === "source_entry_ids" && op.ids.includes("obs-1"));
  const upsertAt = store.indexOfOp((op) => op.op === "upsert");
  assert.ok(deleteAt >= 0 && upsertAt >= 0 && deleteAt < upsertAt, "the supersede delete must precede the upsert");
  assert.equal(store.points().some((p) => p.id === oldId), false, "the superseded revision is really gone");
  assert.equal(store.points().length, 1);
  assert.equal(store.points()[0]!.id, pointId("revised observation text", "blackhole_observation", "obs-1"));
});

test("ingestItems does not call deletePointsBySourceEntryIds if embed fails", async () => {
  const store = newStore();
  const oldId = "old-revision";
  store.seed([{ id: oldId, payload: payload({ type: "fact", text: "old observation text", source_entry_id: "obs-1" }) }]);

  const deps = {
    embed: async () => { throw new Error("embed failed"); },
    qdrant: store,
    projectId: PROJECT,
  };

  const res = await ingestItems(deps, DIM, [
    {
      text: "observation text",
      sourceKind: "blackhole_observation" as const,
      contextId: "obs-1",
      payload: {
        type: "fact" as const,
        project_id: PROJECT,
        ts: 1,
        source_kind: "blackhole_observation" as const,
        source_entry_id: "obs-1",
      },
    },
  ]);

  assert.equal(res.ingested, 0);
  assert.equal(store.indexOfOp((op) => op.op === "delete"), -1, "delete must not be called if embed fails");
  assert.equal(store.points().length, 1, "the previous revision must survive the failed embed");
  assert.equal(store.points()[0]!.id, oldId);
});

test("ingestItems skips deletePointsBySourceEntryIds for items without source_entry_id", async () => {
  const store = newStore();
  const deps = {
    embed: async () => new Array(DIM).fill(0.1),
    qdrant: store,
    projectId: PROJECT,
  };

  const res = await ingestItems(deps, DIM, [
    {
      text: "compaction summary text",
      sourceKind: "own_capture" as const,
      contextId: "sess-1",
      payload: {
        type: "session_summary" as const,
        project_id: PROJECT,
        ts: 1,
        source_kind: "own_capture" as const,
        // no source_entry_id
      },
    },
  ]);

  assert.equal(res.ingested, 1);
  assert.equal(store.indexOfOp((op) => op.op === "delete"), -1, "items without source_entry_id must not trigger delete");
  assert.equal(store.points().length, 1);
});

test("ingestItems maps an upsert failure to ingested: 0 with attempted unchanged", async () => {
  const store = newStore();
  const broken: QdrantLike = {
    ...store,
    async upsert() { throw new Error("store down"); },
  };
  const deps = { embed: async () => new Array(DIM).fill(0.1), qdrant: broken, projectId: PROJECT };

  const res = await ingestItems(deps, DIM, [
    { text: "one", sourceKind: "remember_tool" as const, contextId: "s1",
      payload: { type: "decision" as const, project_id: PROJECT, ts: 1, source_kind: "remember_tool" as const } },
    { text: "two", sourceKind: "remember_tool" as const, contextId: "s2",
      payload: { type: "decision" as const, project_id: PROJECT, ts: 2, source_kind: "remember_tool" as const } },
  ]);

  assert.equal(res.attempted, 2);
  assert.equal(res.ingested, 0, "a failed upsert discards the whole write count");
  assert.equal(store.points().length, 0);
});

test("ingestItems skips only a failed embed chunk's items and upserts the survivors", async () => {
  const store = newStore();
  let calls = 0;
  const deps = {
    embed: async () => { throw new Error("should not be called"); },
    embedBatch: async (texts: string[]) => {
      calls++;
      if (calls === 2) throw new Error("chunk down");
      return texts.map(() => new Array(DIM).fill(0.3));
    },
    qdrant: store,
    projectId: PROJECT,
  };
  const items = Array.from({ length: 40 }, (_v, i) => ({
    text: `item ${String(i)}`,
    sourceKind: "remember_tool" as const,
    contextId: `s${String(i)}`,
    payload: { type: "decision" as const, project_id: PROJECT, ts: i, source_kind: "remember_tool" as const },
  }));

  const res = await ingestItems(deps, DIM, items);

  assert.equal(res.attempted, 40);
  assert.equal(res.ingested, 32, "only the failed chunk's items are skipped");
  assert.equal(store.upsertBatches().length, 1, "all survivors land in one upsert");
  assert.equal(store.points().length, 32);
});

test("#67: a fatal ensure still logs the chunk embed failures that preceded it", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  // A collection from a previous embedding model whose read-only probe cannot
  // see the mismatch (named-vector config → undefined size): the pre-flight
  // falls through, so the ensure fails fatally AFTER the first chunk embedded
  // and the second chunk failed — the state the embed → ensure ordering makes
  // reachable.
  const store = createMemoryStore({ name: PROJECT, dimension: 384 });
  store.seed([{ id: "keep", payload: payload({ text: "keep me" }) }]);
  const probeBlind: QdrantLike = { ...store, async collectionDimension() { return undefined; } };
  let calls = 0;
  const deps = {
    embed: async () => { throw new Error("should not be called"); },
    embedBatch: async (texts: string[]) => {
      calls++;
      if (calls === 2) throw new Error("chunk down");
      return texts.map(() => new Array(DIM).fill(0.3));
    },
    qdrant: probeBlind,
    projectId: PROJECT,
  };
  const items = Array.from({ length: 40 }, (_v, i) => ({
    text: `item ${String(i)}`,
    sourceKind: "remember_tool" as const,
    contextId: `s${String(i)}`,
    payload: { type: "decision" as const, project_id: PROJECT, ts: i, source_kind: "remember_tool" as const },
  }));

  const res = await ingestItems(deps, DIM, items);

  assert.equal(res.attempted, 40);
  assert.equal(res.ingested, 0);
  assert.equal(calls, 2);
  assert.equal(logged.length, 2, "both the chunk embed failure and the fatal ensure are reported");
  assert.equal(logged[0], "pi-qdrant-memory: ingest batch skipped (embed failed): Error: chunk down");
  assert.match(logged[1]!, /^pi-qdrant-memory: ingest failed \(non-fatal\): .*dim 384 ≠ expectedDimension 768/);
});

test("ingestItems never throws when ensure fails: the collection is left untouched", async () => {
  // A collection from a previous embedding model that the read-only probe
  // cannot see (named-vector config → undefined size): the background write
  // path must not recreate it (and must not throw out of ingestItems).
  const store = createMemoryStore({ name: PROJECT, dimension: 384 });
  store.seed([{ id: "keep", payload: payload({ text: "keep me" }) }]);
  const probeBlind: QdrantLike = { ...store, async collectionDimension() { return undefined; } };
  const deps = { embed: async () => new Array(DIM).fill(0.1), qdrant: probeBlind, projectId: PROJECT };

  const res = await ingestItems(deps, DIM, [
    { text: "new fact", sourceKind: "remember_tool" as const, contextId: "s1",
      payload: { type: "decision" as const, project_id: PROJECT, ts: 1, source_kind: "remember_tool" as const } },
  ]);

  assert.equal(res.attempted, 1);
  assert.equal(res.ingested, 0);
  assert.equal(store.dimensionOf(), 384, "the background path never recreates on mismatch");
  assert.equal(store.points().length, 1);
  assert.equal(store.points()[0]!.id, "keep");
});

test("#72: a stored dimension mismatch is pre-flighted before any embed", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  // A collection from a previous embedding model: the pre-flight must surface
  // it before the embedding cost, not after every item has embedded.
  const store = createMemoryStore({ name: PROJECT, dimension: 384 });
  store.seed([{ id: "keep", payload: payload({ text: "keep me" }) }]);
  let probes = 0;
  const probed: QdrantLike = { ...store, async collectionDimension() { probes++; return store.dimensionOf(); } };
  const embedded: string[] = [];
  const batchCalls: string[][] = [];
  const deps = {
    embed: async (text: string) => { embedded.push(text); return new Array(DIM).fill(0.1); },
    embedBatch: async (texts: string[]) => { batchCalls.push(texts); return texts.map(() => new Array(DIM).fill(0.1)); },
    qdrant: probed,
    projectId: PROJECT,
  };

  const res = await ingestItems(deps, DIM, [
    { text: "new fact", sourceKind: "remember_tool" as const, contextId: "s1",
      payload: { type: "decision" as const, project_id: PROJECT, ts: 1, source_kind: "remember_tool" as const } },
  ]);

  assert.equal(res.attempted, 1);
  assert.equal(res.ingested, 0);
  assert.equal(probes, 1, "the pre-flight consults collectionDimension exactly once");
  assert.equal(embedded.length, 0, "no per-item embed on a dimension mismatch");
  assert.equal(batchCalls.length, 0, "no batch embed on a dimension mismatch");
  assert.equal(store.timeline.length, 0, "the pre-flight performs no store mutation");
  assert.equal(store.dimensionOf(), 384, "the stored collection is left untouched");
  assert.deepEqual(store.points().map((p) => p.id), ["keep"]);
  assert.deepEqual(logged, [
    "pi-qdrant-memory: ingest skipped — collection pi-mem-abc has dimension 384 but the configured embedding model produces 768; move the collection aside or set the matching model",
  ]);
});

test("#72: a missing collection (undefined dimension) proceeds to the normal write path", async () => {
  const store = newStore(); // no collection created yet
  let probes = 0;
  let embeds = 0;
  const probed: QdrantLike = { ...store, async collectionDimension() { probes++; return undefined; } };
  const deps = {
    embed: async () => { embeds++; return new Array(DIM).fill(0.1); },
    qdrant: probed,
    projectId: PROJECT,
  };

  const res = await ingestItems(deps, DIM, [
    { text: "first fact", sourceKind: "remember_tool" as const, contextId: "s1",
      payload: { type: "decision" as const, project_id: PROJECT, ts: 1, source_kind: "remember_tool" as const } },
  ]);

  assert.equal(res.attempted, 1);
  assert.equal(res.ingested, 1);
  assert.equal(probes, 1, "the pre-flight consults collectionDimension exactly once");
  assert.equal(embeds, 1);
  assert.equal(store.dimensionOf(), DIM, "applyWrites' ensure created the collection at the configured dimension");
});

test("#72: a matching stored dimension proceeds to the normal write path", async () => {
  const store = newStore();
  await store.ensureCollection(PROJECT, DIM); // pre-existing collection at the right dimension
  let probes = 0;
  let embeds = 0;
  const probed: QdrantLike = { ...store, async collectionDimension() { probes++; return store.dimensionOf(); } };
  const deps = {
    embed: async () => { embeds++; return new Array(DIM).fill(0.1); },
    qdrant: probed,
    projectId: PROJECT,
  };

  const res = await ingestItems(deps, DIM, [
    { text: "matching fact", sourceKind: "remember_tool" as const, contextId: "s1",
      payload: { type: "decision" as const, project_id: PROJECT, ts: 1, source_kind: "remember_tool" as const } },
  ]);

  assert.equal(res.attempted, 1);
  assert.equal(res.ingested, 1);
  assert.equal(probes, 1, "the pre-flight consults collectionDimension exactly once");
  assert.equal(embeds, 1);
  assert.deepEqual(store.points().map((p) => p.id), [pointId("matching fact", "remember_tool", "s1")]);
});

test("#72: a throwing dimension probe is tolerated and the normal write path runs", async () => {
  const store = newStore();
  let probes = 0;
  const broken: QdrantLike = {
    ...store,
    async collectionDimension() { probes++; throw new Error("probe down"); },
  };
  let embeds = 0;
  const deps = {
    embed: async () => { embeds++; return new Array(DIM).fill(0.1); },
    qdrant: broken,
    projectId: PROJECT,
  };

  const res = await ingestItems(deps, DIM, [
    { text: "resilient fact", sourceKind: "remember_tool" as const, contextId: "s1",
      payload: { type: "decision" as const, project_id: PROJECT, ts: 1, source_kind: "remember_tool" as const } },
  ]);

  assert.equal(res.attempted, 1);
  assert.equal(res.ingested, 1, "an unreadable dimension falls through to the authoritative ensure");
  assert.equal(probes, 1, "the pre-flight is consulted (and its throw swallowed) exactly once");
  assert.equal(embeds, 1);
  assert.equal(store.dimensionOf(), DIM);
});
