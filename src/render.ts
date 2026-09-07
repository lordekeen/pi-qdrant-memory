import type { SearchHit } from "./types.ts";

export function renderHits(hits: SearchHit[]): string {
  if (!hits.length) return "No relevant memory found.";
  const lines = hits.map((h) => {
    const source = h.payload.source_entry_id
      ? `source_entry_id=${h.payload.source_entry_id}`
      : h.payload.session_id ? `session_id=${h.payload.session_id}` : "no source pointer";
    const preview = h.payload.text.length > 200
      ? h.payload.text.slice(0, 200) + "…"
      : h.payload.text;
    return `[${h.payload.type}] score=${h.score.toFixed(2)} (${source})\n${preview}`;
  });
  return lines.join("\n\n");
}
