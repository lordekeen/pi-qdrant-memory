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
