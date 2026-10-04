/**
 * write-ordering module tests — `applyWrites` over the shared stateful store
 * (`test/support/memory-store.ts`): the protocol order (embed → ensure →
 * invalidate → upsert), the failure containment contract, and the report the
 * callers map back to their own results and log sentences.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyWrites, WRITE_CHUNK_SIZE } from "../src/writes.ts";
import type { WriteDeps, WriteItem } from "../src/writes.ts";
import { pointId } from "../src/ids.ts";
import { createMemoryStore } from "./support/memory-store.ts";
import type { MemoryStore } from "./support/memory-store.ts";
import type { QdrantLike } from "../src/qdrant.ts";
import type { PointPayload } from "../src/types.ts";

const PROJECT = "pi-mem-abc";
const DIM = 3;

function newStore(): MemoryStore {
  return createMemoryStore({ name: PROJECT, dimension: DIM });
}

/** A batch item; `over` carries the provenance fields (file_path, source_entry_id, …). */
function item(text: string, over: Partial<Omit<PointPayload, "text">> = {}): WriteItem {
  return {
    id: pointId(text, "remember_tool", ""),
    text,
    payload: { type: "decision", project_id: PROJECT, ts: 1, source_kind: "remember_tool", ...over },
  };
}

/** A code-sync summary item: payload carries file provenance. */
function codeItem(text: string, filePath: string, sha: string): WriteItem {
  return item(text, { type: "code", source_kind: "code_summary", file_path: filePath, file_sha: sha });
}

/** Uniform vectors for the requested texts. */
const embed = async (texts: string[]): Promise<number[][]> =>
  texts.map(() => new Array<number>(DIM).fill(0.1));

function deps(store: MemoryStore, over: Partial<WriteDeps> = {}): WriteDeps {
  return { embedBatch: embed, qdrant: store, projectId: PROJECT, dimension: DIM, ...over };
}

test("a batch's file delete precedes its upsert; the report counts the write and injects the text", async () => {
  const store = newStore();
  const stale: PointPayload = {
    type: "code", text: "stale", project_id: PROJECT, ts: 0, source_kind: "code_summary",
    file_path: "src/a.ts", file_sha: "old-sha", symbol: "old",
  };
  store.seed([{ id: "stale-a", payload: stale }]);

  const report = await applyWrites(deps(store), [{
    items: [codeItem("function alpha", "src/a.ts", "new-sha"), codeItem("file src/a.ts", "src/a.ts", "new-sha")],
    invalidate: "files",
  }]);

  assert.equal(report.written, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.error, undefined);
  const deleteAt = store.indexOfOp((op) => op.op === "delete" && op.by === "files");
  const upsertAt = store.indexOfOp((op) => op.op === "upsert");
  assert.ok(deleteAt >= 0 && upsertAt >= 0 && deleteAt < upsertAt, "delete must precede the upsert");
  assert.deepEqual(store.deletedFileBatches(), [["src/a.ts"]]);
  assert.deepEqual(store.upsertBatches(), [[
    pointId("function alpha", "remember_tool", ""),
    pointId("file src/a.ts", "remember_tool", ""),
  ]]);
  // The stale point really left; the module injected each item's text.
  assert.equal(store.points().some((p) => p.id === "stale-a"), false);
  assert.deepEqual(store.points().map((p) => p.payload.text), ["function alpha", "file src/a.ts"]);
  assert.deepEqual(store.points().map((p) => p.payload.file_sha), ["new-sha", "new-sha"]);
});

test("a fully failed embed performs no mutation: no ensure, no delete, no upsert", async () => {
  const store = newStore();
  const report = await applyWrites(deps(store, {
    embedBatch: async () => { throw new Error("embed down"); },
  }), [{ items: [item("a"), item("b")] }]);

  assert.equal(report.written, 0);
  assert.equal(report.failed, 1);
  assert.equal(report.embedFailed, 1);
  assert.deepEqual(report.batches[0]!.embedErrors, ["Error: embed down"]);
  assert.equal(store.timeline.length, 0, "not even ensure may run after a failed embed");
  assert.equal(store.dimensionOf(), undefined, "a failed embed must not create the collection");
  assert.equal(store.points().length, 0);
});

