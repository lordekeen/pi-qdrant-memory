/**
 * Typed slash-command output model (DESIGN.md "content-first chrome").
 *
 * Pure module: no pi imports, no network. Handlers emit `OutEntry` payloads;
 * `renderOut` turns one into plain lines of styled *spans* (role → host-theme
 * slot applied later by the TUI renderer). Unit tests exercise `renderOut`
 * directly under plain node.
 */
import type { MemoryType, PointPayload, SearchHit } from "./types.ts";
import { sourcePointer, truncatePreview } from "./render.ts";

// ── Entry model ──────────────────────────────────────────────────────────────

export interface MessageEntry { kind: "message"; text: string; }
export interface ErrorEntry { kind: "error"; text: string; }
export interface HelpRow { cmd: string; desc: string; }
export interface MemoryHeader { mode: string; collection: string; /** Stored points in the project collection; footer-only, omitted on status/help entries. */ points?: number; }
export interface HelpEntry { kind: "help"; header: MemoryHeader; rows: HelpRow[]; }

export type StatusState = "ok" | "warn" | "err";
export interface StatusHealth {
  mode: string;
  qdrant:
    | { state: "ok"; collection: string; points: number }
    | { state: "warn"; collection: string }
    | { state: "err" };
  embeddings: { state: "ok" } | { state: "err" };
  detail: {
    collection: string;
    qdrantUrl: string;
    model: string;
    dimension: number;
    threshold: number;
    maxResults: number;
  };
}
export interface StatusEntry { kind: "status"; health: StatusHealth; }

export interface SearchHitView { type: MemoryType; score: number; pointer: string; text: string; }
export interface SearchEntry { kind: "search"; hits: SearchHitView[]; }

export type OutEntry = MessageEntry | ErrorEntry | HelpEntry | StatusEntry | SearchEntry;

// ── Builders ─────────────────────────────────────────────────────────────────

export function message(text: string): MessageEntry { return { kind: "message", text }; }
export function errorEntry(text: string): ErrorEntry { return { kind: "error", text }; }

/**
 * The header line shared with the footer statusline (DESIGN.md footer-status).
 * Footer variant (with `points`): `🧠 Memory (N): <mode> (<collection>)`.
 * Entry variant (no `points`, used by /qdrant-status and /qdrant-help — the
 * status block already reports the count on its own qdrant row):
 * `🧠 Memory: <mode> (<collection>)`.
 */
export function memoryHeaderText(h: MemoryHeader): string {
  return h.points === undefined
    ? `🧠 Memory: ${h.mode} (${h.collection})`
    : `🧠 Memory (${h.points}): ${h.mode} (${h.collection})`;
}

export function helpEntry(rows: HelpRow[], header: MemoryHeader): HelpEntry { return { kind: "help", header, rows }; }
export function statusEntry(health: StatusHealth): StatusEntry { return { kind: "status", health }; }
export function searchEntry(hits: SearchHitView[]): SearchEntry { return { kind: "search", hits }; }

/** Source pointer for a hit — shared with the tool-path renderer (render.ts). */
export function hitPointer(payload: PointPayload): string { return sourcePointer(payload); }

export function searchHitView(hit: SearchHit): SearchHitView {
  // Defensive: a stored point written by another client may lack text — never
  // let one malformed payload turn a valid search into a thrown error.
  const text = typeof hit.payload.text === "string" ? hit.payload.text : "";
  return { type: hit.payload.type, score: hit.score, pointer: hitPointer(hit.payload), text };
}

// ── Roles & outline ──────────────────────────────────────────────────────────

/** Role names double as pi host-theme slots; renderer maps role → theme.fg. */
export type OutlineRole =
  | "default" | "bold" | "success" | "warning" | "error" | "accent" | "dim" | "muted";

export interface Span { text: string; role?: OutlineRole; }
export interface OutLine { spans: Span[]; }

const s = (text: string, role?: OutlineRole): Span => ({ text, role });

const TYPE_ROLE: Record<MemoryType, OutlineRole> = {
  decision: "accent",
  fact: "success",
  constraint: "warning",
  preference: "dim",
  session_summary: "muted",
};

export function typeRole(type: MemoryType): OutlineRole { return TYPE_ROLE[type]; }

const GLYPH: Record<StatusState, string> = { ok: "✓", warn: "!", err: "✗" };
const STATE_ROLE: Record<StatusState, OutlineRole> = { ok: "success", warn: "warning", err: "error" };

/** Zero-hit search copy — one plain non-expandable line (DESIGN.md search-results). */
export const EMPTY_SEARCH_TEXT = "No relevant memory found.";

const PREVIEW_MAX = 200;
/** The one width this extension ever chooses (DESIGN.md Layout + search-results). */
function previewText(text: string): string {
  return truncatePreview(text, PREVIEW_MAX);
}

