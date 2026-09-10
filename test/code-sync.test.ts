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

interface Recorded {
  deleted: string[][];
  upserts: Array<Array<{ id: string; payload: { file_path?: string; source_kind: string; type: string } }>>;
  snapshot: Map<string, string>;
  failDeletes: boolean;
}

function fakeQdrant() {
  const rec: Recorded = { deleted: [], upserts: [], snapshot: new Map(), failDeletes: false };
  const qdrant = {
    async ensureCollection() { return "exists" as const; },
    async upsert(_n: string, points: Array<{ id: string; payload: { file_path?: string; source_kind: string; type: string } }>) {
      rec.upserts.push(points);
    },
    async search() { return []; },
    async count() { return 0; },
    async clearCollection() {},
    async deletePointsByFiles(_n: string, paths: string[]) {
      if (rec.failDeletes) throw new Error("qdrant down");
      rec.deleted.push(paths);
    },
    async codeIndexSnapshot() { return rec.snapshot; },
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
    // First sync: snapshot empty → nothing vanished; the single changed file
    // is still invalidated before re-upsert (D6 delete-then-replace).
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
    assert.deepEqual(rec.deleted, [["src/gone.ts", "src/a.ts"]]);
    assert.equal(res.deleted, 2);
    assert.equal(res.files, 1);
    assert.equal(rec.upserts.length, 1);
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
