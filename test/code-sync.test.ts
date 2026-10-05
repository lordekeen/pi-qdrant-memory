/**
 * code-sync tests — the shared stateful store (test/support/memory-store.ts)
 * + fake embedBatch; every phase of the diff (unchanged skip / changed replace
 * / vanished delete) and the failure containment contract (spec §9) is pinned
 * here. The store really adds and removes points, so a delete-after-upsert
 * wipe is visible and the ordering assertions mean something.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncCodeKnowledge, planSync, SYNC_BATCH_SIZE } from "../src/code-sync.ts";
import type { SyncDeps } from "../src/code-sync.ts";
import type { ScannedFile } from "../src/codescan.ts";
import { createHash } from "node:crypto";
import { createMemoryStore } from "./support/memory-store.ts";
import type { MemoryStore } from "./support/memory-store.ts";
import type { QdrantLike, QdrantPoint } from "../src/qdrant.ts";
import type { PointPayload } from "../src/types.ts";

const PROJECT = "pi-mem-abc";
const DIM = 3;

function newStore(): MemoryStore {
  return createMemoryStore({ name: PROJECT, dimension: DIM });
}

/** A code point as a previous sync would have left it: seeding one simulates
 *  an already-indexed (possibly stale) file without recording mutations. */
function indexedCodePoint(filePath: string, fileSha: string, over: Partial<PointPayload> = {}): QdrantPoint {
  return {
    id: `stale-${filePath}`,
    vector: new Array<number>(DIM).fill(0.1),
    payload: {
      type: "code",
      text: `stale ${filePath}`,
      project_id: PROJECT,
      ts: 0,
      source_kind: "code_summary",
      file_path: filePath,
      file_sha: fileSha,
      ...over,
    },
  };
}

function fakeEmbed() {
  return async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]);
}

function deps(root: string, qdrant: QdrantLike): SyncDeps {
  return {
    embedBatch: fakeEmbed(),
    qdrant,
    projectId: PROJECT,
    expectedDimension: DIM,
    repoRoot: root,
  };
}

function writeFile(root: string, rel: string, content: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), content);
}

const sha = (content: string): string => createHash("sha256").update(content).digest("hex");

