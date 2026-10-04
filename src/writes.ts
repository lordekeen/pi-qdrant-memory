/**
 * The one owner of the write protocol the four write paths used to
 * re-implement: embed → ensure → invalidate → upsert, per batch, in order.
 *
 * Contract (the invariants callers rely on):
 * - Never throws and never logs: every failure is data in the returned report,
 *   so callers keep their own `console.error` sentences and result mapping
 *   (AGENTS.md §6 — graceful degradation).
 * - Embed before ensure: a failed embed must never create or recreate a
 *   collection (the order `rememberLogic` documents, OI-001). Ensure runs once
 *   per call, right before the first upsert whose batch embedded successfully;
 *   collection readiness is the adapter's own memo (`QdrantClient.ensured`),
 *   not a caller-owned cache.
 * - An ensure failure is fatal: later batches are not attempted (nothing can
 *   be written into an unverified collection), and the reason is reported as
 *   `report.error`.
 * - Delete-before-upsert within a batch. A failed invalidation is tolerated
 *   (the upsert still runs) and reported per batch.
 * - A failed embed chunk skips that chunk's items; a failed upsert discards
 *   only that batch's write count; later batches continue.
 * - A whole-file batch (`invalidation: "files"`) is embedded all-or-nothing:
 *   deleting a file and then writing a strict subset of its points would leave
 *   the file advertised with its new sha while some summaries are missing —
 *   the next sync would skip it forever. A file's replacement therefore
 *   either completes or is retried next pass, never half-applied.
 */
import type { QdrantLike, QdrantPoint } from "./qdrant.ts";
import type { PointPayload } from "./types.ts";

/** Items per embed request — the one cap every write path shares (code-sync
 *  re-exports it as `SYNC_BATCH_SIZE`). */
export const WRITE_CHUNK_SIZE = 32;

/** One point to write: the module embeds `text` and stores it as the
 *  payload's canonical `text` (callers never set it). */
export interface WriteItem {
  /** Deterministic point id (see `ids.ts`). */
  id: string;
  /** Text to embed; stored as `payload.text`. */
  text: string;
  /** Payload without `text` — the module injects the canonical text. */
  payload: Omit<PointPayload, "text">;
}

/**
 * How a batch's stale points are invalidated before its upsert:
 * - `"files"`: the `file_path` values carried by the batch's successfully
 *   embedded items are deleted first (code-sync file replacement). The batch
 *   is embedded all-or-nothing (see the module contract).
 * - `"source-entry-ids"`: the `source_entry_id` values carried by the
 *   successfully embedded items are deleted first (ingest supersede), so a
 *   failed chunk never deletes the revision it could not replace.
 * - omitted: nothing is deleted.
 */
export type WriteInvalidation = "files" | "source-entry-ids";

export interface WriteBatch {
  items: WriteItem[];
  invalidate?: WriteInvalidation;
}

/** One batch's outcome, in the order the batches were applied. */
export interface WriteBatchOutcome {
  /** Points upserted for this batch (0 when its embed or upsert failed). */
  written: number;
  /** One entry per embed chunk whose request threw (that chunk's items were
   *  skipped; a whole-file batch is then skipped entirely). */
  embedErrors: string[];
  /** The batch's invalidation threw — non-fatal: the upsert still ran. */
  invalidateError?: string;
  /** The batch's upsert threw — this batch's write count is discarded. */
  upsertError?: string;
}

export interface WriteReport {
  /** Points upserted across every batch. */
  written: number;
  /** Batches that wrote nothing (embed failure, upsert failure, or a fatal
   *  ensure abort). Batches never attempted after a fatal abort don't count. */
  failed: number;
  /** Embed chunks that threw (their items were skipped). */
  embedFailed: number;
  /** Batches whose invalidation threw. */
  invalidateFailed: number;
  /** Batches whose upsert threw. */
  upsertFailed: number;
  /** Fatal error (the collection ensure) — later batches were not attempted. */
  error?: string;
  /** One outcome per attempted batch, in input order. */
  batches: WriteBatchOutcome[];
}

export interface WriteDeps {
  /** Per-text embed; used when `embedBatch` is absent (ingest's fallback). */
  embed?: (text: string) => Promise<number[]>;
  /** Chunked embed; preferred when present. Chunks never exceed the cap. */
  embedBatch?: (texts: string[]) => Promise<number[][]>;
  qdrant: QdrantLike;
  projectId: string;
  /** Collection vector size. */
  dimension: number;
  /** Dimension-mismatch policy: `"recreate"` only for interactive writes
   *  (remember); background paths keep the throwing `"error"` default. */
  onDimensionMismatch?: "error" | "recreate";
}

