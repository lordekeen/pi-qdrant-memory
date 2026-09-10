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
 * Code-summary node points point at the source file:line (spec §13); the file
 * pointer is only used when a line exists — file-level points (no line) fall
 * through to the existing rules (review finding 14). */
export function sourcePointer(payload: PointPayload): string {
  if (payload.file_path && payload.start_line !== undefined) {
    return `${payload.file_path}:${String(payload.start_line)}`;
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
