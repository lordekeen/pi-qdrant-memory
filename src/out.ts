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
  /** Present only while the code-memory feature is wired (registration-time
   * codeKnowledge = on); omitted entirely when off. */
  codeMemory?: CodeMemoryHealth;
  detail: {
    collection: string;
    qdrantUrl: string;
    model: string;
    dimension: number;
    threshold: number;
    maxResults: number;
  };
}
export interface CodeMemoryHealth { state: "off" | "syncing" | "synced" | "error"; files?: number; symbols?: number; error?: string; }
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

// ── Settings scope surfacing ─────────────────────────────────────────────────

/** Render a config value for display. `null` is the literal `"null"`; numbers
 * keep their JSON form (`String(v)`, never `toFixed`). */
export function displayValue(v: string | number | null): string {
  return v === null ? "null" : typeof v === "string" ? v : String(v);
}

export interface SettingsScopeRow {
  key: string;
  value: string | number | null;
  globalValue: string | number | null;
  overridden: boolean;
}

/**
 * Shared scope annotation for one settings row. `noOverrideText` carries the
 * one wording difference between the two surfaces (usage: "inherited from
 * global"; form pick labels: "global").
 */
export function settingsScopeLabel(r: SettingsScopeRow, noOverrideText = "global"): string {
  const scope = r.overridden
    ? `this project; global: ${displayValue(r.globalValue)}`
    : noOverrideText;
  return `${r.key} = ${displayValue(r.value)} (${scope})`;
}

/** Bare `/qdrant-settings` usage: the scope rule, both absolute file paths, and
 * this project's allowlisted rows with scope + inherited values. */
export function settingsUsageText(p: { projectPath: string; globalPath: string; rows: SettingsScopeRow[] }): string {
  return [
    "settings: usage — /qdrant-settings opens the form; /qdrant-settings <key> <value> sets a field.",
    `          codeKnowledge and codeScoreThreshold are per project (${p.projectPath});`,
    `          the other keys are global (${p.globalPath}).`,
    `          this project: ${p.rows.map((r) => settingsScopeLabel(r, "inherited from global")).join("; ")}`,
  ].join("\n");
}

/** Allowlisted set confirmation (names this project and the global fallback). */
export function settingsUpdatedText(field: string, value: string | number, globalValue: string | number): string {
  return `settings: ${field} = ${String(value)} (this project; global: ${String(globalValue)})`;
}

/** The nine non-allowlisted keys: today's confirmation with a scope clause. */
export function settingsGlobalUpdatedText(field: string): string {
  return `settings: ${field} updated (global config; reloaded at runtime)`;
}

/** Allowlisted clear confirmation (names the global value now in effect). */
export function settingsOverrideClearedText(field: string, globalValue: string | number): string {
  return `settings: ${field} override cleared (now using global: ${String(globalValue)})`;
}

/** Form select option that clears an allowlisted override. */
export function resetOptionLabel(globalValue: string | number): string {
  return `default (inherit global: ${String(globalValue)})`;
}

/** Form numeric input prompt for an allowlisted field (accepts typed `default`). */
export function formNumericPrompt(key: string, globalValue: string | number): string {
  return `${key} (number; "default" inherits global: ${String(globalValue)})`;
}

/** Form save confirmation: names the destination file (and, for allowlisted
 * keys, the global fallback), keeping the existing "run again" tail. */
export function formSaveMessage(
  key: string,
  next: string | number | null,
  prev: string | number | null,
  dest: "project" | "global",
  globalValue?: string | number | null,
): string {
  const tail = `(was ${displayValue(prev)}; run /qdrant-settings again to edit another field)`;
  const body = dest === "project"
    ? `${key} = ${displayValue(next)} → this project's settings file (global: ${displayValue(globalValue ?? null)})`
    : `${key} = ${displayValue(next)} → the global config file`;
  return `${body} ${tail}`;
}

/** Form clear confirmation: names the global value now in effect. */
export function formClearMessage(key: string, globalValue: string | number | null): string {
  return `${key} returns to the global value (${displayValue(globalValue)})`;
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
  code: "muted",
};

export function typeRole(type: MemoryType): OutlineRole { return TYPE_ROLE[type]; }

const GLYPH: Record<StatusState, string> = { ok: "✓", warn: "!", err: "✗" };
const STATE_ROLE: Record<StatusState, OutlineRole> = { ok: "success", warn: "warning", err: "error" };

/** Zero-hit search copy — one plain non-expandable line (DESIGN.md search-results). */
export const EMPTY_SEARCH_TEXT = "No relevant memory found.";

/** Mid-session codeKnowledge flip notice (spec §12) — direction-aware because
 * the reload consequence differs: the tool registers on on-flips and
 * unregisters on off-flips. Indexing itself never needs a reload
 * (/qdrant-index-code). */
export function codeMemoryReloadNotice(next: "off" | "on"): string {
  return next === "on"
    ? "code memory: takes effect at the next session start — the code_memory tool registers on reload. Run /qdrant-index-code to index the current session's code right away."
    : "code memory: turns off at the next session start — the code_memory tool unregisters on reload.";
}

/** /qdrant-index-code result line (spec §10.1). */
export function codeMemorySyncMessage(r: { files: number; symbols: number; deleted: number }): string {
  return `code memory: ${String(r.files)} files · ${String(r.symbols)} symbols indexed (${String(r.deleted)} points replaced)`;
}

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
  const cm = health.codeMemory;
  if (cm) {
    if (cm.state === "off") {
      out.push({ spans: [s("code memory: "), s("off", "muted")] });
    } else if (cm.state === "syncing") {
      out.push({ spans: [s("code memory: "), s("on (syncing…)", "dim")] });
    } else if (cm.state === "error") {
      // A failed sync must not render as success (review finding 8).
      out.push({ spans: [s("code memory: "), s(`${GLYPH.err} sync failed`, STATE_ROLE.err)] });
    } else {
      const counts = cm.files !== undefined && cm.symbols !== undefined
        ? `${String(cm.files)} files · ${String(cm.symbols)} symbols`
        : "indexed";
      out.push({ spans: [s("code memory: "), s(`${GLYPH.ok} `, STATE_ROLE.ok), s(counts)] });
    }
  }
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