test("first sync indexes everything: no deletes, node + file points per file", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    writeFile(root, "src/a.ts", "export function alpha() {}\n");
    const store = newStore();
    const res = await syncCodeKnowledge(deps(root, store));
    // First sync: snapshot empty → nothing vanished; the single changed file is
    // embedded, then its (empty) prior points are deleted by file_path, then its
    // new points are upserted — delete before upsert.
    assert.deepEqual(store.deletedFileBatches(), [["src/a.ts"]]);
    assert.equal(res.deleted, 1);
    assert.equal(res.files, 1);
    assert.equal(res.symbols, 1); // node summary only — the file anchor is not a symbol (#49)
    assert.equal(res.skipped, 0);
    const points = store.points();
    assert.equal(points.length, 2);
    for (const p of points) {
      assert.equal(p.payload.source_kind, "code_summary");
      assert.equal(p.payload.type, "code");
      assert.equal(p.payload.file_path, "src/a.ts");
    }
    // Node summary carries a symbol; the file anchor does not.
    assert.equal(points[0]!.payload.symbol, "alpha");
    assert.equal(points[1]!.payload.symbol, undefined);
    // One pass shares one `ts` across every point it writes.
    assert.equal(new Set(points.map((p) => p.payload.ts)).size, 1);
    // The freshly upserted points must survive the pass (delete precedes upsert).
    assert.equal(store.points().length, 2);
    const deleteAt = store.indexOfOp((op) => op.op === "delete" && op.by === "files");
    const upsertAt = store.indexOfOp((op) => op.op === "upsert");
    assert.ok(deleteAt >= 0 && upsertAt >= 0 && deleteAt < upsertAt);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unchanged file is skipped entirely (no delete, no upsert)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    const content = "export function alpha() {}\n";
    writeFile(root, "src/a.ts", content);
    const store = newStore();
    store.seed([indexedCodePoint("src/a.ts", sha(content))]);
    const res = await syncCodeKnowledge(deps(root, store));
    assert.equal(res.files, 0);
    assert.equal(res.skipped, 1);
    assert.equal(res.symbols, 0);
    assert.equal(store.deletedFileBatches().length, 0);
    assert.equal(store.indexOfOp((op) => op.op === "upsert"), -1);
    // A skip is a skip: the indexed point survives untouched.
    assert.equal(store.points().length, 1);
    assert.equal(store.points()[0]!.payload.file_sha, sha(content));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("changed file is deleted then re-upserted; vanished file is deleted", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    writeFile(root, "src/a.ts", "export function alpha() {}\n");
    const store = newStore();
    store.seed([indexedCodePoint("src/a.ts", "stale-sha"), indexedCodePoint("src/gone.ts", "old-sha")]);
    const res = await syncCodeKnowledge(deps(root, store));
    // Changed-file deletes arrive with their batch; vanished-file deletes arrive
    // as the trailing extras call. Assert the set + ordering, not call grouping.
    assert.deepEqual([...new Set(store.deletedFileBatches().flat())].sort(), ["src/a.ts", "src/gone.ts"]);
    assert.equal(res.deleted, 2);
    assert.equal(res.files, 1);
    assert.equal(store.upsertBatches().length, 1);
    const deleteAt = store.indexOfOp((op) => op.op === "delete" && op.by === "files" && op.paths.includes("src/a.ts"));
    const upsertAt = store.indexOfOp((op) => op.op === "upsert");
    assert.ok(deleteAt >= 0 && deleteAt < upsertAt, "changed file's delete must precede its upsert");
    // Only the fresh a.ts points remain: both stale points really left.
    assert.deepEqual(store.points().map((p) => p.payload.file_path), ["src/a.ts", "src/a.ts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("embed batches are capped at SYNC_BATCH_SIZE and a failed batch skips without aborting", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    mkdirSync(join(root, "src"));
    for (let i = 0; i < SYNC_BATCH_SIZE + 1; i++) {
      writeFileSync(join(root, "src", `f${String(i)}.ts`), `export function fn${String(i)}() {}\n`);
    }
    let calls = 0;
    const d: SyncDeps = {
      ...deps(root, newStore()),
      embedBatch: async (texts: string[]) => {
        calls++;
        if (calls === 1) throw new Error("embed server hiccup");
        return texts.map(() => [0.5, 0.5, 0.5]);
      },
    };
    const res = await syncCodeKnowledge(d);
    // 33 files × 2 summaries (node + file) = 66 → 3 batches (32+32+2)
    assert.equal(calls, 3); // first failed, the other two succeeded
    assert.equal(res.symbols, 17); // 17 files' node summaries; their anchors are files
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sync never throws: qdrant failures are logged and yield an empty result", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    writeFile(root, "src/a.ts", "export function alpha() {}\n");
    const store = newStore();
    const broken: QdrantLike = {
      ...store,
      async ensureCollection() { throw new Error("collection boom"); },
    };
    const res = await syncCodeKnowledge(deps(root, broken));
    // Failure is reported, not success-shaped zeros (review finding 7).
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /collection boom/);
    assert.equal(res.files, 0);
    assert.equal(store.points().length, 0, "a failed ensure must not leave a half-indexed store");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ids are deterministic across identical syncs (idempotent upsert)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    writeFile(root, "src/a.ts", "export function alpha() {}\n");
    const store = newStore();
    await syncCodeKnowledge(deps(root, store));
    const idsFirst = store.points().map((p) => p.id);

    // Second pass over the same (now indexed) state: the store's own snapshot
    // sha matches → skipped, nothing re-upserted — the upsert was already
    // idempotent.
    const store2 = newStore();
    store2.seed([indexedCodePoint("src/a.ts", sha(readFileSync(join(root, "src", "a.ts"), "utf8")))]);
    await syncCodeKnowledge(deps(root, store2));
    assert.equal(store2.upsertBatches().length, 0);

    // Third pass with a stale snapshot: same summaries → same ids.
    const store3 = newStore();
    store3.seed([indexedCodePoint("src/a.ts", "stale")]);
    await syncCodeKnowledge(deps(root, store3));
    const idsSecond = store3.points().map((p) => p.id);
    assert.deepEqual(idsSecond, idsFirst);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed embed batch keeps the previous index intact (embed before invalidate)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    const oldContent = "export function alpha() {}\n";
    writeFile(root, "src/a.ts", oldContent);
    const store = newStore();
    // Simulate the previously indexed (now stale) state.
    store.seed([indexedCodePoint("src/a.ts", "old-sha")]);
    // All embed batches fail → nothing may be deleted or upserted.
    const d: SyncDeps = {
      ...deps(root, store),
      embedBatch: async () => { throw new Error("embed server down"); },
    };
    const res = await syncCodeKnowledge(d);
    assert.equal(store.deletedFileBatches().length, 0, "old points must survive an embed failure");
    assert.equal(store.indexOfOp((op) => op.op === "upsert"), -1);
    assert.equal(store.points().length, 1, "the stale point is still stored");
    assert.equal(res.ok, true); // sync itself converged without throwing
    assert.equal(res.symbols, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fresh sync leaves a populated index (regression: upserts are not wiped by the delete)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    writeFile(root, "src/a.ts", "export function alpha() {}\nexport function beta() {}\n");
    const store = newStore();
    const first = await syncCodeKnowledge(deps(root, store));
    assert.equal(first.ok, true);
    assert.equal(first.files, 1);
    assert.equal(first.symbols, 2); // 2 node summaries; the file anchor is not a symbol
    // The collection must actually hold the freshly written points — the bug
    // left it empty after every sync.
    assert.equal(store.points().length, 3, "index must not be empty after a fresh sync");
    const stored = store.points();
    assert.ok(stored.some((p) => p.payload.file_path === "src/a.ts" && p.payload.source_kind === "code_summary" && p.payload.type === "code"));
    const idsFirst = stored.map((p) => p.id).sort();

    // The store advertises exactly what it holds, so an unchanged second sync
    // converges (skips) and the same points remain in place.
    const second = await syncCodeKnowledge(deps(root, store));
    assert.equal(second.skipped, 1);
    assert.equal(second.files, 0);
    assert.equal(store.points().length, 3, "second sync must not wipe the index");
    assert.deepEqual(store.points().map((p) => p.id).sort(), idsFirst);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a changed file's delete precedes its upsert (invariant 1)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    writeFile(root, "src/a.ts", "export function alpha() {}\n");
    const store = newStore();
    const stale = indexedCodePoint("src/a.ts", "stale-sha");
    store.seed([stale]);
    await syncCodeKnowledge(deps(root, store));
    const deleteAt = store.indexOfOp((op) => op.op === "delete" && op.by === "files" && op.paths.includes("src/a.ts"));
    const upsertAt = store.indexOfOp((op) => op.op === "upsert");
    assert.ok(deleteAt >= 0, "expected a delete for the changed file");
    assert.ok(upsertAt >= 0, "expected an upsert");
    assert.ok(deleteAt < upsertAt, "delete must precede the upsert");
    assert.ok(store.points().length > 0, "the upserted points must survive the pass");
    assert.equal(store.points().some((p) => p.id === stale.id), false, "the stale point must really be gone");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a file larger than SYNC_BATCH_SIZE is replaced atomically (never half-indexed)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    const bigLines = Array.from(
      { length: SYNC_BATCH_SIZE + 1 },
      (_v, i) => `export function big${String(i)}() {}`,
    ).join("\n") + "\n";
    writeFile(root, "src/big.ts", bigLines);
    writeFile(root, "src/small.ts", "export function small() {}\n");
    const store = newStore();
    store.seed([indexedCodePoint("src/big.ts", "stale-big"), indexedCodePoint("src/small.ts", "stale-small")]);
    const d: SyncDeps = {
      ...deps(root, store),
      // The big file's own batch embeds fine; the small file's batch fails.
      embedBatch: async (texts: string[]) => {
        if (texts.some((t) => t.includes("src/small.ts"))) throw new Error("embed hiccup");
        return texts.map(() => [0.5, 0.5, 0.5]);
      },
    };
    const res = await syncCodeKnowledge(d);
    // The >cap file is one whole batch (33 node summaries + 1 file summary): it
    // is fully replaced, never left half-indexed.
    const bigPoints = store.points().filter((p) => p.payload.file_path === "src/big.ts");
    assert.equal(bigPoints.length, SYNC_BATCH_SIZE + 2);
    assert.equal(res.symbols, SYNC_BATCH_SIZE + 1); // node summaries only
    assert.equal(res.files, 1);
    // The failed batch's file keeps its old points: an embed failure never deletes.
    assert.equal(store.deletedFileBatches().flat().includes("src/small.ts"), false);
    assert.ok(
      store.points().some((p) => p.payload.file_path === "src/small.ts" && p.payload.file_sha === "stale-small"),
      "small file's old points must survive the failed embed",
    );
    const deleteAt = store.indexOfOp((op) => op.op === "delete" && op.by === "files" && op.paths.includes("src/big.ts"));
    const upsertAt = store.indexOfOp((op) => op.op === "upsert");
    assert.ok(deleteAt >= 0 && deleteAt < upsertAt, "big file's delete must precede its upsert");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("vanished files are deleted even when nothing embeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    const store = newStore();
    store.seed([indexedCodePoint("src/gone.ts", "old-sha")]);
    const d: SyncDeps = {
      ...deps(root, store),
      embedBatch: async () => { throw new Error("embed server down"); },
    };
    await syncCodeKnowledge(d);
    assert.deepEqual(store.deletedFileBatches(), [["src/gone.ts"]]);
    assert.equal(store.points().length, 0, "the vanished file's points must really be deleted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("delete failures are non-fatal and reported in counts", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    writeFile(root, "src/a.ts", "export function alpha() {}\n");
    const store = newStore();
    const broken: QdrantLike = {
      ...store,
      async deletePointsByFiles() { throw new Error("delete boom"); },
    };
    const res = await syncCodeKnowledge(deps(root, broken));
    assert.equal(res.ok, true);
    assert.equal(res.symbols, 1); // embed+upsert still succeeded (node summary only)
    assert.equal(store.points().length, 2, "the upsert still landed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("zero-definition files do not churn as changed on every sync", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    writeFile(root, "src/docs.ts", "just prose, no definitions\n");
    const store = newStore();
    // First pass: no nodes, not in snapshot → no work.
    const first = await syncCodeKnowledge(deps(root, store));
    assert.equal(first.files, 0);
    assert.equal(store.deletedFileBatches().length, 0);
    // Second pass with a stale snapshot entry: file changed to no defs → delete.
    store.seed([indexedCodePoint("src/docs.ts", "old-sha")]);
    const second = await syncCodeKnowledge(deps(root, store));
    assert.deepEqual(store.deletedFileBatches().at(-1), ["src/docs.ts"]);
    assert.equal(store.points().length, 0, "the stale zero-def file's points are gone");
    void second;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("collection totals: cold start, converged resync, edit, vanish, and count failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    const aContent = "export function alpha() {}\n";
    const bContent = "export function beta() {}\n";
    const cContent = "export function gamma() {}\n";
    writeFile(root, "src/a.ts", aContent);
    writeFile(root, "src/b.ts", bContent);
    writeFile(root, "src/c.ts", cContent);
    const store = newStore();

    // 1. Cold start: 3 files indexed, totals match deltas
    const cold = await syncCodeKnowledge(deps(root, store));
    assert.equal(cold.ok, true);
    assert.equal(cold.files, 3);
    assert.equal(cold.symbols, 3); // 3 node summaries (file anchors are files, not symbols)
    assert.equal(cold.totalFiles, 3);
    assert.equal(cold.totalSymbols, 3);
    assert.equal(store.points().length, 6);

    // 2. Converged pass: the store's own snapshot advertises the indexed shas,
    // so the delta is 0 and the totals reflect collection inventory.
    const converged = await syncCodeKnowledge(deps(root, store));
    assert.equal(converged.ok, true);
    assert.equal(converged.files, 0); // delta
    assert.equal(converged.symbols, 0); // delta
    assert.equal(converged.totalFiles, 3); // collection total
    assert.equal(converged.totalSymbols, 3); // collection total

    // 3. Partial sync: edit a.ts to have 2 definitions (3 summaries total for a.ts)
    const aNewContent = "export function alphaOne() {}\nexport function alphaTwo() {}\n";
    writeFile(root, "src/a.ts", aNewContent);
    const edited = await syncCodeKnowledge(deps(root, store));
    assert.equal(edited.ok, true);
    assert.equal(edited.files, 1); // delta: only a.ts reindexed
    assert.equal(edited.symbols, 2); // delta: 2 node summaries for a.ts
    assert.equal(edited.totalFiles, 3); // total files still 3
    assert.equal(edited.totalSymbols, 4); // 2 for a.ts + 1 for b.ts + 1 for c.ts
    assert.equal(store.points().length, 7);

    // 4. Vanished file: delete c.ts
    rmSync(join(root, "src/c.ts"));
    const vanished = await syncCodeKnowledge(deps(root, store));
    assert.equal(vanished.ok, true);
    assert.equal(vanished.files, 0); // delta
    assert.equal(vanished.deleted, 1); // c.ts deleted
    assert.equal(vanished.totalFiles, 2); // only a.ts and b.ts remain
    assert.equal(vanished.totalSymbols, 3); // 4 - 1 = 3
    assert.equal(store.points().length, 5, "c.ts's points are really gone");

    // 5. countCodeSymbols failure degrades gracefully to undefined symbols
    const broken: QdrantLike = {
      ...store,
      async countCodeSymbols() { throw new Error("count boom"); },
    };
    const degraded = await syncCodeKnowledge(deps(root, broken));
    assert.equal(degraded.ok, true);
    assert.equal(degraded.totalFiles, 2);
    assert.equal(degraded.totalSymbols, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("large file definitions are chunked so embedBatch never exceeds SYNC_BATCH_SIZE (#16)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    // 70 functions + 1 file summary = 71 summaries.
    const manyLines = Array.from(
      { length: 70 },
      (_v, i) => `export function fn${String(i)}() {}`,
    ).join("\n") + "\n";
    writeFile(root, "src/huge.ts", manyLines);
    const store = newStore();

    const batchSizes: number[] = [];
    const d: SyncDeps = {
      ...deps(root, store),
      embedBatch: async (texts: string[]) => {
        batchSizes.push(texts.length);
        if (texts.length > SYNC_BATCH_SIZE) {
          throw new Error(`Batch size ${texts.length} exceeded SYNC_BATCH_SIZE ${SYNC_BATCH_SIZE}`);
        }
        return texts.map(() => [0.1, 0.2, 0.3]);
      },
    };

    const res = await syncCodeKnowledge(d);
    assert.equal(res.ok, true);
    assert.equal(res.files, 1);
    assert.equal(res.symbols, 70); // 70 node summaries; the file anchor is not a symbol
    // Verified: every call was <= SYNC_BATCH_SIZE (32, 32, 7)
    assert.deepEqual(batchSizes, [32, 32, 7]);
    for (const size of batchSizes) {
      assert.ok(size <= SYNC_BATCH_SIZE);
    }
    assert.equal(store.points().length, 71);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── planSync: the pure diff/group/batch planner ──────────────────────────────
// Fixtures only — no store, no filesystem.

/** A scanned file with `nodeCount` deterministic function nodes. */
function scanned(filePath: string, sha: string, nodeCount: number): ScannedFile {
  return {
    filePath,
    sha,
    nodes: Array.from({ length: nodeCount }, (_v, i) => ({
      kind: "function" as const,
      name: `fn${String(i)}`,
      filePath,
      startLine: i + 1,
      endLine: i + 1,
      exported: true,
      doc: "",
      signature: `export function fn${String(i)}()`,
    })),
  };
}

test("planSync skips unchanged shas and surfaces vanished paths", () => {
  const scan = { files: [scanned("src/a.ts", "sha-a", 2)], capped: false };
  const plan = planSync(scan, new Map([["src/a.ts", "sha-a"], ["src/gone.ts", "sha-g"]]));
  assert.deepEqual(plan.vanished, ["src/gone.ts"]);
  assert.deepEqual(plan.changed, []);
  assert.equal(plan.skipped, 1);
  assert.deepEqual(plan.batches, []);
});

test("planSync keeps a changed file's summaries contiguous and appends its file anchor", () => {
  const plan = planSync(
    { files: [scanned("src/a.ts", "new-sha", 2)], capped: false },
    new Map([["src/a.ts", "old-sha"]]),
  );
  assert.deepEqual(plan.vanished, []);
  assert.deepEqual(plan.changed.map((f) => f.filePath), ["src/a.ts"]);
  assert.equal(plan.skipped, 0);
  assert.equal(plan.batches.length, 1);
  const batch = plan.batches[0]!;
  assert.equal(batch.length, 3, "2 node summaries + the file anchor");
  assert.deepEqual(batch.map((s) => s.file.filePath), ["src/a.ts", "src/a.ts", "src/a.ts"]);
  assert.deepEqual(batch.map((s) => s.symbol), ["fn0", "fn1", undefined]);
  assert.match(batch[2]!.text, /^file src\/a\.ts — 2 definitions$/);
});

test("planSync reprocesses zero-definition files only when the snapshot knows them", () => {
  const scan = { files: [scanned("src/docs.ts", "docs-sha", 0)], capped: false };
  const cold = planSync(scan, new Map());
  assert.deepEqual(cold.changed, []);
  assert.equal(cold.skipped, 1);
  assert.deepEqual(cold.batches, []);

  const known = planSync(scan, new Map([["src/docs.ts", "old-sha"]]));
  assert.equal(known.skipped, 0);
  assert.deepEqual(known.changed.map((f) => f.filePath), ["src/docs.ts"]);
  assert.deepEqual(known.batches, [], "a zero-definition file has no summaries to batch");
});

test("planSync never splits a file across batches and an oversized group is its own batch", () => {
  const plan = planSync(
    {
      files: [
        scanned("src/f1.ts", "new-1", 3), // group of 4 summaries
        scanned("src/f2.ts", "new-2", 3), // group of 4 summaries
        scanned("src/big.ts", "new-big", SYNC_BATCH_SIZE + 1), // group of cap + 2
      ],
      capped: false,
    },
    new Map([["src/f1.ts", "old"], ["src/f2.ts", "old"], ["src/big.ts", "old"]]),
  );
  // f1 + f2 fit together (8 ≤ cap); big cannot join them and becomes its own
  // batch — never split, however large the group.
  assert.deepEqual(
    plan.batches.map((b) => [...new Set(b.map((s) => s.file.filePath))]),
    [["src/f1.ts", "src/f2.ts"], ["src/big.ts"]],
  );
  assert.equal(plan.batches[1]!.length, SYNC_BATCH_SIZE + 2, "the oversized group is never split");
  // f1's whole group stays contiguous at the head of the first batch.
  assert.deepEqual(
    plan.batches[0]!.slice(0, 4).map((s) => s.file.filePath),
    ["src/f1.ts", "src/f1.ts", "src/f1.ts", "src/f1.ts"],
  );
});
