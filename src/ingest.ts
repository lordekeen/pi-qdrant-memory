import { artifactToPayload } from "./blackhole.ts";
import type { BlackholeArtifact } from "./blackhole.ts";
import { pointId } from "./ids.ts";
import type { QdrantLike } from "./qdrant.ts";
import type { PointPayload, SourceKind } from "./types.ts";
import { applyWrites } from "./writes.ts";

/**
 * An item ready for ingestion. `payload` intentionally excludes `text` — the
 * ingest pipeline injects the canonical `text` (= `item.text`) into the stored
 * point payload so search results always render the artifact text. `sourceKind`
 * + `contextId` drive the deterministic point id (see module map).
 */
export interface IngestItem {
  text: string;
  sourceKind: SourceKind;
  contextId: string;
  payload: Omit<PointPayload, "text" | "source_kind"> & { source_kind: SourceKind };
}

export interface IngestDeps {
  embed: (text: string) => Promise<number[]>;
  embedBatch?: (texts: string[]) => Promise<number[][]>;
  qdrant: QdrantLike;
  projectId: string;
}

/**
 * Ensure the project collection at `dim` under the throwing dimension policy.
 * Kept as the ingest module's public ensure contract (tests import it); the
 * `ingestItems` pipeline itself lets `applyWrites` own the ensure-before-write
 * ordering, after the first successful embed.
 */
export async function ensureAndGet(deps: IngestDeps, dim: number): Promise<void> {
  await deps.qdrant.ensureCollection(deps.projectId, dim);
}

export function artifactToIngestItem(a: BlackholeArtifact, projectId: string, ts: number): IngestItem {
  const p = artifactToPayload(a, projectId, ts);
  return { text: p.text, sourceKind: p.source_kind, contextId: p.source_entry_id ?? p.session_id ?? "", payload: p };
}

export async function ingestItems(
  deps: IngestDeps,
  dim: number,
  items: IngestItem[],
): Promise<{ attempted: number; ingested: number }> {
  const itemsWithIds = items.map((item) => ({
    item,
    id: pointId(item.text, item.sourceKind, item.contextId),
  }));

  let needed = itemsWithIds;
  if (deps.qdrant.existingPointIds) {
    try {
      const existing = await deps.qdrant.existingPointIds(deps.projectId, itemsWithIds.map((x) => x.id));
      if (existing.size > 0) {
        needed = itemsWithIds.filter((x) => !existing.has(x.id));
      }
    } catch {
      // Non-fatal: fall back to processing all items
    }
  }

  if (!needed.length) {
    return { attempted: items.length, ingested: 0 };
  }

  // One batch: embed (chunked at the shared cap, or per item without a batch
  // client) → ensure → supersede-delete → one upsert of every survivor. The
  // supersede ids are derived from the items that actually embedded, so a
  // failed chunk never deletes a revision it could not replace.
  const report = await applyWrites(
    {
      embed: deps.embed,
      embedBatch: deps.embedBatch,
      qdrant: deps.qdrant,
      projectId: deps.projectId,
      dimension: dim,
    },
    [{
      items: needed.map((x) => ({ id: x.id, text: x.item.text, payload: x.item.payload })),
      invalidate: "source-entry-ids",
    }],
  );

  const outcome = report.batches[0];
  if (report.error !== undefined) {
    // The ensure is fatal by contract — previously it threw out of this
    // function; the caller's sentence lives here now.
    console.error(`pi-qdrant-memory: ingest failed (non-fatal): ${report.error}`);
    return { attempted: items.length, ingested: 0 };
  }
  if (outcome) {
    for (const error of outcome.embedErrors) {
      // The sentence names the route the module actually took: a chunked
      // embedBatch request, or the per-item `embed` fallback.
      console.error(deps.embedBatch
        ? `pi-qdrant-memory: ingest batch skipped (embed failed): ${error}`
        : `pi-qdrant-memory: ingest skipped (embed failed): ${error}`);
    }
    if (outcome.invalidateError !== undefined) {
      console.error(`pi-qdrant-memory: supersede delete failed (non-fatal): ${outcome.invalidateError}`);
    }
    if (outcome.upsertError !== undefined) {
      console.error(`pi-qdrant-memory: upsert failed: ${outcome.upsertError}`);
    }
  }
  // `report.written` only counts points whose upsert succeeded, so a failed
  // upsert yields 0 exactly as before.
  return { attempted: items.length, ingested: report.written };
}
