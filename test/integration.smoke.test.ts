import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QdrantClient } from "../src/qdrant.ts";
import { EmbeddingClient } from "../src/embeddings.ts";
import { rememberLogic, memorySearchLogic } from "../src/tools-core.ts";
import { syncCodeKnowledge } from "../src/code-sync.ts";
import type { PointPayload, RuntimeDeps } from "../src/types.ts";

const smoke = process.env.QDRANT_MEMORY_SMOKE === "1";
const o = { skip: !smoke } as const;

// Server endpoints are overridable so the smoke test can target whatever real
// servers are running locally (defaults match the shipped config defaults).
const QDRANT_URL = process.env.QDRANT_MEMORY_URL ?? "http://localhost:6333";
const EMBED_URL = process.env.QDRANT_MEMORY_EMBED_URL ?? "http://localhost:8080/v1";
const EMBED_MODEL = process.env.QDRANT_MEMORY_EMBED_MODEL ?? "nomic-embed-text";
const EMBED_DIM = Number(process.env.QDRANT_MEMORY_EMBED_DIM ?? 768);

interface RawPoint { id: string; payload: Partial<PointPayload> | null }

/** Scroll every point out of a collection through the real HTTP API, following
 * `next_page_offset` until the server stops paging. The code-memory smoke case
 * needs this to assert the on-disk index actually contains points — the bug the
 * unit tests missed was a sync that left the collection empty. */
