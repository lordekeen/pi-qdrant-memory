/**
 * code-sync tests — fake QdrantLike + fake embedBatch; every phase of the
 * diff (unchanged skip / changed replace / vanished delete) and the failure
 * containment contract (spec §9) is pinned here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncCodeKnowledge, SYNC_BATCH_SIZE } from "../src/code-sync.ts";
import type { SyncDeps } from "../src/code-sync.ts";
import { createHash } from "node:crypto";

interface StoredPoint {
  file_path?: string;
  file_sha?: string;
  source_kind: string;
  type: string;
}

interface Recorded {
  deleted: string[][];
  upserts: Array<Array<{ id: string; payload: StoredPoint }>>;
  snapshot: Map<string, string>;
  failDeletes: boolean;
  failCount?: boolean;
  /** Simulated point store: point id → payload, so delete-by-file_path is real
   * and a delete after an upsert is observable (the original bug). */
  store: Map<string, StoredPoint>;
  /** Ordered operation timeline — pins per-file delete-before-upsert. */
  ops: Array<{ op: "delete"; paths: string[] } | { op: "upsert"; ids: string[] }>;
}

function fakeQdrant() {
  const rec: Recorded = {
    deleted: [], upserts: [], snapshot: new Map(), failDeletes: false,
    store: new Map(), ops: [],
  };
  const qdrant = {
    async ensureCollection() { return "exists" as const; },
    async upsert(_n: string, points: Array<{ id: string; payload: StoredPoint }>) {
      rec.upserts.push(points);
      for (const p of points) rec.store.set(p.id, p.payload);
      rec.ops.push({ op: "upsert", ids: points.map((p) => p.id) });
    },
    async search() { return []; },
    async count() { return 0; },
    async clearCollection() {},
    async deletePointsByFiles(_n: string, paths: string[]) {
      if (rec.failDeletes) throw new Error("qdrant down");
      rec.deleted.push([...paths]);
      rec.ops.push({ op: "delete", paths: [...paths] });
      for (const [id, p] of rec.store) {
        if (p.file_path !== undefined && paths.includes(p.file_path)) rec.store.delete(id);
      }
    },
    async codeIndexSnapshot() { return rec.snapshot; },
    async countBySourceKind(_n: string, kind: string) {
      if (rec.failCount) throw new Error("count boom");
      return [...rec.store.values()].filter((p) => p.source_kind === kind).length;
    },
  };
  return { rec, qdrant };
}

function fakeEmbed() {
  return async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]);
}

