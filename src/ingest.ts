import { artifactToPayload } from "./blackhole.ts";
import type { BlackholeArtifact } from "./blackhole.ts";
import { pointId } from "./ids.ts";
import type { QdrantLike, QdrantPoint } from "./qdrant.ts";
import type { PointPayload, SourceKind } from "./types.ts";

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
  qdrant: QdrantLike;
  projectId: string;
}

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
  await ensureAndGet(deps, dim);
  const points: QdrantPoint[] = [];
  let ingested = 0;
  for (const item of items) {
    try {
      const vector = await deps.embed(item.text);
      const id = pointId(item.text, item.sourceKind, item.contextId);
      points.push({ id, vector, payload: { ...item.payload, text: item.text } as PointPayload });
      ingested++;
    } catch (err) {
      console.error(`pi-qdrant-memory: ingest skipped (embed failed): ${String(err)}`);
    }
  }
  if (points.length) {
    try {
      await deps.qdrant.upsert(deps.projectId, points);
    } catch (err) {
      console.error(`pi-qdrant-memory: upsert failed: ${String(err)}`);
      ingested = 0;
    }
  }
  return { attempted: items.length, ingested };
}
