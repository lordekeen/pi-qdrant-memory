import type { PointPayload, SearchHit } from "./types.ts";

/** Shared preview truncation width (DESIGN.md Layout: the one width this
 * extension ever chooses). Single source for the tool-path renderer and the
 * entry-outlinemodel. */
export const PREVIEW_MAX = 200;

/** Truncate to a collapsed preview, appending `…` only when truncated. */
export function truncatePreview(text: string, max: number = PREVIEW_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Source pointer for a hit's payload — single source shared by tool text + entry outlines.
 * When the payload has a `file_path` it is the pointer: `file_path:start_line` for
 * symbol-level code summaries, or the bare `file_path` for file-level summaries
 * that carry no `start_line` (spec §13). This deliberately supersedes the earlier
 * rule (review finding 14) that a path without a line fell all the way through to
 * "no source pointer" — the path is useful on its own. Only when there is no
 * `file_path` does it fall back to `source_entry_id` / `session_id` / "no source pointer". */
export function sourcePointer(payload: PointPayload): string {
  if (payload.file_path) {
    return payload.start_line !== undefined
      ? `${payload.file_path}:${String(payload.start_line)}`
      : payload.file_path;
  }
  if (payload.source_entry_id) return `source_entry_id=${payload.source_entry_id}`;
  if (payload.session_id) return `session_id=${payload.session_id}`;
  return "no source pointer";
}

export function renderHits(hits: SearchHit[]): string {
  if (!hits.length) return "No relevant memory found.";
  const lines = hits.map((h) => {
    // Defensive: a stored point written by another client may lack text — never
    // let one malformed payload turn a valid search into a thrown error.
    const text = typeof h.payload.text === "string" ? h.payload.text : "";
    const source = sourcePointer(h.payload);
    const preview = truncatePreview(text);
    return `[${h.payload.type}] score=${h.score.toFixed(2)} (${source})\n${preview}`;
  });
  return lines.join("\n\n");
}