// ── Outline rendering ────────────────────────────────────────────────────────

export interface OutlineOptions { expanded?: boolean; }

function statusLines(health: StatusHealth): OutLine[] {
  const out: OutLine[] = [];
  // Header mirrors the footer statusline (DESIGN.md footer-status) — mode and
  // collection live here; there is no separate `memory:` label row.
  out.push({ spans: [s(memoryHeaderText({ mode: health.mode, collection: health.detail.collection }))] });
  const q = health.qdrant;
  if (q.state === "ok") {
    out.push({ spans: [s("qdrant: "), s(`${GLYPH.ok} `, STATE_ROLE.ok), s(`reachable · ${q.points} points`)] });
  } else if (q.state === "warn") {
    out.push({ spans: [s("qdrant: "), s(`${GLYPH.warn} collection ${q.collection} does not exist yet`, STATE_ROLE.warn)] });
  } else {
    out.push({ spans: [s("qdrant: "), s(`${GLYPH.err} NOT reachable`, STATE_ROLE.err)] });
  }
  const e = health.embeddings;
  out.push({
    spans: e.state === "ok"
      ? [s("embeddings: "), s(`${GLYPH.ok} `, STATE_ROLE.ok), s("reachable")]
      : [s("embeddings: "), s(`${GLYPH.err} NOT reachable`, STATE_ROLE.err)],
  });
  return out;
}

function statusDetailLines(d: StatusHealth["detail"]): OutLine[] {
  const dim = d.dimension;
  return [
    { spans: [s("qdrant url: "), s(d.qdrantUrl)] },
    { spans: [s("model: "), s(d.model)] },
    { spans: [s("dimension: "), s(String(dim)), s(" · threshold: "), s(String(d.threshold)), s(" · maxResults: "), s(String(d.maxResults))] },
  ];
}

function searchCollapsed(hits: SearchHitView[]): OutLine[] {
  const top = hits[0];
  if (!top) return [{ spans: [s(EMPTY_SEARCH_TEXT)] }];
  const spans: Span[] = [
    s(`${hits.length} ${hits.length === 1 ? "result" : "results"} · top `),
    s(`[${top.type}]`, typeRole(top.type)),
    s(` ${top.score.toFixed(2)}`),
  ];
  // Collapsed preview of the top hit — default/unadorned knowledge text,
  // truncated only here, never when expanded (DESIGN.md search-results).
  const preview = previewText(top.text);
  if (preview) spans.push(s(" · "), s(preview));
  return [{ spans }];
}

function searchExpanded(hits: SearchHitView[]): OutLine[] {
  const lines: OutLine[] = [];
  hits.forEach((h, i) => {
    if (i > 0) lines.push({ spans: [] }); // blank line between hits — no rules
    lines.push({ spans: [s(`[${h.type}] `, typeRole(h.type)), s(`${h.score.toFixed(2)} `), s(`(${h.pointer})`, "dim")] });
    lines.push({ spans: [s(h.text)] });
  });
  return lines;
}

function helpLines(rows: HelpRow[]): OutLine[] {
  // Align to the longest command; the host truncates at the terminal edge — the
  // extension never chooses a truncating width (DESIGN.md Layout).
  const width = Math.max(...rows.map((r) => r.cmd.length), 0) + 2;
  const lines: OutLine[] = [{ spans: [s("commands", "bold")] }];
  for (const r of rows) {
    lines.push({ spans: [s(r.cmd.padEnd(width)), s(r.desc, "dim")] });
  }
  return lines;
}

/**
 * Render an entry to outline lines. Roles are fully resolved here (including
 * per-memory-type colors); the TUI renderer only maps role → theme slot.
 */
export function renderOut(e: OutEntry, options: OutlineOptions = {}): OutLine[] {
  switch (e.kind) {
    case "message":
      return e.text.split("\n").map((line) => ({ spans: [s(line)] }));
    case "error":
      return e.text.split("\n").map((line) => ({ spans: [s(line, "error")] }));
    case "help": {
      // Branded header (footer-style) then the command list (DESIGN.md).
      const header: OutLine = { spans: [s(memoryHeaderText(e.header))] };
      return [header, ...helpLines(e.rows)];
    }
    case "status":
      // One plain always-visible block, help-style — no collapse/expand, no
      // card fill: header + subsystem rows then config detail in the same
      // label column (DESIGN.md status). Rows show regardless of the host's
      // expanded flag.
      return [...statusLines(e.health), ...statusDetailLines(e.health.detail)];
    case "search":
      return options.expanded ? searchExpanded(e.hits) : searchCollapsed(e.hits);
  }
}

/** Plain-text projection (spans concatenated) — used by the print fallback and test fakes. */
export function outText(e: OutEntry, options: OutlineOptions = {}): string {
  return renderOut(e, options).map((l) => l.spans.map((sp) => sp.text).join("")).join("\n");
}