test("a failed embed chunk skips only that chunk's items; entry batches write their survivors together", async () => {
  const store = newStore();
  const calls: string[][] = [];
  const report = await applyWrites(deps(store, {
    embedBatch: async (texts) => {
      calls.push(texts);
      if (calls.length === 2) throw new Error("chunk 2 down");
      return texts.map(() => new Array<number>(DIM).fill(0.1));
    },
  }), [{
    items: Array.from({ length: WRITE_CHUNK_SIZE + 8 }, (_v, i) =>
      item(`text ${String(i)}`, {
        type: "fact", source_kind: "blackhole_observation", source_entry_id: `entry-${String(i)}`,
      })),
    invalidate: "source-entry-ids",
  }]);

  // Chunked at the shared cap: [32, 8]; the second chunk's items are skipped.
  assert.deepEqual(calls.map((c) => c.length), [WRITE_CHUNK_SIZE, 8]);
  assert.equal(report.written, WRITE_CHUNK_SIZE);
  assert.equal(report.embedFailed, 1);
  assert.equal(report.failed, 0, "the batch still wrote its survivors");
  // One upsert for every survivor, and the supersede delete covers only the
  // entries that were actually embedded (never a revision with no replacement).
  assert.equal(store.upsertBatches().length, 1);
  assert.equal(store.points().length, WRITE_CHUNK_SIZE);
  const deleteOp = store.timeline.find((op) => op.op === "delete" && op.by === "source_entry_ids");
  assert.ok(deleteOp && deleteOp.op === "delete" && deleteOp.by === "source_entry_ids");
  assert.deepEqual(deleteOp.ids, Array.from({ length: WRITE_CHUNK_SIZE }, (_v, i) => `entry-${String(i)}`));
});

test("a whole-file batch with a failed chunk writes nothing (a file is never half-replaced)", async () => {
  const store = newStore();
  const stale: PointPayload = {
    type: "code", text: "stale", project_id: PROJECT, ts: 0, source_kind: "code_summary",
    file_path: "src/big.ts", file_sha: "stale-sha",
  };
  store.seed([{ id: "stale-big", payload: stale }]);
  let calls = 0;
  const report = await applyWrites(deps(store, {
    embedBatch: async (texts) => {
      calls++;
      if (calls === 2) throw new Error("second chunk down");
      return texts.map(() => new Array<number>(DIM).fill(0.2));
    },
  }), [{
    items: Array.from({ length: WRITE_CHUNK_SIZE + 2 }, (_v, i) => codeItem(`summary ${String(i)}`, "src/big.ts", "new-sha")),
    invalidate: "files",
  }]);

  assert.equal(calls, 2);
  assert.equal(report.written, 0);
  assert.equal(report.batches[0]!.written, 0);
  assert.equal(store.deletedFileBatches().length, 0, "a failed embed never deletes");
  assert.equal(store.indexOfOp((op) => op.op === "upsert"), -1);
  assert.equal(store.points().length, 1, "the stale point survives for the next sync to retry");
  assert.equal(store.points()[0]!.payload.file_sha, "stale-sha");
});

test("ensure runs once, after the first successful embed, before the first upsert", async () => {
  const store = newStore();
  let calls = 0;
  const report = await applyWrites(deps(store, {
    embedBatch: async (texts) => {
      calls++;
      if (calls === 1) {
        assert.equal(store.dimensionOf(), undefined, "ensure must not run before the first embed");
      }
      return texts.map(() => new Array<number>(DIM).fill(0.1));
    },
  }), [
    { items: [item("a")] },
    { items: [item("b")] },
  ]);

  assert.equal(report.written, 2);
  const ensures = store.timeline.filter((op) => op.op === "ensure");
  assert.equal(ensures.length, 1, "one ensure per call");
  const ensureAt = store.indexOfOp((op) => op.op === "ensure");
  const upsertAt = store.indexOfOp((op) => op.op === "upsert");
  assert.ok(ensureAt >= 0 && upsertAt >= 0 && ensureAt < upsertAt);
});

test("'recreate' rebuilds a dimension-mismatched collection; the default 'error' policy leaves it untouched", async () => {
  const mismatched = createMemoryStore({ name: PROJECT, dimension: 768 });
  mismatched.seed([{ id: "old", payload: item("old memory").payload as PointPayload }]);
  const recreated = await applyWrites(deps(mismatched, { onDimensionMismatch: "recreate" }), [{ items: [item("new fact")] }]);
  assert.equal(recreated.written, 1);
  assert.equal(mismatched.dimensionOf(), DIM);
  assert.equal(mismatched.points().length, 1);
  assert.equal(mismatched.points()[0]!.payload.text, "new fact");

  const untouched = createMemoryStore({ name: PROJECT, dimension: 768 });
  untouched.seed([{ id: "keep", payload: item("keep").payload as PointPayload }]);
  const failed = await applyWrites(deps(untouched), [{ items: [item("nope")] }]);
  assert.equal(failed.written, 0);
  assert.match(failed.error ?? "", /collection .* dim 768 ≠ expectedDimension 3/);
  assert.equal(untouched.dimensionOf(), 768, "the read-path policy never recreates");
  assert.equal(untouched.points().length, 1, "the stored points are untouched");
});

test("a ready set short-circuits ensure and is filled by the first write", async () => {
  const store = newStore();
  const ready = new Set<string>();
  const first = await applyWrites(deps(store, { collectionReady: ready }), [{ items: [item("a")] }]);
  assert.equal(first.written, 1);
  assert.equal(ready.has(PROJECT), true, "a successful ensure marks the project ready");
  assert.equal(store.timeline.filter((op) => op.op === "ensure").length, 1);

  const store2 = newStore();
  store2.seed([]); // collection exists, created outside the timeline
  const ready2 = new Set([PROJECT]);
  const second = await applyWrites(deps(store2, { collectionReady: ready2 }), [{ items: [item("a")] }]);
  assert.equal(second.written, 1);
  assert.equal(store2.timeline.filter((op) => op.op === "ensure").length, 0, "a ready project skips ensure");
});

