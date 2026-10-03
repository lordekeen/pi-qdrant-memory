import type { PointPayload, SearchHit } from "./types.ts";

/** Shared preview truncation width (DESIGN.md Layout: the one width this
 * extension ever chooses). Single source for the tool-path renderer and the
 * entry-outlinemodel. */
export const PREVIEW_MAX = 200;

/**
 * Grapheme-safe measurement (#59). `String.length` counts UTF-16 code units,
 * so it can cut mid-surrogate-pair and mid-cluster (family emoji, base +
 * combining mark), leaving a preview ending in half a character. Model- and
 * user-authored text flows through here, so cuts go by *graphemes*:
 * `Intl.Segmenter` is a Node built-in (zero dependencies). The budget stays a
 * character budget, not a layout decision — the host's width-aware
 * `visibleWidth`/`truncateToWidth` is deliberately NOT used, because the
 * outline model is width-agnostic. For ASCII, grapheme count === code-unit
 * count, so every previously pinned output stays byte-identical.
 */
let graphemeSegmenter: Intl.Segmenter | undefined;

function toGraphemes(text: string): string[] {
  if (graphemeSegmenter === undefined) {
    // SAFETY: Intl.Segmenter is a stable Node built-in; the guard only
    // protects exotic runtimes without it, where the fallback splits by code
    // point (never mid-surrogate-pair) instead of by grapheme cluster.
    if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
      graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    }
  }
  const out: string[] = [];
  if (graphemeSegmenter) {
    for (const seg of graphemeSegmenter.segment(text)) out.push(seg.segment);
  } else {
    for (const codePoint of text) out.push(codePoint);
  }
  return out;
}

/** Grapheme count — the `String.length` replacement for width/alignment math. */
export function graphemeLength(text: string): number {
  return toGraphemes(text).length;
}

/** Cut to at most `max` graphemes, never mid-cluster or mid-surrogate-pair. */
export function truncateGraphemes(text: string, max: number): string {
  const units = toGraphemes(text);
  return units.length <= max ? text : units.slice(0, max).join("");
}

/** `String.prototype.padEnd` by grapheme count instead of code units. */
export function padEndGraphemes(text: string, width: number): string {
  const n = graphemeLength(text);
  return n >= width ? text : `${text}${" ".repeat(width - n)}`;
}

/** Truncate to a collapsed preview, appending `…` only when truncated. */
export function truncatePreview(text: string, max: number = PREVIEW_MAX): string {
  return graphemeLength(text) > max ? `${truncateGraphemes(text, max)}…` : text;
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

export function renderHits(hits: SearchHit[], totalCount?: number): string {
  const count = totalCount ?? (hits as { totalCount?: number }).totalCount;
  if (!hits.length) {
    if (count === 0) return "No memories stored yet for this project.";
    if (count !== undefined && count > 0) {
      return `No memories matched query above scoreThreshold (total stored: ${count}).`;
    }
    return "No relevant memory found.";
  }
  const lines = hits.map((h) => {
    // Defensive: a stored point written by another client may lack text — never
    // let one malformed payload turn a valid search into a thrown error.
    const text = typeof h.payload.text === "string" ? h.payload.text : "";
    const source = sourcePointer(h.payload);
    const tsStr = typeof h.payload.ts === "number" && !Number.isNaN(h.payload.ts)
      ? new Date(h.payload.ts).toISOString()
      : "";
    const tsPart = tsStr ? ` (${tsStr})` : "";
    return `[${h.payload.type}] score=${h.score.toFixed(2)}${tsPart} (${source})\n${text}`;
  });
  return lines.join("\n\n");
}