async function scrollAll(baseUrl: string, collection: string): Promise<RawPoint[]> {
  const out: RawPoint[] = [];
  let offset: string | number | undefined;
  for (;;) {
    const body: Record<string, unknown> = { limit: 256, with_payload: true };
    if (offset !== undefined) body.offset = offset;
    const res = await fetch(`${baseUrl}/collections/${encodeURIComponent(collection)}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json() as {
      result: { points: RawPoint[]; next_page_offset?: string | number | null };
    };
    out.push(...json.result.points);
    const next = json.result.next_page_offset;
    if (next === null || next === undefined) break;
    offset = next;
  }
  return out;
}

test("end-to-end remember then search against real servers", o, async () => {
  const qdrant = new QdrantClient(QDRANT_URL, null);
  const embedder = new EmbeddingClient(EMBED_URL, EMBED_MODEL, null, EMBED_DIM);
  const projectId = `pi-mem-smoke-${Date.now().toString(36)}`;
  const rt: RuntimeDeps = {
    cfg: {
      qdrantUrl: QDRANT_URL, qdrantApiKey: null,
      embeddingBaseURL: EMBED_URL, embeddingModel: EMBED_MODEL,
      embeddingApiKey: null, expectedDimension: EMBED_DIM, scoreThreshold: 0.15, maxResults: 5, mode: "own", codeKnowledge: "off", codeScoreThreshold: 0.4,
    },
    agentDir: "/tmp/agent", cwd: "/repo", projectId,
    embed: (t) => embedder.embed(t),
    qdrant, readGlobalConfig: () => rt.cfg, writeGlobalConfig: () => {}, reloadEffectiveConfig: () => {}, print: () => {},
  };
  try {
    const saved = await rememberLogic(rt, "we decided the sync layer uses REST over gRPC", "decision");
    assert.ok(saved.ok);
    const found = await memorySearchLogic(rt, "what transport did we choose for sync?");
    assert.ok(found.ok);
    assert.ok(found.value.length >= 1, "expected at least one hit");
  } finally {
    await qdrant.clearCollection(projectId).catch(() => {});
  }
});

// Throwaway fixture files — a temp repo, never the checkout under test, so the
// assertions stay deterministic regardless of what is committed.
const FIXTURE_WIDGET = `export function parseWidgetConfig(raw) {
  return { name: raw.name };
}

export class WidgetRegistry {
  add(w) { return w; }
}
`;
const FIXTURE_PAYMENT = `export interface PaymentIntent {
  amount: number;
}

export function authorizePayment(intent) {
  return intent.amount > 0;
}
`;
const FIXTURE_RETRY = `export const RETRY_BACKOFF_MS = 250;

export function scheduleRetry(attempt) {
  return attempt * RETRY_BACKOFF_MS;
}
`;
// Same file after an edit: `scheduleRetry` disappears, `computeExponentialBackoff`
// appears — the removed symbol's point must be dropped and the file must not be wiped.
const FIXTURE_RETRY_EDITED = `export function computeExponentialBackoff(attempt) {
  return 250 ** attempt;
}
`;

test("code-memory sync populates, converges, edits and deletes against real servers", o, async () => {
  const qdrant = new QdrantClient(QDRANT_URL, null);
  const embedder = new EmbeddingClient(EMBED_URL, EMBED_MODEL, null, EMBED_DIM);
  const embedBatch = (texts: string[]): Promise<number[][]> => embedder.embedBatch(texts);
  const projectId = `pi-mem-smoke-code-${Date.now().toString(36)}`;
  const repoRoot = mkdtempSync(join(tmpdir(), "pi-mem-smoke-repo-"));
  const rt: RuntimeDeps = {
    cfg: {
      qdrantUrl: QDRANT_URL, qdrantApiKey: null,
      embeddingBaseURL: EMBED_URL, embeddingModel: EMBED_MODEL,
      embeddingApiKey: null, expectedDimension: EMBED_DIM, scoreThreshold: 0.15, maxResults: 10, mode: "own", codeKnowledge: "on", codeScoreThreshold: 0.4,
    },
    agentDir: "/tmp/agent", cwd: repoRoot, projectId,
    embed: (t) => embedder.embed(t),
    embedBatch,
    qdrant, readGlobalConfig: () => rt.cfg, writeGlobalConfig: () => {}, reloadEffectiveConfig: () => {}, print: () => {},
  };
  const sync = () => syncCodeKnowledge({ embedBatch, qdrant, projectId, expectedDimension: EMBED_DIM, repoRoot });
  const codePoints = async (): Promise<RawPoint[]> =>
    (await scrollAll(QDRANT_URL, projectId)).filter((p) => p.payload?.source_kind === "code_summary");

  try {
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "widget.ts"), FIXTURE_WIDGET);
    writeFileSync(join(repoRoot, "src", "payment.ts"), FIXTURE_PAYMENT);
    writeFileSync(join(repoRoot, "src", "retry.ts"), FIXTURE_RETRY);

    // 1. fresh sync indexes the fixture repo.
    const fresh = await sync();
    assert.ok(fresh.ok, `fresh sync ok (${JSON.stringify(fresh)})`);
    assert.ok(fresh.files >= 3, `files >= 3 (${fresh.files})`);
    assert.ok(fresh.symbols > 0, `symbols > 0 (${fresh.symbols})`);

    // 2. The collection is actually populated — the old delete-after-upsert bug
    // left it empty, so this is the guard that matters.
    const points = await codePoints();
    assert.ok(points.length > 0, "code points exist after sync");
    assert.ok(points.every((p) => p.payload?.source_kind === "code_summary"), "every point is a code_summary");
    assert.ok(points.every((p) => p.payload?.type === "code"), "every point has type=code");
    assert.ok(points.every((p) => typeof p.payload?.file_path === "string" && p.payload.file_path.length > 0), "every point has file_path");
    assert.ok(points.every((p) => typeof p.payload?.file_sha === "string" && p.payload.file_sha.length > 0), "every point has file_sha");

    // 3. A typed code search returns hits with source pointers.
    const codeFound = await memorySearchLogic(rt, "how are widget configurations parsed", "code");
    assert.ok(codeFound.ok, "code query ok");
    const codeHits = codeFound.ok ? codeFound.value : [];
    assert.ok(codeHits.length >= 1, "code query returns at least one hit");
    assert.ok(codeHits.every((h) => h.payload.type === "code"), "every code hit is a code point");
    assert.ok(codeHits.some((h) => typeof h.payload.file_path === "string" && typeof h.payload.start_line === "number"), "code hits carry file_path + start_line");

    // 4. An untyped query excludes code points (must_not), even with a
    // conversation memory in the same collection.
    const saved = await rememberLogic(rt, "we decided the sync layer uses REST over gRPC", "decision");
    assert.ok(saved.ok, "remember ok");
    const untyped = await memorySearchLogic(rt, "how are widget configurations parsed");
    assert.ok(untyped.ok, "untyped query ok");
    const untypedHits = untyped.ok ? untyped.value : [];
    assert.ok(untypedHits.every((h) => h.payload.type !== "code"), `untyped query returns no code points (${JSON.stringify(untypedHits.map((h) => h.payload.type))})`);

    // 5. An unchanged resync is a no-op — nothing re-embedded, nothing deleted.
    const countBefore = await qdrant.count(projectId);
    const resync = await sync();
    assert.ok(resync.ok && resync.files === 0 && resync.symbols === 0, `unchanged resync reindexes nothing (${JSON.stringify(resync)})`);
    assert.ok(resync.skipped >= 3, `unchanged resync skips every file (${resync.skipped})`);
    assert.ok(resync.deleted === 0, `unchanged resync deletes nothing (${resync.deleted})`);
    assert.equal(await qdrant.count(projectId), countBefore, "point count unchanged by a no-op resync");

    // 6. An edit is replaced, not wiped: the new symbol lands, the removed one's
    // point is gone, and the sha advances.
    const shaBefore = (await qdrant.codeIndexSnapshot(projectId)).get("src/retry.ts");
    writeFileSync(join(repoRoot, "src", "retry.ts"), FIXTURE_RETRY_EDITED);
    const edited = await sync();
    assert.ok(edited.ok && edited.files === 1, `edit resync touches exactly one file (${JSON.stringify(edited)})`);
    assert.notEqual((await qdrant.codeIndexSnapshot(projectId)).get("src/retry.ts"), shaBefore, "file_sha updated for the edited file");
    const retrySymbols = (await codePoints()).filter((p) => p.payload?.file_path === "src/retry.ts").map((p) => p.payload?.symbol);
    assert.ok(retrySymbols.includes("computeExponentialBackoff"), `new symbol indexed (${JSON.stringify(retrySymbols)})`);
    assert.ok(!retrySymbols.includes("scheduleRetry"), `removed symbol's point is gone (${JSON.stringify(retrySymbols)})`);
    const editedFound = await memorySearchLogic(rt, "exponential backoff computation for retries", "code");
    assert.ok(editedFound.ok && editedFound.value.some((h) => h.payload.symbol === "computeExponentialBackoff"), "new symbol is findable");

    // 7. A deleted file leaves no points behind.
    rmSync(join(repoRoot, "src", "payment.ts"));
    const removed = await sync();
    assert.ok(removed.ok, `delete resync ok (${JSON.stringify(removed)})`);
    assert.ok(removed.deleted >= 1, `delete resync reports the deletion (${removed.deleted})`);
    const orphaned = (await codePoints()).filter((p) => p.payload?.file_path === "src/payment.ts");
    assert.equal(orphaned.length, 0, "deleted file's points are gone");
  } finally {
    await qdrant.clearCollection(projectId).catch(() => {});
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
