import test from "node:test";
import assert from "node:assert/strict";
import { ingestItems, ensureAndGet } from "../src/ingest.ts";
import { pointId } from "../src/ids.ts";
import type { QdrantLike, QdrantPoint } from "../src/qdrant.ts";
import type { SearchHit } from "../src/types.ts";

function fakeQdrant(): QdrantLike & { upserted: QdrantPoint[][]; ensured: Array<{ name: string; dim: number }> } {
  const upserted: QdrantPoint[][] = [];
  const ensured: Array<{ name: string; dim: number }> = [];
  return {
    upserted, ensured,
    async ensureCollection(name, dim) { ensured.push({ name, dim }); return "created"; },
    async upsert(_name, points) { upserted.push(points); },
    async search() { return [] as SearchHit[]; },
    async count() { return 0; },
    async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
    async countBySourceKind() { return 0; },
  };
}

test("ensureAndGet creates collection with project id and dim", async () => {
  const q = fakeQdrant();
  await ensureAndGet({ embed: async () => [], qdrant: q, projectId: "pi-mem-abc" }, 768);
  assert.deepEqual(q.ensured, [{ name: "pi-mem-abc", dim: 768 }]);
});

test("ingestItems embeds and upserts with deterministic ids", async () => {
  const q = fakeQdrant();
  const embedded: string[] = [];
  const deps = {
    embed: async (t: string) => { embedded.push(t); return new Array(768).fill(0.5); },
    qdrant: q, projectId: "pi-mem-abc",
  };
  const res = await ingestItems(deps, 768, [
    { text: "use REST", sourceKind: "remember_tool" as const, contextId: "s1",
      payload: { type: "decision" as const, project_id: "pi-mem-abc", ts: 1, source_kind: "remember_tool" as const } },
  ]);
  assert.equal(res.ingested, 1);
  assert.equal(embedded.length, 1);
  assert.equal(q.upserted.length, 1);
  const upserted = q.upserted[0];
  assert.equal(upserted.length, 1);
  assert.equal(upserted[0].id, pointId("use REST", "remember_tool", "s1"));
  assert.equal(upserted[0].vector.length, 768);
});

test("ingestItems never throws and reports embed failures as skipped", async () => {
  const q = fakeQdrant();
  const deps = {
    embed: async () => { throw new Error("embed down"); },
    qdrant: q, projectId: "pi-mem-abc",
  };
  const res = await ingestItems(deps, 768, [
    { text: "x", sourceKind: "remember_tool" as const, contextId: "s1",
      payload: { type: "decision" as const, project_id: "pi-mem-abc", ts: 1, source_kind: "remember_tool" as const } },
  ]);
  assert.equal(res.attempted, 1);
  assert.equal(res.ingested, 0);
});

test("ingestItems skips items that already exist in Qdrant and makes 0 embed calls (#17)", async () => {
  const q = fakeQdrant();
  const existingId = pointId("already stored", "remember_tool", "s1");
  q.existingPointIds = async (_name: string, ids: string[]) => new Set(ids.filter((id) => id === existingId));

  const embedded: string[] = [];
  const deps = {
    embed: async (t: string) => { embedded.push(t); return new Array(768).fill(0.1); },
    qdrant: q, projectId: "pi-mem-abc",
  };

  const res = await ingestItems(deps, 768, [
    { text: "already stored", sourceKind: "remember_tool" as const, contextId: "s1",
      payload: { type: "decision" as const, project_id: "pi-mem-abc", ts: 1, source_kind: "remember_tool" as const } },
  ]);
  assert.equal(res.attempted, 1);
  assert.equal(res.ingested, 0);
  assert.equal(embedded.length, 0);
  assert.equal(q.upserted.length, 0);
});

