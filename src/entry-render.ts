/**
 * Lazy TUI entry renderer for the `qdrant-memory` custom entry type (DESIGN.md).
 *
 * Plain-node runs never resolve pi-tui / pi-coding-agent, so this module must
 * not touch them at import time: both are loaded through guarded dynamic
 * imports and the renderer returns `undefined` until they resolve (pi then
 * skips the row — same mechanism the old renderer used for `Text`).
 *
 * The renderer is a dumb mapper: content + style roles come from `renderOut`
 * (src/out.ts, fully unit-tested); here each role becomes a host-theme slot.
 */
import { renderOut } from "./out.ts";
import type { OutEntry, OutLine, OutlineRole, Span } from "./out.ts";

export interface RendererTheme {
  fg(slot: string, text: string): string;
  bold(text: string): string;
  bg?(slot: string, text: string): string;
}

export interface RendererOptions {
  expanded?: boolean;
  /**
   * Component ctors override for unit tests. Production always passes only
   * `{ expanded }`, so these resolve from the lazy pi-tui import below.
   */
  TextCtor?: TextCtor;
  BoxCtor?: BoxCtor;
}

/** Background slot for the one status card. Fallback to plain rows if absent. */
const CARD_BG_SLOT = "customMessageBg";
const EXPAND_HINT_FALLBACK = "enter to expand";
const EXPAND_KEYBINDING = "app.tools.expand";

/** The slice of a pi-tui component this renderer produces/consumes. */
export interface EntryComponent {
  addChild?(child: unknown): void;
  render(width: number): string[];
  invalidate(): void;
}

/** A pi-tui container: same as EntryComponent with a required addChild. */
interface ContainerComponent {
  addChild(child: unknown): void;
  render(width: number): string[];
  invalidate(): void;
}

interface TextCtor {
  new (text?: string, paddingX?: number, paddingY?: number, customBgFn?: (text: string) => string): EntryComponent;
}
interface BoxCtor {
  new (paddingX?: number, paddingY?: number, bgFn?: (text: string) => string): ContainerComponent;
}

const modules: { Text?: TextCtor; Box?: BoxCtor } = {};
let keyHint: ((id: string, fallback: string) => string) | undefined;

