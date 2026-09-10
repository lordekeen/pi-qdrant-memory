/**
 * Code-memory sync engine (spec §9): repo scan → Qdrant snapshot → per-file
 * diff → delete-by-file_path invalidation → batched embed → upsert.
 *
 * Qdrant is the cache (D5): payloads carry file_path + file_sha so unchanged
 * files cost nothing and no local cache file exists. Every failure is
 * contained and logged — a failed sync never throws and never corrupts the
 * existing index.
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
  /** Files (re)indexed in this pass. */
  files: number;
  /** Summaries embedded (node + file points). */
  symbols: number;
  /** Files skipped because their sha was unchanged. */
  skipped: number;
  /** Points invalidated (changed + vanished files). */
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
 * One convergent sync pass. Resolves with counts; rejects nothing except
 * programmer errors — all runtime failures (Qdrant down, embed errors) are
 * logged non-fatally and leave the previous index intact.
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
    const deleted = [...snapshot.keys()].filter((p) => !currentPaths.has(p));
    const changed = scan.files.filter((f) => snapshot.get(f.filePath) !== f.sha);
    const skipped = scan.files.length - changed.length;

    // Invalidation first (spec D6): stale points for changed + vanished files
    // are gone before any new points land.
    const toInvalidate = [...deleted, ...changed.map((f) => f.filePath)];
    if (toInvalidate.length) {
      await deps.qdrant.deletePointsByFiles(deps.projectId, toInvalidate);
    }

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
    for (let i = 0; i < pending.length; i += SYNC_BATCH_SIZE) {
      const batch = pending.slice(i, i + SYNC_BATCH_SIZE);
      let vectors: number[][];
      try {
        vectors = await deps.embedBatch(batch.map((s) => s.text));
      } catch (err) {
        console.error(`pi-qdrant-memory: code sync embed batch failed (non-fatal, skipped): ${String(err)}`);
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
      } catch (err) {
        console.error(`pi-qdrant-memory: code sync upsert failed (non-fatal, skipped): ${String(err)}`);
      }
    }

    return { files: changed.length, symbols, skipped, deleted: toInvalidate.length };
  } catch (err) {
    console.error(`pi-qdrant-memory: code sync failed (non-fatal): ${String(err)}`);
    return { files: 0, symbols: 0, skipped: 0, deleted: 0 };
  }
}
