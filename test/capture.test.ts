import test from "node:test";
import assert from "node:assert/strict";
import { captureAtCompaction, summaryPayload } from "../src/capture.ts";
import { pointId } from "../src/ids.ts";
import { createMemoryStore } from "./support/memory-store.ts";
import type { MemoryStore } from "./support/memory-store.ts";

const PROJECT = "pi-mem-p";
const DIM = 768;

function newStore(): MemoryStore {
  return createMemoryStore({ name: PROJECT, dimension: DIM });
}

const embed = async () => new Array(DIM).fill(0.1);

test("summaryPayload builds session_summary own_capture point", () => {
  const p = summaryPayload("summary text", "pi-mem-p", "sess9", 5);
  assert.equal(p.type, "session_summary");
  assert.equal(p.source_kind, "own_capture");
  assert.equal(p.session_id, "sess9");
  assert.equal(p.ts, 5);
});

test("captureAtCompaction creates a session_summary point with session_id", async () => {
  const store = newStore();
  const deps = { embed, qdrant: store, projectId: PROJECT };
  const res = await captureAtCompaction(deps, DIM, "we chose sqlite", "sess9", 7);
  assert.equal(res.ingested, 1);
  const pts = store.points();
  assert.equal(pts.length, 1);
  assert.equal(pts[0]!.id, pointId("we chose sqlite", "own_capture", "sess9"));
  assert.equal(pts[0]!.payload.session_id, "sess9");
  assert.equal(pts[0]!.payload.type, "session_summary");
});

test("captureAtCompaction skips empty summary without error", async () => {
  const store = newStore();
  const deps = { embed, qdrant: store, projectId: PROJECT };
  const res = await captureAtCompaction(deps, DIM, "   ", "sess9", 7);
  assert.equal(res.ingested, 0);
  assert.equal(store.timeline.length, 0, "an empty summary must not touch the collection");
});

test("captureAtCompaction never throws on embed failure", async () => {
  const store = newStore();
  const deps = { embed: async () => { throw new Error("down"); }, qdrant: store, projectId: PROJECT };
  const res = await captureAtCompaction(deps, DIM, "some text", "sess9", 7);
  assert.equal(res.ingested, 0);
  assert.equal(store.points().length, 0);
});