/** Non-empty string payload fields, deduplicated in first-seen order. */
function uniqueStrings(values: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) out.add(value);
  }
  return [...out];
}

/**
 * Apply the batches sequentially under the write protocol. Resolves with a
 * report; never throws and never logs.
 */
export async function applyWrites(deps: WriteDeps, batches: WriteBatch[]): Promise<WriteReport> {
  const report: WriteReport = {
    written: 0,
    failed: 0,
    embedFailed: 0,
    invalidateFailed: 0,
    upsertFailed: 0,
    batches: [],
  };
  // The collection is ensured once, after the first successful embed — the
  // order `rememberLogic` documents. Readiness lives in the adapter, which
  // memoizes it (`QdrantClient.ensured`).
  let ensured = false;

  for (const batch of batches) {
    const outcome: WriteBatchOutcome = { written: 0, embedErrors: [] };
    report.batches.push(outcome);
    // A whole-file batch must not be half-replaced (see the module contract).
    const wholeFile = batch.invalidate === "files";
    const embedded: Array<{ item: WriteItem; vector: number[] }> = [];

    // 1. Embed, chunked at the shared cap. A failed chunk skips its items; a
    //    whole-file batch fails as a unit at the first failed chunk.
    if (deps.embedBatch) {
      for (let offset = 0; offset < batch.items.length; offset += WRITE_CHUNK_SIZE) {
        const chunk = batch.items.slice(offset, offset + WRITE_CHUNK_SIZE);
        let vectors: number[][];
        try {
          vectors = await deps.embedBatch(chunk.map((item) => item.text));
        } catch (err) {
          outcome.embedErrors.push(String(err));
          if (wholeFile) break;
          continue;
        }
        for (let i = 0; i < chunk.length; i++) {
          embedded.push({ item: chunk[i]!, vector: vectors[i]! });
        }
      }
    } else if (deps.embed) {
      for (const item of batch.items) {
        try {
          embedded.push({ item, vector: await deps.embed(item.text) });
        } catch (err) {
          outcome.embedErrors.push(String(err));
          if (wholeFile) break;
        }
      }
    } else {
      outcome.embedErrors.push("no embed client configured");
    }
    report.embedFailed += outcome.embedErrors.length;
    if (wholeFile && outcome.embedErrors.length) embedded.length = 0;
    if (!embedded.length) {
      // Nothing embedded: no ensure, no delete, no upsert for this batch.
      report.failed++;
      continue;
    }

    // 2. Ensure the collection once, before the first write.
    if (!ensured) {
      try {
        await deps.qdrant.ensureCollection(deps.projectId, deps.dimension, {
          onDimensionMismatch: deps.onDimensionMismatch ?? "error",
        });
        ensured = true;
      } catch (err) {
        // Fatal: no later batch can write either.
        report.error = String(err);
        report.failed++;
        return report;
      }
    }

    // 3. Invalidate this batch's own stale points BEFORE its upsert, derived
    //    from the items that actually embedded (a failed chunk must never
    //    delete a revision it cannot replace).
    if (batch.invalidate === "files") {
      const paths = uniqueStrings(embedded.map(({ item }) => item.payload.file_path));
      if (paths.length) {
        try {
          await deps.qdrant.deletePointsByFiles(deps.projectId, paths);
        } catch (err) {
          // Tolerated: still upsert; the next sync re-converges.
          outcome.invalidateError = String(err);
        }
      }
    } else if (batch.invalidate === "source-entry-ids") {
      const ids = uniqueStrings(embedded.map(({ item }) => item.payload.source_entry_id));
      if (ids.length) {
        try {
          await deps.qdrant.deletePointsBySourceEntryIds(deps.projectId, ids);
        } catch (err) {
          outcome.invalidateError = String(err);
        }
      }
    }
    if (outcome.invalidateError !== undefined) report.invalidateFailed++;

    // 4. Upsert the survivors; a failed upsert discards this batch's count.
    const points: QdrantPoint[] = embedded.map(({ item, vector }) => ({
      id: item.id,
      vector,
      payload: { ...item.payload, text: item.text },
    }));
    try {
      await deps.qdrant.upsert(deps.projectId, points);
      outcome.written = points.length;
      report.written += points.length;
    } catch (err) {
      outcome.upsertError = String(err);
      report.upsertFailed++;
      report.failed++;
    }
  }
  return report;
}