test("a failed invalidation is tolerated: the upsert still lands and the report carries the reason", async () => {
  const store = newStore();
  const broken: QdrantLike = {
    ...store,
    async deletePointsByFiles() { throw new Error("delete boom"); },
  };
  const report = await applyWrites(
    { ...deps(store), qdrant: broken },
    [{ items: [codeItem("alpha", "src/a.ts", "new-sha")], invalidate: "files" }],
  );

  assert.equal(report.written, 1);
  assert.equal(report.invalidateFailed, 1);
  assert.equal(report.upsertFailed, 0);
  assert.equal(report.batches[0]!.invalidateError, "Error: delete boom");
  assert.equal(store.points().length, 1, "the upsert still landed");
});

test("a failed upsert discards only that batch's write count; later batches continue", async () => {
  const store = newStore();
  let upserts = 0;
  const broken: QdrantLike = {
    ...store,
    async upsert(name, points) {
      upserts++;
      if (upserts === 1) throw new Error("upsert boom");
      await store.upsert(name, points);
    },
  };
  const report = await applyWrites(
    { ...deps(store), qdrant: broken },
    [{ items: [item("a")] }, { items: [item("b")] }],
  );

  assert.equal(report.written, 1);
  assert.equal(report.upsertFailed, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.batches[0]!.written, 0);
  assert.equal(report.batches[0]!.upsertError, "Error: upsert boom");
  assert.equal(report.batches[1]!.written, 1);
  assert.deepEqual(store.points().map((p) => p.payload.text), ["b"]);
});

test("never throws: a throwing adapter is reported, not propagated", async () => {
  const store = newStore();
  const ensureBroken: QdrantLike = {
    ...store,
    async ensureCollection() { throw new Error("ensure boom"); },
    async deletePointsByFiles() { throw new Error("delete boom"); },
    async upsert() { throw new Error("upsert boom"); },
  };
  const fatal = await applyWrites(
    { ...deps(store), qdrant: ensureBroken },
    [{ items: [codeItem("alpha", "src/a.ts", "new-sha")], invalidate: "files" }],
  );
  assert.equal(fatal.written, 0);
  assert.equal(fatal.error, "Error: ensure boom");
  assert.equal(fatal.batches[0]!.written, 0);

  const store2 = newStore();
  const writeBroken: QdrantLike = {
    ...store2,
    async deletePointsByFiles() { throw new Error("delete boom"); },
    async upsert() { throw new Error("upsert boom"); },
  };
  const degraded = await applyWrites(
    { ...deps(store2), qdrant: writeBroken },
    [{ items: [codeItem("alpha", "src/a.ts", "new-sha")], invalidate: "files" }],
  );
  assert.equal(degraded.error, undefined, "a degraded write is not a fatal failure");
  assert.equal(degraded.invalidateFailed, 1);
  assert.equal(degraded.upsertFailed, 1);
  assert.equal(degraded.batches[0]!.invalidateError, "Error: delete boom");
  assert.equal(degraded.batches[0]!.upsertError, "Error: upsert boom");
});

test("without embedBatch each item embeds on its own; one failure skips only that item", async () => {
  const store = newStore();
  const report = await applyWrites({
    qdrant: store,
    projectId: PROJECT,
    dimension: DIM,
    embed: async (text) => {
      if (text === "b") throw new Error("b down");
      return new Array<number>(DIM).fill(0.1);
    },
  }, [{
    items: [
      item("a", { type: "fact", source_kind: "blackhole_observation", source_entry_id: "e-a" }),
      item("b", { type: "fact", source_kind: "blackhole_observation", source_entry_id: "e-b" }),
      item("c", { type: "fact", source_kind: "blackhole_observation", source_entry_id: "e-c" }),
    ],
    invalidate: "source-entry-ids",
  }]);

  assert.equal(report.written, 2);
  assert.equal(report.embedFailed, 1);
  assert.deepEqual(report.batches[0]!.embedErrors, ["Error: b down"]);
  assert.deepEqual(store.points().map((p) => p.payload.text), ["a", "c"]);
  // Only the successfully embedded entries are superseded.
  const deleteOp = store.timeline.find((op) => op.op === "delete" && op.by === "source_entry_ids");
  assert.ok(deleteOp && deleteOp.op === "delete" && deleteOp.by === "source_entry_ids");
  assert.deepEqual(deleteOp.ids, ["e-a", "e-c"]);
});

test("no batches: an empty report with no store mutation", async () => {
  const store = newStore();
  const report = await applyWrites(deps(store), []);
  assert.deepEqual(report, {
    written: 0, failed: 0, embedFailed: 0, invalidateFailed: 0, upsertFailed: 0, batches: [],
  });
  assert.equal(store.timeline.length, 0);
});
