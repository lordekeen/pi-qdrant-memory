import test from "node:test";
import assert from "node:assert/strict";
import { ingestItems, ensureAndGet } from "../src/ingest.ts";
import { pointId } from "../src/ids.ts";
import { createMemoryStore } from "./support/memory-store.ts";
import type { MemoryStore } from "./support/memory-store.ts";
import type { PointPayload } from "../src/types.ts";

const PROJECT = "pi-mem-abc";
const DIM = 768;

function newStore(): MemoryStore {
  return createMemoryStore({ name: PROJECT, dimension: DIM });
}

function payload(over: Partial<PointPayload> = {}): PointPayload {
  return { type: "decision", text: "use REST", project_id: PROJECT, ts: 1, source_kind: "remember_tool", ...over };
}

test("ensureAndGet creates collection with project id and dim", async () => {
  const store = newStore();
  await ensureAndGet({ embed: async () => [], qdrant: store, projectId: PROJECT }, DIM);
  assert.deepEqual(store.timeline, [{ op: "ensure", name: PROJECT, dim: DIM, outcome: "created" }]);
  assert.equal(store.dimensionOf(), DIM);
});

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
