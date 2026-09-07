import type { SearchHit } from "./types.ts";

export function renderHits(hits: SearchHit[]): string {
  if (!hits.length) return "No relevant memory found.";
  const lines = hits.map((h) => {
    // Defensive: a stored point written by another client may lack text — never
    // let one malformed payload turn a valid search into a thrown error.
    const text = typeof h.payload.text === "string" ? h.payload.text : "";
    const source = h.payload.source_entry_id
      ? `source_entry_id=${h.payload.source_entry_id}`
      : h.payload.session_id ? `session_id=${h.payload.session_id}` : "no source pointer";
    const preview = text.length > 200
      ? text.slice(0, 200) + "…"
      : text;
    return `[${h.payload.type}] score=${h.score.toFixed(2)} (${source})\n${preview}`;
  });
  return lines.join("\n\n");
}
