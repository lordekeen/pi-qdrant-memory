/**
 * Lazy TUI entry renderer for the `qdrant-memory` custom entry type (DESIGN.md).
 *
 * Plain-node runs never resolve pi-tui / pi-coding-agent, so this module must
 * not touch them at import time: both are loaded through guarded dynamic
 * imports and the renderer returns `undefined` until they resolve (pi then
 * skips the row).
 *
 * The renderer is a dumb mapper: content + style roles come from `renderOut`
 * (src/out.ts, fully unit-tested); here each role becomes a host-theme slot.
 * Every entry — /qdrant-status included — renders as one multi-line styled
 * `Text` (DESIGN.md: no cards, no background fills, no boxes, no self-drawn
 * shapes). Only collapsed search summaries append a muted expand hint.
 */
import { renderOut } from "./out.ts";
import type { OutEntry, OutLine, OutlineRole } from "./out.ts";

export interface RendererTheme {
  fg(slot: string, text: string): string;
  bold(text: string): string;
}

export interface RendererOptions {
  expanded?: boolean;
  /**
   * Component ctor override for unit tests. Production always passes only
   * `{ expanded }`, so Text resolves from the lazy pi-tui import below.
   */
  TextCtor?: TextCtor;
}

const EXPAND_HINT_FALLBACK = "enter to expand";
const EXPAND_KEYBINDING = "app.tools.expand";

/** The slice of a pi-tui component this renderer produces. */
export interface EntryComponent {
  render(width: number): string[];
  invalidate(): void;
}

interface TextCtor {
  new (text?: string, paddingX?: number, paddingY?: number): EntryComponent;
}

let Text: TextCtor | undefined;
let keyHint: ((id: string, fallback: string) => string) | undefined;

let loading: Promise<void> | undefined;
/** Kick off the guarded dynamic imports; safe to call repeatedly. */
export function loadRendererModules(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      try {
        // SAFETY: pi's loader aliases these packages at runtime; only the small
        // surface above is ambient here, so the loaded module is cast to it.
        const tui = (await import("@earendil-works/pi-tui")) as unknown as { Text?: TextCtor };
        Text = tui.Text;
      } catch { /* pi-tui unavailable (plain node); renderer stays inactive */ }
      try {
        // SAFETY: keyHint's signature is ambient (see src/pi-coding-agent.d.ts).
        const agent = (await import("@earendil-works/pi-coding-agent")) as unknown as { keyHint?: typeof keyHint };
        keyHint = agent.keyHint;
      } catch { /* no keyHint; fallback text is used */ }
    })();
  }
  return loading;
}

function applyRole(span: { text: string; role?: string }, theme: RendererTheme): string {
  const role = span.role;
  if (!role || role === "default") return span.text;
  if (role === "bold") return theme.bold(span.text);
  try { return theme.fg(role, span.text); } catch { return span.text; }
}

function styledLine(line: OutLine, theme: RendererTheme): string {
  return line.spans.map((sp) => applyRole(sp, theme)).join("");
}

function styledLines(lines: OutLine[], theme: RendererTheme): string[] {
  return lines.map((l) => styledLine(l, theme));
}

/**
 * One muted `(enter to expand)` fragment when a collapsed search summary hides
 * the hits. Status is never expandable (DESIGN.md status) — nothing else gets
 * a hint.
 */
function searchExpandHint(entry: OutEntry, expanded: boolean): string {
  if (expanded) return "";
  if (entry.kind !== "search" || entry.hits.length === 0) return "";
  let hint = EXPAND_HINT_FALLBACK;
  if (keyHint) {
    try { hint = keyHint(EXPAND_KEYBINDING, EXPAND_HINT_FALLBACK); } catch { /* fallback */ }
  }
  return ` (${hint})`;
}

/** Append the muted expand hint to the collapsed search summary line. */
function withSearchHint(linesIn: OutLine[], entry: OutEntry, expanded: boolean): OutLine[] {
  const hint = searchExpandHint(entry, expanded);
  if (!hint || linesIn.length === 0) return linesIn;
  const lines = [...linesIn];
  const last = lines.at(-1)!;
  lines[lines.length - 1] = { spans: [...last.spans, { text: hint, role: "muted" as OutlineRole }] };
  return lines;
}

/**
 * Render one custom entry to a pi-tui component, or `undefined` when pi-tui has
 * not resolved (pi then skips the row). Never throws.
 */
export function renderEntryComponent(entryData: unknown, options?: RendererOptions, theme?: RendererTheme): EntryComponent | undefined {
  void loadRendererModules();
  // Ctor seam: tests inject a fake via options; pi only ever passes { expanded },
  // so production resolves Text from the lazy pi-tui import.
  const TextCtor = options?.TextCtor ?? Text;
  if (!TextCtor || !theme) return undefined;
  const entry = entryData as OutEntry | undefined;
  if (!entry || typeof entry !== "object" || typeof (entry as { kind?: unknown }).kind !== "string") return undefined;
  const expanded = options?.expanded ?? false;
  const lines = renderOut(entry, { expanded });
  const out = withSearchHint(lines, entry, expanded);
  try {
    return new TextCtor(styledLines(out, theme).join("\n"));
  } catch {
    return undefined;
  }
}