let loading: Promise<void> | undefined;
/** Kick off the guarded dynamic imports; safe to call repeatedly. */
export function loadRendererModules(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      try {
        // SAFETY: pi's loader aliases these packages at runtime; only the small
        // surface above is ambient here, so the loaded modules are cast to it.
        const tui = (await import("@earendil-works/pi-tui")) as unknown as { Text?: TextCtor; Box?: BoxCtor };
        modules.Text = tui.Text;
        modules.Box = tui.Box;
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

function applyRole(span: Span, theme: RendererTheme): string {
  const role = span.role;
  if (!role || role === "default") return span.text;
  if (role === "bold") return theme.bold(span.text);
  try { return theme.fg(role, span.text); } catch { return span.text; }
}

function styledLine(line: OutLine, theme: RendererTheme): string {
  return line.spans.map((s) => applyRole(s, theme)).join("");
}

function styledLines(lines: OutLine[], theme: RendererTheme): string[] {
  return lines.map((l) => styledLine(l, theme));
}

/** One muted `(enter to expand)` fragment when collapse hides real content. */
function collapseHint(entry: OutEntry, expanded: boolean): string {
  if (expanded) return "";
  if (entry.kind === "search" && entry.hits.length === 0) return "";
  if (entry.kind !== "status" && entry.kind !== "search") return "";
  let hint = EXPAND_HINT_FALLBACK;
  if (keyHint) {
    try { hint = keyHint(EXPAND_KEYBINDING, EXPAND_HINT_FALLBACK); } catch { /* fallback */ }
  }
  return ` (${hint})`;
}

function textComponent(text: string, TextCtor: TextCtor | undefined): EntryComponent | undefined {
  return TextCtor ? new TextCtor(text) : undefined;
}

/** Status rows live in a bg Box when available; everything degrades to plain text. */
function buildStatus(
  entry: OutEntry,
  expanded: boolean,
  linesIn: OutLine[],
  theme: RendererTheme,
  TextCtor: TextCtor | undefined,
  BoxCtor: BoxCtor | undefined,
): EntryComponent | undefined {
  const lines = [...linesIn];
  const hint = collapseHint(entry, expanded);
  if (hint && lines.length) {
    const last = lines[lines.length - 1];
    // Spread keeps the card flag: a collapsed card must keep every row inside
    // the shared background (DESIGN.md status-card).
    lines[lines.length - 1] = { ...last, spans: [...last.spans, { text: hint, role: "muted" as OutlineRole }] };
  }
  const cardLines = lines.filter((l) => l.card === true);
  const bodyLines = lines.filter((l) => l.card !== true);

  // Plain path (no Box, no bg, or any failure below): styled text.
  const plain = (): EntryComponent | undefined => textComponent(styledLines(lines, theme).join("\n"), TextCtor);

  if (cardLines.length === 0) return plain();
  try {
    const bgFn = theme.bg;
    if (!BoxCtor || typeof bgFn !== "function") return plain();
    // pi's theme.bg is a Theme class method that reads `this` (this.bgColors); a
    // detached reference would run with `this === undefined` and throw. And the
    // Box invokes this fn on pi's own deferred render pass — outside every catch
    // in this module — so an error here would kill pi (AGENTS.md §6). Call it
    // with the theme as receiver and swallow render-time failures into an
    // unstyled line: the card degrades, never crashes.
    const slotBg = (t: string): string => {
      try { return bgFn.call(theme, CARD_BG_SLOT, t); } catch { return t; }
    };
    const cardBox = new BoxCtor(1, 1, slotBg);
    for (const cl of cardLines) {
      const child = textComponent(styledLine(cl, theme), TextCtor);
      if (child) cardBox.addChild(child);
    }
    const container = new BoxCtor(0, 0);
    container.addChild(cardBox);
    if (bodyLines.length) {
      const bodyText = textComponent(styledLines(bodyLines, theme).join("\n"), TextCtor);
      if (bodyText) container.addChild(bodyText);
    }
    return container;
  } catch {
    return plain();
  }
}

/**
 * Render one custom entry to a pi-tui component, or `undefined` when pi-tui has
 * not resolved (pi then skips the row). Never throws.
 */
export function renderEntryComponent(entryData: unknown, options?: RendererOptions, theme?: RendererTheme): EntryComponent | undefined {
  void loadRendererModules();
  // Ctor seam: tests inject fakes via options; pi only ever passes { expanded },
  // so production resolves them from the lazy pi-tui import.
  const TextCtor = options?.TextCtor ?? modules.Text;
  const BoxCtor = options?.BoxCtor ?? modules.Box;
  if (!TextCtor || !theme) return undefined;
  const entry = entryData as OutEntry | undefined;
  if (!entry || typeof entry !== "object" || typeof (entry as { kind?: unknown }).kind !== "string") return undefined;
  const expanded = options?.expanded ?? false;
  const lines = renderOut(entry, { expanded });

  if (entry.kind === "status") return buildStatus(entry, expanded, lines, theme, TextCtor, BoxCtor);
  // message / error / help / search: one multi-line styled Text (search gets the hint when collapsed)
  const hint = collapseHint(entry, expanded);
  const out: OutLine[] = [...lines];
  if (hint && out.length) {
    const last = out[out.length - 1];
    out[out.length - 1] = { ...last, spans: [...last.spans, { text: hint, role: "muted" as OutlineRole }] };
  }
  try {
    return textComponent(styledLines(out, theme).join("\n"), TextCtor);
  } catch {
    return undefined;
  }
}
