import { ingestItems, ensureAndGet } from "./ingest.ts";
import type { IngestDeps, IngestItem } from "./ingest.ts";
import { pointId } from "./ids.ts";
import type { QdrantPoint } from "./qdrant.ts";
import type { MemoryType, PointPayload, RuntimeDeps, SearchHit } from "./types.ts";

export type ToolResult<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_TEXT = 4000;

export async function rememberLogic(deps: RuntimeDeps, text: string, type?: MemoryType): Promise<ToolResult<PointPayload>> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "remember: text is empty" };
  if (trimmed.length > MAX_TEXT) return { ok: false, error: `remember: text too long (>${MAX_TEXT} chars)` };
  const payload: PointPayload = {
    type: type ?? "decision",
    text: trimmed,
    project_id: deps.projectId,
    ts: Date.now(),
    source_kind: "remember_tool",
  };
  try {
    // G1: the collection may not exist yet on a fresh project (e.g. the first
    // `/qdrant remember` after install) — ensure it before writing.
    await deps.qdrant.ensureCollection(deps.projectId, deps.cfg.expectedDimension);
    const vector = await deps.embed(trimmed);
    const id = pointId(trimmed, "remember_tool", "");
    await deps.qdrant.upsert(deps.projectId, [{ id, vector, payload }]);
    return { ok: true, value: payload };
  } catch (err) {
    return { ok: false, error: `remember failed: ${String(err)}` };
  }
}

export async function memorySearchLogic(
  deps: RuntimeDeps,
  query: string,
  type?: MemoryType,
  limit?: number,
): Promise<ToolResult<SearchHit[]>> {
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, error: "memory_search: query is empty" };
  const capped = Math.max(1, Math.min(limit ?? deps.cfg.maxResults, deps.cfg.maxResults));
  try {
    // G1: ensure the collection exists so the first search on a fresh project
    // does not 404 — an absent collection simply yields no hits.
    await deps.qdrant.ensureCollection(deps.projectId, deps.cfg.expectedDimension);
    const vector = await deps.embed(trimmed);
    const hits = await deps.qdrant.search(deps.projectId, vector, {
      projectId: deps.projectId,
      type,
      limit: capped,
      threshold: deps.cfg.scoreThreshold,
    });
    return { ok: true, value: hits };
  } catch (err) {
    return { ok: false, error: `memory_search failed: ${String(err)}` };
  }
}

export function normalizeDepsForTools(deps: RuntimeDeps): { ingest: IngestDeps; dim: number } {
  return { ingest: { embed: deps.embed, qdrant: deps.qdrant, projectId: deps.projectId }, dim: deps.cfg.expectedDimension };
}

export async function ingestViaItems(deps: RuntimeDeps, items: IngestItem[]): Promise<{ attempted: number; ingested: number }> {
  const { ingest, dim } = normalizeDepsForTools(deps);
  await ensureAndGet(ingest, dim);
  return ingestItems(ingest, dim, items);
}
