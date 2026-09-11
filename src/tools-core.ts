import { ingestItems, ensureAndGet } from "./ingest.ts";
import type { IngestDeps, IngestItem } from "./ingest.ts";
import { pointId } from "./ids.ts";
import type { MemoryType, PointPayload, SearchHit, ToolDeps } from "./types.ts";

export type ToolResult<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_TEXT = 4000;

export async function rememberLogic(deps: ToolDeps, text: string, type?: MemoryType): Promise<ToolResult<PointPayload>> {
  const trimmed = text.trim();
  // Bare reason text only: the caller owns the final message (tool wrappers
  // prepend `<tool> failed:`, command handlers their own voice), so the reason
  // never carries a tool name or a `failed:` prefix of its own.
  if (!trimmed) return { ok: false, error: "text is empty" };
  if (trimmed.length > MAX_TEXT) return { ok: false, error: `text too long (>${MAX_TEXT} chars)` };
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
    // NOTE on idempotency: the canonical point id is (text, "remember_tool", "")
    // — `type` is deliberately not part of it. Re-saving the same text with a
    // different type UPSERTS over the earlier point rather than creating a
    // second one; that is the intended idempotent-write contract (DESIGN.md).
    await deps.qdrant.ensureCollection(deps.projectId, deps.cfg.expectedDimension);
    const vector = await deps.embed(trimmed);
    const id = pointId(trimmed, "remember_tool", "");
    await deps.qdrant.upsert(deps.projectId, [{ id, vector, payload }]);
    return { ok: true, value: payload };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function memorySearchLogic(
  deps: ToolDeps,
  query: string,
  type?: MemoryType,
  limit?: number,
): Promise<ToolResult<SearchHit[]>> {
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, error: "query is empty" };
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
      // Code summaries need a higher similarity bar than conversation
      // memories (spec D7) — the two surfaces use their own thresholds.
      threshold: type === "code" ? deps.cfg.codeScoreThreshold : deps.cfg.scoreThreshold,
    });
    return { ok: true, value: hits };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export function normalizeDepsForTools(deps: ToolDeps): { ingest: IngestDeps; dim: number } {
  return { ingest: { embed: deps.embed, qdrant: deps.qdrant, projectId: deps.projectId }, dim: deps.cfg.expectedDimension };
}

export async function ingestViaItems(deps: ToolDeps, items: IngestItem[]): Promise<{ attempted: number; ingested: number }> {
  const { ingest, dim } = normalizeDepsForTools(deps);
  await ensureAndGet(ingest, dim);
  return ingestItems(ingest, dim, items);
}