function deps(root: string, qdrant: object): SyncDeps {
  return {
    embedBatch: fakeEmbed(),
    qdrant: qdrant as SyncDeps["qdrant"],
    projectId: "pi-mem-abc",
    expectedDimension: 3,
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
    const { rec, qdrant } = fakeQdrant();
    const res = await syncCodeKnowledge(deps(root, qdrant));
    // First sync: snapshot empty → nothing vanished; the single changed file is
    // embedded, then its (empty) prior points are deleted by file_path, then its
    // new points are upserted — delete before upsert.
    assert.deepEqual(rec.deleted, [["src/a.ts"]]);
    assert.equal(res.deleted, 1);
    assert.equal(res.files, 1);
    assert.equal(res.symbols, 2); // node summary + file summary
    assert.equal(res.skipped, 0);
    const points = rec.upserts[0]!;
    assert.equal(points.length, 2);
    for (const p of points) {
      assert.equal(p.payload.source_kind, "code_summary");
      assert.equal(p.payload.type, "code");
      assert.equal(p.payload.file_path, "src/a.ts");
    }
    // The freshly upserted points must survive the pass (delete precedes upsert).
    assert.equal(rec.store.size, 2);
    const deleteAt = rec.ops.findIndex((o) => o.op === "delete");
    const upsertAt = rec.ops.findIndex((o) => o.op === "upsert");
    assert.ok(deleteAt >= 0 && upsertAt >= 0 && deleteAt < upsertAt);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unchanged file is skipped entirely (no delete, no upsert)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    const content = "export function alpha() {}\n";
    writeFile(root, "src/a.ts", content);
    const { rec, qdrant } = fakeQdrant();
    rec.snapshot.set("src/a.ts", sha(content));
    const res = await syncCodeKnowledge(deps(root, qdrant));
    assert.equal(res.files, 0);
    assert.equal(res.skipped, 1);
    assert.equal(res.symbols, 0);
    assert.equal(rec.deleted.length, 0);
    assert.equal(rec.upserts.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("changed file is deleted then re-upserted; vanished file is deleted", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    writeFile(root, "src/a.ts", "export function alpha() {}\n");
    const { rec, qdrant } = fakeQdrant();
    rec.snapshot.set("src/a.ts", "stale-sha");
    rec.snapshot.set("src/gone.ts", "old-sha");
    const res = await syncCodeKnowledge(deps(root, qdrant));
    // Changed-file deletes arrive with their batch; vanished-file deletes arrive
    // as the trailing extras call. Assert the set + ordering, not call grouping.
    assert.deepEqual([...new Set(rec.deleted.flat())].sort(), ["src/a.ts", "src/gone.ts"]);
    assert.equal(res.deleted, 2);
    assert.equal(res.files, 1);
    assert.equal(rec.upserts.length, 1);
    const deleteAt = rec.ops.findIndex((o) => o.op === "delete" && o.paths.includes("src/a.ts"));
    const upsertAt = rec.ops.findIndex((o) => o.op === "upsert");
    assert.ok(deleteAt >= 0 && deleteAt < upsertAt, "changed file's delete must precede its upsert");
    assert.equal(rec.store.size, 2);
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
      ...deps(root, fakeQdrant().qdrant),
      embedBatch: async (texts: string[]) => {
        calls++;
        if (calls === 1) throw new Error("embed server hiccup");
        return texts.map(() => [0.5, 0.5, 0.5]);
      },
    };
    const res = await syncCodeKnowledge(d);
    // 33 files × 2 summaries (node + file) = 66 → 3 batches (32+32+2)
    assert.equal(calls, 3); // first failed, the other two succeeded
    assert.equal(res.symbols, 34);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sync never throws: qdrant failures are logged and yield an empty result", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    writeFile(root, "src/a.ts", "export function alpha() {}\n");
    const { qdrant } = fakeQdrant();
    const broken = {
      ...qdrant,
      async ensureCollection() { throw new Error("collection boom"); },
    };
    const res = await syncCodeKnowledge(deps(root, broken as unknown as SyncDeps["qdrant"]));
    // Failure is reported, not success-shaped zeros (review finding 7).
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /collection boom/);
    assert.equal(res.files, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ids are deterministic across identical syncs (idempotent upsert)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    writeFile(root, "src/a.ts", "export function alpha() {}\n");
    const { qdrant, rec } = fakeQdrant();
    await syncCodeKnowledge(deps(root, qdrant));
    const idsFirst = rec.upserts[0]!.map((p) => p.id);

    // Second pass over the same (now recorded) state: snapshot sha matches →
    // skipped, nothing re-upserted — the upsert was already idempotent.
    const { qdrant: q2, rec: rec2 } = fakeQdrant();
    rec2.snapshot.set("src/a.ts", sha(readFileSync(join(root, "src", "a.ts"), "utf8")));
    await syncCodeKnowledge(deps(root, q2));
    assert.equal(rec2.upserts.length, 0);

    // Third pass with a stale snapshot: same summaries → same ids.
    const { qdrant: q3, rec: rec3 } = fakeQdrant();
    rec3.snapshot.set("src/a.ts", "stale");
    await syncCodeKnowledge(deps(root, q3));
    const idsSecond = rec3.upserts[0]!.map((p) => p.id);
    assert.deepEqual(idsSecond, idsFirst);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed embed batch keeps the previous index intact (embed before invalidate)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    const oldContent = "export function alpha() {}\n";
    writeFile(root, "src/a.ts", oldContent);
    const { rec, qdrant } = fakeQdrant();
    // Simulate the previously indexed (now stale) state.
    rec.snapshot.set("src/a.ts", "old-sha");
    // All embed batches fail → nothing may be deleted or upserted.
    const d: SyncDeps = {
      ...deps(root, qdrant),
      embedBatch: async () => { throw new Error("embed server down"); },
    };
    const res = await syncCodeKnowledge(d);
    assert.equal(rec.deleted.length, 0, "old points must survive an embed failure");
    assert.equal(rec.upserts.length, 0);
    assert.equal(res.ok, true); // sync itself converged without throwing
    assert.equal(res.symbols, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fresh sync leaves a populated index (regression: upserts are not wiped by the delete)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    writeFile(root, "src/a.ts", "export function alpha() {}\nexport function beta() {}\n");
    const { rec, qdrant } = fakeQdrant();
    const first = await syncCodeKnowledge(deps(root, qdrant));
    assert.equal(first.ok, true);
    assert.equal(first.files, 1);
    assert.equal(first.symbols, 3); // 2 node summaries + 1 file summary
    // The collection must actually hold the freshly written points — the bug
    // left it empty after every sync.
    assert.equal(rec.store.size, 3, "index must not be empty after a fresh sync");
    const stored = [...rec.store.values()];
    assert.ok(stored.some((p) => p.file_path === "src/a.ts" && p.source_kind === "code_summary" && p.type === "code"));
    const idsFirst = [...rec.store.keys()].sort();

    // Emulate the snapshot the index now advertises (new shas), then sync
    // unchanged: it converges (skips) and the same points remain in place.
    for (const p of rec.store.values()) {
      if (p.file_path !== undefined && p.file_sha !== undefined) rec.snapshot.set(p.file_path, p.file_sha);
    }
    const second = await syncCodeKnowledge(deps(root, qdrant));
    assert.equal(second.skipped, 1);
    assert.equal(second.files, 0);
    assert.ok(rec.store.size > 0, "second sync must not wipe the index");
    assert.deepEqual([...rec.store.keys()].sort(), idsFirst);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a changed file's delete precedes its upsert (invariant 1)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    writeFile(root, "src/a.ts", "export function alpha() {}\n");
    const { rec, qdrant } = fakeQdrant();
    rec.snapshot.set("src/a.ts", "stale-sha");
    await syncCodeKnowledge(deps(root, qdrant));
    const deleteAt = rec.ops.findIndex((o) => o.op === "delete" && o.paths.includes("src/a.ts"));
    const upsertAt = rec.ops.findIndex((o) => o.op === "upsert");
    assert.ok(deleteAt >= 0, "expected a delete for the changed file");
    assert.ok(upsertAt >= 0, "expected an upsert");
    assert.ok(deleteAt < upsertAt, "delete must precede the upsert");
    assert.ok(rec.store.size > 0, "the upserted points must survive the pass");
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
    const { rec, qdrant } = fakeQdrant();
    rec.snapshot.set("src/big.ts", "stale-big");
    rec.snapshot.set("src/small.ts", "stale-small");
    rec.store.set("old-small", { file_path: "src/small.ts", source_kind: "code_summary", type: "code" });
    const d: SyncDeps = {
      ...deps(root, qdrant),
      // The big file's own batch embeds fine; the small file's batch fails.
      embedBatch: async (texts: string[]) => {
        if (texts.some((t) => t.includes("src/small.ts"))) throw new Error("embed hiccup");
        return texts.map(() => [0.5, 0.5, 0.5]);
      },
    };
    const res = await syncCodeKnowledge(d);
    // The >cap file is one whole batch (33 node summaries + 1 file summary): it
    // is fully replaced, never left half-indexed.
    const bigPoints = [...rec.store.values()].filter((p) => p.file_path === "src/big.ts");
    assert.equal(bigPoints.length, SYNC_BATCH_SIZE + 2);
    assert.equal(res.symbols, SYNC_BATCH_SIZE + 2);
    assert.equal(res.files, 1);
    // The failed batch's file keeps its old points: an embed failure never deletes.
    assert.equal(rec.deleted.flat().includes("src/small.ts"), false);
    assert.ok(rec.store.has("old-small"), "small file's old points must survive the failed embed");
    const deleteAt = rec.ops.findIndex((o) => o.op === "delete" && o.paths.includes("src/big.ts"));
    const upsertAt = rec.ops.findIndex((o) => o.op === "upsert");
    assert.ok(deleteAt >= 0 && deleteAt < upsertAt, "big file's delete must precede its upsert");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("vanished files are deleted even when nothing embeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    const { rec, qdrant } = fakeQdrant();
    rec.snapshot.set("src/gone.ts", "old-sha");
    const d: SyncDeps = {
      ...deps(root, qdrant),
      embedBatch: async () => { throw new Error("embed server down"); },
    };
    await syncCodeKnowledge(d);
    assert.deepEqual(rec.deleted, [["src/gone.ts"]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("delete failures are non-fatal and reported in counts", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    writeFile(root, "src/a.ts", "export function alpha() {}\n");
    const { qdrant } = fakeQdrant();
    (qdrant as { deletePointsByFiles: (n: string, paths: string[]) => Promise<void> }).deletePointsByFiles =
      async (_n: string, _paths: string[]) => { throw new Error("delete boom"); };
    const res = await syncCodeKnowledge(deps(root, qdrant));
    assert.equal(res.ok, true);
    assert.equal(res.symbols, 2); // embed+upsert still succeeded
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("zero-definition files do not churn as changed on every sync", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-sync-"));
  try {
    writeFile(root, "src/docs.ts", "just prose, no definitions\n");
    const { rec, qdrant } = fakeQdrant();
    // First pass: no nodes, not in snapshot → no work.
    const first = await syncCodeKnowledge(deps(root, qdrant));
    assert.equal(first.files, 0);
    assert.equal(rec.deleted.length, 0);
    // Second pass with a stale snapshot entry: file changed to no defs → delete.
    rec.snapshot.set("src/docs.ts", "old-sha");
    const second = await syncCodeKnowledge(deps(root, qdrant));
    assert.deepEqual(rec.deleted.at(-1), ["src/docs.ts"]);
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
    const { rec, qdrant } = fakeQdrant();

    // 1. Cold start: 3 files indexed, totals match deltas
    const cold = await syncCodeKnowledge(deps(root, qdrant));
    assert.equal(cold.ok, true);
    assert.equal(cold.files, 3);
    assert.equal(cold.symbols, 6); // 3 node + 3 file summaries
    assert.equal(cold.totalFiles, 3);
    assert.equal(cold.totalSymbols, 6);

    // Update snapshot to advertise what is stored in rec.store
    for (const p of rec.store.values()) {
      if (p.file_path && p.file_sha) rec.snapshot.set(p.file_path, p.file_sha);
    }

    // 2. Converged pass: delta is 0, but totals reflect collection inventory
    const converged = await syncCodeKnowledge(deps(root, qdrant));
    assert.equal(converged.ok, true);
    assert.equal(converged.files, 0); // delta
    assert.equal(converged.symbols, 0); // delta
    assert.equal(converged.totalFiles, 3); // collection total
    assert.equal(converged.totalSymbols, 6); // collection total

    // 3. Partial sync: edit a.ts to have 2 definitions (3 summaries total for a.ts)
    const aNewContent = "export function alphaOne() {}\nexport function alphaTwo() {}\n";
    writeFile(root, "src/a.ts", aNewContent);
    const edited = await syncCodeKnowledge(deps(root, qdrant));
    assert.equal(edited.ok, true);
    assert.equal(edited.files, 1); // delta: only a.ts reindexed
    assert.equal(edited.symbols, 3); // delta: 2 nodes + 1 file summary for a.ts
    assert.equal(edited.totalFiles, 3); // total files still 3
    assert.equal(edited.totalSymbols, 7); // 3 for a.ts + 2 for b.ts + 2 for c.ts

    for (const p of rec.store.values()) {
      if (p.file_path && p.file_sha) rec.snapshot.set(p.file_path, p.file_sha);
    }

    // 4. Vanished file: delete c.ts
    rmSync(join(root, "src/c.ts"));
    const vanished = await syncCodeKnowledge(deps(root, qdrant));
    assert.equal(vanished.ok, true);
    assert.equal(vanished.files, 0); // delta
    assert.equal(vanished.deleted, 1); // c.ts deleted
    assert.equal(vanished.totalFiles, 2); // only a.ts and b.ts remain
    assert.equal(vanished.totalSymbols, 5); // 7 - 2 = 5

    for (const p of rec.store.values()) {
      if (p.file_path && p.file_sha) rec.snapshot.set(p.file_path, p.file_sha);
    }

    // 5. countBySourceKind failure degrades gracefully to undefined symbols
    rec.failCount = true;
    const degraded = await syncCodeKnowledge(deps(root, qdrant));
    assert.equal(degraded.ok, true);
    assert.equal(degraded.totalFiles, 2);
    assert.equal(degraded.totalSymbols, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
