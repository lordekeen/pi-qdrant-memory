import type { PointPayload, SearchHit } from "./types.ts";

/** Source pointer for a hit's payload — single source shared by tool text + entry outlines. */
export function sourcePointer(payload: PointPayload): string {
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
    const preview = text.length > 200
      ? text.slice(0, 200) + "…"
      : text;
    return `[${h.payload.type}] score=${h.score.toFixed(2)} (${source})\n${preview}`;
  });
  return lines.join("\n\n");
}