test("ingestItems uses embedBatch when available for pending items (#17)", async () => {
  const q = fakeQdrant();
  const batchCalls: string[][] = [];
  const deps = {
    embed: async () => { throw new Error("should not be called"); },
    embedBatch: async (texts: string[]) => {
      batchCalls.push(texts);
      return texts.map(() => new Array(768).fill(0.2));
    },
    qdrant: q, projectId: "pi-mem-abc",
  };

  const res = await ingestItems(deps, 768, [
    { text: "item1", sourceKind: "remember_tool" as const, contextId: "s1",
      payload: { type: "decision" as const, project_id: "pi-mem-abc", ts: 1, source_kind: "remember_tool" as const } },
    { text: "item2", sourceKind: "remember_tool" as const, contextId: "s2",
      payload: { type: "decision" as const, project_id: "pi-mem-abc", ts: 2, source_kind: "remember_tool" as const } },
  ]);
  assert.equal(res.attempted, 2);
  assert.equal(res.ingested, 2);
  assert.equal(batchCalls.length, 1);
  assert.deepEqual(batchCalls[0], ["item1", "item2"]);
  assert.equal(q.upserted.length, 1);
  assert.equal(q.upserted[0]!.length, 2);
});

test("ingestItems calls deletePointsBySourceEntryIds before upserting new points (OI-004)", async () => {
  const q = fakeQdrant();
  const timeline: string[] = [];
  const deletedSourceEntryIds: string[][] = [];

  q.deletePointsBySourceEntryIds = async (_name, ids) => {
    timeline.push("delete");
    deletedSourceEntryIds.push(ids);
  };
  const origUpsert = q.upsert;
  q.upsert = async (name, points) => {
    timeline.push("upsert");
    await origUpsert(name, points);
  };

  const deps = {
    embed: async () => {
      timeline.push("embed");
      return new Array(768).fill(0.1);
    },
    qdrant: q,
    projectId: "pi-mem-abc",
  };

  const res = await ingestItems(deps, 768, [
    {
      text: "revised observation text",
      sourceKind: "blackhole_observation" as const,
      contextId: "obs-1",
      payload: {
        type: "fact" as const,
        project_id: "pi-mem-abc",
        ts: 2,
        source_kind: "blackhole_observation" as const,
        source_entry_id: "obs-1",
      },
    },
  ]);

  assert.equal(res.ingested, 1);
  assert.deepEqual(timeline, ["embed", "delete", "upsert"]);
  assert.deepEqual(deletedSourceEntryIds, [["obs-1"]]);
  assert.equal(q.upserted.length, 1);
});

test("ingestItems does not call deletePointsBySourceEntryIds if embed fails", async () => {
  const q = fakeQdrant();
  let deleteCalled = false;
  q.deletePointsBySourceEntryIds = async () => { deleteCalled = true; };

  const deps = {
    embed: async () => { throw new Error("embed failed"); },
    qdrant: q,
    projectId: "pi-mem-abc",
  };

  const res = await ingestItems(deps, 768, [
    {
      text: "observation text",
      sourceKind: "blackhole_observation" as const,
      contextId: "obs-1",
      payload: {
        type: "fact" as const,
        project_id: "pi-mem-abc",
        ts: 1,
        source_kind: "blackhole_observation" as const,
        source_entry_id: "obs-1",
      },
    },
  ]);

  assert.equal(res.ingested, 0);
  assert.equal(deleteCalled, false, "delete must not be called if embed fails");
  assert.equal(q.upserted.length, 0);
});

test("ingestItems skips deletePointsBySourceEntryIds for items without source_entry_id", async () => {
  const q = fakeQdrant();
  let deleteCalled = false;
  q.deletePointsBySourceEntryIds = async () => { deleteCalled = true; };

  const deps = {
    embed: async () => new Array(768).fill(0.1),
    qdrant: q,
    projectId: "pi-mem-abc",
  };

  const res = await ingestItems(deps, 768, [
    {
      text: "compaction summary text",
      sourceKind: "own_capture" as const,
      contextId: "sess-1",
      payload: {
        type: "session_summary" as const,
        project_id: "pi-mem-abc",
        ts: 1,
        source_kind: "own_capture" as const,
        // no source_entry_id
      },
    },
  ]);

  assert.equal(res.ingested, 1);
  assert.equal(deleteCalled, false, "items without source_entry_id must not trigger delete");
  assert.equal(q.upserted.length, 1);
});

