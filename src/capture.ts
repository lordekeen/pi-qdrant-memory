import { ingestItems } from "./ingest.ts";
import type { QdrantLike } from "./qdrant.ts";
import type { PointPayload } from "./types.ts";

export interface CaptureDeps {
  embed: (t: string) => Promise<number[]>;
  qdrant: QdrantLike;
  projectId: string;
}

export function summaryPayload(text: string, projectId: string, sessionId: string, ts: number): PointPayload {
  return {
    type: "session_summary",
    text,
    project_id: projectId,
    session_id: sessionId,
    ts,
    source_kind: "own_capture",
  };
}

export async function captureAtCompaction(
  deps: CaptureDeps,
  dim: number,
  summaryText: string,
  sessionId: string,
  ts: number,
): Promise<{ attempted: number; ingested: number }> {
  const trimmed = summaryText.trim();
  if (!trimmed) return { attempted: 0, ingested: 0 };
  const p = summaryPayload(trimmed, deps.projectId, sessionId, ts);
  try {
    return await ingestItems(deps, dim, [{
      text: p.text, sourceKind: p.source_kind, contextId: sessionId, payload: p,
    }]);
  } catch (err) {
    console.error(`pi-qdrant-memory: capture at compaction failed (non-fatal): ${String(err)}`);
    return { attempted: 1, ingested: 0 };
  }
}

export async function autoSnapshot(
  deps: CaptureDeps,
  dim: number,
  snapshotText: string,
  sessionId: string,
  ts: number,
): Promise<void> {
  const trimmed = snapshotText.trim();
  if (!trimmed) return;
  const p = summaryPayload(trimmed, deps.projectId, sessionId, ts);
  try {
    await ingestItems(deps, dim, [{
      text: p.text, sourceKind: p.source_kind, contextId: sessionId, payload: p,
    }]);
  } catch (err) {
    console.error(`pi-qdrant-memory: auto snapshot failed (non-fatal): ${String(err)}`);
  }
}
