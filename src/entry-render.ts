/**
 * Lazy TUI entry renderer for the `qdrant-memory` custom entry type (DESIGN.md).
 *
 * The renderer is a dumb mapper: content + style roles come from `renderOut`
 * (src/out.ts, fully unit-tested); here each role becomes a host-theme slot.
 * Every entry — /qdrant status included — renders as one multi-line styled
 * `Text` (DESIGN.md: no cards, no background fills, no boxes, no self-drawn
 * shapes). Only collapsed search summaries append the host's expand hint
 * (dim key + muted description, coloured by the host's own `keyHint`).
 */
import { renderOut } from "./out.ts";
import type { OutEntry, OutLine } from "./out.ts";
import { hostModules, loadHostModules } from "./host-bridge.ts";
import type { TextCtor } from "./host-bridge.ts";

export interface RendererTheme {
  fg(slot: string, text: string): string;
  bold(text: string): string;
}

export interface RendererOptions {
  expanded?: boolean;
  /**
   * Component ctor override for unit tests. Production always passes only
   * `{ expanded }`, so Text resolves from the lazy pi-tui import in
   * `./host-bridge.ts`.
   */
  TextCtor?: TextCtor;
}

const EXPAND_KEYBINDING = "app.tools.expand";
/** The DESCRIPTION passed to the host's `keyHint` — the host resolves and
 * colours the key itself, then appends `" " + description` in its muted slot
 * (`dist/modes/interactive/components/keybinding-hints.js:30-31`). Never a
 * fallback key string (#53). */
const EXPAND_HINT_DESCRIPTION = "to expand";

/** The slice of a pi-tui component this renderer produces. */
export interface EntryComponent {
  render(width: number): string[];
  invalidate(): void;
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
 * The host's own expand hint for the expand binding — `keyHint` already
 * returns the two-tone result (dim key + muted description), so this returns
 * it untouched. Empty when `keyHint` has not resolved (plain-node runs) or
 * threw: an invented key name would be worse than no hint (#53).
 */
function searchExpandHint(): string {
  const hintFn = hostModules().keyHint;
  if (!hintFn) return "";
  try { return hintFn(EXPAND_KEYBINDING, EXPAND_HINT_DESCRIPTION); } catch { return ""; }
}

/** Append the expand hint to the collapsed search summary line. Status is
 * never expandable (DESIGN.md status) — nothing else gets a hint. The host's
 * `keyHint` output is already themed (dim key + muted description), so the
 * spans carry NO role — wrapping it in a muted span would re-wrap the whole
 * two-tone string and flatten the key's dim colour (#53). */
function withSearchHint(linesIn: OutLine[], entry: OutEntry, expanded: boolean): OutLine[] {
  if (expanded) return linesIn;
  if (entry.kind !== "search" || entry.hits.length === 0) return linesIn;
  const hint = searchExpandHint();
  if (!hint || linesIn.length === 0) return linesIn;
  const lines = [...linesIn];
  const last = lines.at(-1)!;
  lines[lines.length - 1] = { spans: [...last.spans, { text: " (" }, { text: hint }, { text: ")" }] };
  return lines;
}

/**
 * Render one custom entry to a pi-tui component, or `undefined` when pi-tui has
 * not resolved (pi then skips the row). Never throws.
 */
export function renderEntryComponent(entryData: unknown, options?: RendererOptions, theme?: RendererTheme): EntryComponent | undefined {
  void loadHostModules();
  // Ctor seam: tests inject a fake via options; pi only ever passes { expanded },
  // so production resolves Text from the lazy pi-tui import.
  const TextCtor = options?.TextCtor ?? hostModules().Text;
  if (!TextCtor || !theme) return undefined;
  const entry = entryData as OutEntry | undefined;
  if (!entry || typeof entry !== "object" || typeof (entry as { kind?: unknown }).kind !== "string") return undefined;
  const expanded = options?.expanded ?? false;
  const lines = renderOut(entry, { expanded });
  const out = withSearchHint(lines, entry, expanded);
  try {
    // Zero padding (#54): the host's `paddingX/paddingY` default to 1 and its
    // custom-entry wrapper already inserts a `Spacer(1)` above the entry, so
    // the defaults would add a blank line above AND below on top of it.
    return new TextCtor(styledLines(out, theme).join("\n"), 0, 0);
  } catch {
    return undefined;
  }
}
