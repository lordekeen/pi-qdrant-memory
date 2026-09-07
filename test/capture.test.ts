import test from "node:test";
import assert from "node:assert/strict";
import { captureAtCompaction, autoSnapshot, summaryPayload } from "../src/capture.ts";
import { pointId } from "../src/ids.ts";
import type { QdrantLike, QdrantPoint } from "../src/qdrant.ts";

function fakeQdrant(): QdrantLike & { upserted: QdrantPoint[][] } {
  const upserted: QdrantPoint[][] = [];
  return {
    upserted,
    async ensureCollection() { return "exists"; },
    async upsert(_n, points) { upserted.push(points); },
    async search() { return []; },
    async count() { return 0; },
    async clearCollection() {},
  };
}

const embed = async () => new Array(768).fill(0.2);

test("summaryPayload builds session_summary own_capture point", () => {
  const p = summaryPayload("summary text", "pi-mem-p", "sess9", 5);
  assert.equal(p.type, "session_summary");
  assert.equal(p.source_kind, "own_capture");
  assert.equal(p.session_id, "sess9");
  assert.equal(p.ts, 5);
});

test("captureAtCompaction ingests one summary point with deterministic id", async () => {
  const q = fakeQdrant();
  const deps = { embed, qdrant: q, projectId: "pi-mem-p" };
  const res = await captureAtCompaction(deps, 768, "we decided REST over gRPC", "sess9", 7);
  assert.equal(res.ingested, 1);
  const pts = q.upserted[0];
  assert.equal(pts.length, 1);
  assert.equal(pts[0].id, pointId("we decided REST over gRPC", "own_capture", "sess9"));
  assert.equal(pts[0].payload.type, "session_summary");
});

test("captureAtCompaction skips empty summary without error", async () => {
  const q = fakeQdrant();
  const deps = { embed, qdrant: q, projectId: "pi-mem-p" };
  const res = await captureAtCompaction(deps, 768, "   ", "sess9", 7);
  assert.equal(res.ingested, 0);
  assert.equal(q.upserted.length, 0);
});

test("captureAtCompaction never throws on embed failure", async () => {
  const q = fakeQdrant();
  const deps = { embed: async () => { throw new Error("down"); }, qdrant: q, projectId: "pi-mem-p" };
  const res = await captureAtCompaction(deps, 768, "some text", "sess9", 7);
  assert.equal(res.ingested, 0);
});

test("autoSnapshot never throws and ingests", async () => {
  const q = fakeQdrant();
  const deps = { embed, qdrant: q, projectId: "pi-mem-p" };
  await autoSnapshot(deps, 768, "snapshot", "sess9", 1);
  assert.equal(q.upserted.length, 1);
});
