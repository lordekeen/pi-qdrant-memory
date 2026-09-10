/**
 * Code-memory sync engine (spec §9): repo scan → Qdrant snapshot → per-file
 * diff → batched embed → invalidate+upsert only files whose embeddings
 * succeeded.
 *
 * Qdrant is the cache (D5): payloads carry file_path + file_sha so unchanged
 * files cost nothing and no local cache file exists. Failure containment
 * contract (review fix): invalidation of a changed file happens only AFTER its
 * replacements are embedded — a failed embed batch leaves those files' previous
 * points intact, and the next sync re-converges (the snapshot still shows the
 * old sha). Vanished files are always deleted (nothing to embed).
 *
 * The sync never throws: `ok: false` propagates the top-level failure so the
 * command/status surfaces can report it (spec §10.1/§14) instead of rendering
 * success-shaped zeros.
 */
import { pointId } from "./ids.ts";
import { scanRepo, summaryFor, fileSummaryFor, MAX_FILES } from "./codescan.ts";
import type { ScannedFile } from "./codescan.ts";
import type { QdrantLike, QdrantPoint } from "./qdrant.ts";
import type { PointPayload } from "./types.ts";

/** Summaries per embed/upsert request (spec D9). */
export const SYNC_BATCH_SIZE = 32;

export interface SyncDeps {
  embedBatch: (texts: string[]) => Promise<number[][]>;
  qdrant: QdrantLike;
  projectId: string;
  /** Collection = projectId (same collection as conversation memories). */
  expectedDimension: number;
  repoRoot: string;
}

export interface SyncResult {
  ok: boolean;
  /** Failure reason when ok is false (Qdrant unreachable, …). */
  error?: string;
  /** Files (re)indexed in this pass. */
  files: number;
  /** Summaries embedded (node + file points). */
  symbols: number;
  /** Files skipped because their sha was unchanged. */
  skipped: number;
  /** File paths invalidated (changed + vanished files). */
  deleted: number;
}


interface PendingSummary {
  text: string;
  file: ScannedFile;
  symbol?: string;
  startLine?: number;
  endLine?: number;
}

/**
 * One convergent sync pass. Resolves with a result that distinguishes success
 * from failure; runtime failures never throw out of this function.
 */
export async function syncCodeKnowledge(deps: SyncDeps): Promise<SyncResult> {
  try {
    await deps.qdrant.ensureCollection(deps.projectId, deps.expectedDimension);
    const scan = scanRepo(deps.repoRoot);
    if (scan.capped) {
      console.error(`pi-qdrant-memory: code sync hit the ${String(MAX_FILES)}-file cap — some files were not indexed`);
    }
    const snapshot = await deps.qdrant.codeIndexSnapshot(deps.projectId);

    const currentPaths = new Set(scan.files.map((f) => f.filePath));
    const vanished = [...snapshot.keys()].filter((p) => !currentPaths.has(p));
    // A file is "changed" when its sha differs from the indexed one. Files with
    // zero definitions never produce points; they are only reprocessed when the
    // snapshot knows them (they previously had defs) — otherwise they would
    // churn as "changed" on every sync (debugger finding 9).
    const changed = scan.files.filter((f) =>
      snapshot.get(f.filePath) !== f.sha && (f.nodes.length > 0 || snapshot.has(f.filePath)));
    const skipped = scan.files.length - changed.length;

    // Embed FIRST, invalidate after: only files whose replacements are fully
    // embedded get their old points deleted (spec §9 containment contract).
    const ts = Date.now();
    const pending: PendingSummary[] = [];
    for (const file of changed) {
      for (const node of file.nodes) {
        pending.push({
          text: summaryFor(node),
          file,
          symbol: node.name,
          startLine: node.startLine,
          endLine: node.endLine,
        });
      }
      const fileSummary = fileSummaryFor(file);
      if (fileSummary) {
        pending.push({ text: fileSummary, file });
      }
    }

    let symbols = 0;
    const embeddedFiles = new Set<string>();
    for (let i = 0; i < pending.length; i += SYNC_BATCH_SIZE) {
      const batch = pending.slice(i, i + SYNC_BATCH_SIZE);
      let vectors: number[][];
      try {
        vectors = await deps.embedBatch(batch.map((s) => s.text));
      } catch (err) {
        // Skip the batch; the files' previous points stay untouched and the
        // next sync retries them (snapshot still shows the old sha).
        console.error(`pi-qdrant-memory: code sync embed batch failed (non-fatal, will retry next sync): ${String(err)}`);
        continue;
      }
      const points: QdrantPoint[] = batch.map((s, k) => {
        const payload: PointPayload = {
          type: "code",
          text: s.text,
          project_id: deps.projectId,
          ts,
          source_kind: "code_summary",
          file_path: s.file.filePath,
          file_sha: s.file.sha,
          ...(s.symbol !== undefined ? { symbol: s.symbol } : {}),
          ...(s.startLine !== undefined ? { start_line: s.startLine } : {}),
          ...(s.endLine !== undefined ? { end_line: s.endLine } : {}),
        };
        return { id: pointId(s.text, "code_summary", s.file.filePath), vector: vectors[k]!, payload };
      });
      try {
        await deps.qdrant.upsert(deps.projectId, points);
        symbols += points.length;
        for (const s of batch) embeddedFiles.add(s.file.filePath);
      } catch (err) {
        console.error(`pi-qdrant-memory: code sync upsert failed (non-fatal, will retry next sync): ${String(err)}`);
      }
    }

    // Invalidate only now: vanished files, changed files that were fully
    // re-embedded, and changed files that now have zero definitions (nothing
    // to embed — their stale points go immediately). Files whose embed failed
    // keep their old points.
    const toInvalidate = [
      ...vanished,
      ...changed
        .filter((f) => f.nodes.length === 0 || embeddedFiles.has(f.filePath))
        .map((f) => f.filePath),
    ];
    if (toInvalidate.length) {
      // Delete failures are tolerated (spec §8.2): the real client already
      // logs non-fatally; a raw throw here must not flip the sync to failure —
      // the next sync re-converges from the snapshot.
      try {
        await deps.qdrant.deletePointsByFiles(deps.projectId, toInvalidate);
      } catch (err) {
        console.error(`pi-qdrant-memory: code sync delete failed (non-fatal): ${String(err)}`);
      }
    }

    return { ok: true, files: embeddedFiles.size, symbols, skipped, deleted: toInvalidate.length };
  } catch (err) {
    // Top-level failure (Qdrant down, scan aborted): report it instead of a
    // success-shaped zero — the command emits an error entry and the status
    // row shows failure (spec §10.1/§14, review findings 7/8).
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`pi-qdrant-memory: code sync failed (non-fatal): ${reason}`);
    return { ok: false, error: reason, files: 0, symbols: 0, skipped: 0, deleted: 0 };
  }
}

