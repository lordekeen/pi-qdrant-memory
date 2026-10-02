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
 * Every entry — /qdrant status included — renders as one multi-line styled
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

/**
 * `Text`'s constructor as this renderer needs it. The host signature is
 * `constructor(text = "", paddingX = 1, paddingY = 1, customBgFn?)`
 * (`pi-tui/dist/components/text.js:15`) and the host's custom-entry wrapper
 * already inserts its own `Spacer(1)` above every entry — so the padding
 * arguments are REQUIRED here (#54). With the host's own optional-parameter
 * shape, `new Text(text)` type-checked while the host silently added a blank
 * line above and below the entry, on top of that spacer.
 */
export interface TextCtor {
  new (text: string, paddingX: number, paddingY: number): EntryComponent;
}

/** Every pi component the settings screen needs, all optional: under plain node
 *  (or an older host) none of them resolve and the screen is never mounted. */
export interface SettingsHost {
  SettingsList: SettingsListCtor;
  Input: InputCtor;
  DynamicBorder?: DynamicBorderCtor;
  getSettingsListTheme(): SettingsListTheme;
  keyText?: (binding: string) => string;
}

/** Constructor shapes for the lazily resolved host components. They are kept
 *  structural (not the host classes) so a fake can be injected in tests without
 *  importing the package; the ambient declarations in src/pi-tui.d.ts are the
 *  contract these mirror. */
export interface SettingsListCtor {
  new (
    items: HostSettingItem[],
    maxVisible: number,
    theme: SettingsListTheme,
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
    options?: { enableSearch?: boolean },
  ): SettingsListInstance;
}

export interface SettingsListInstance {
  updateValue(id: string, newValue: string): void;
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

export interface InputCtor {
  new (options?: { prompt?: string; placeholder?: string }): InputInstance;
}

export interface InputInstance {
  getValue(): string;
  setValue(value: string): void;
  handleInput(data: string): void;
  render(width: number): string[];
  invalidate(): void;
}

export interface DynamicBorderCtor {
  new (color?: (text: string) => string): EntryComponent;
}

/** The row/theme shapes the host `SettingsList` consumes, copied from
 *  `pi-tui/dist/components/settings-list.d.ts`. */
export interface HostSettingItem {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];
  submenu?: (
    currentValue: string,
    done: (selectedValue?: string, options?: { navigateTo?: string }) => void,
  ) => EntryComponent;
}

export interface SettingsListTheme {
  label: (text: string, selected: boolean) => string;
  value: (text: string, selected: boolean) => string;
  description: (text: string) => string;
  cursor: string;
  hint: (text: string) => string;
}

/** The resolved bundle. Members stay `undefined` until their import resolves,
 *  which is what makes graceful degradation a type-level and runtime fact. */
export interface HostModules {
  Text?: TextCtor;
  keyHint?: (keybinding: string, description: string) => string;
  SettingsList?: SettingsListCtor;
  Input?: InputCtor;
  DynamicBorder?: DynamicBorderCtor;
  getSettingsListTheme?: () => SettingsListTheme;
  keyText?: (binding: string) => string;
}

let host: HostModules = {};

/** The resolved host bundle — read fresh by every consumer so a component that
 *  resolves late (or not at all) is visible immediately, with no re-import. */
export function hostModules(): HostModules {
  return host;
}

/** Whether the lazy pi-tui Text component has resolved — test seam so suites
 * run identically with and without peer-installed pi packages. */
export function textComponentResolved(): boolean {
  return host.Text !== undefined;
}

let loading: Promise<void> | undefined;
/**
 * Kick off the guarded dynamic imports; safe to call repeatedly.
 *
 * This is THE host bridge for the whole extension (step 6): the entry renderer
 * uses `Text`/`keyHint`, the settings screen uses `SettingsList`/`Input`/
 * `DynamicBorder`/`getSettingsListTheme`/`keyText`. Every import is wrapped
 * independently, so a host that is missing one symbol (an older pi) still
 * resolves the rest instead of failing the whole bundle.
 */
export function loadHostModules(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      try {
        // SAFETY: pi's loader aliases this package at runtime; only the small
        // ambient surface in src/pi-tui.d.ts is visible to tsc, so the loaded
        // module is cast to the structural shapes above.
        const tui = (await import("@earendil-works/pi-tui")) as unknown as {
          Text?: TextCtor;
          SettingsList?: SettingsListCtor;
          Input?: InputCtor;
        };
        host.Text = tui.Text;
        host.SettingsList = tui.SettingsList;
        host.Input = tui.Input;
      } catch { /* pi-tui unavailable (plain node); renderer stays inactive */ }
      try {
        // SAFETY: the host package's ambient surface (src/pi-coding-agent.d.ts).
        const agent = (await import("@earendil-works/pi-coding-agent")) as unknown as {
          keyHint?: (keybinding: string, description: string) => string;
          DynamicBorder?: DynamicBorderCtor;
          getSettingsListTheme?: () => SettingsListTheme;
          keyText?: (binding: string) => string;
        };
        host.keyHint = agent.keyHint;
        host.DynamicBorder = agent.DynamicBorder;
        host.getSettingsListTheme = agent.getSettingsListTheme;
        host.keyText = agent.keyText;
      } catch { /* no host package; the renderer falls back to plain text */ }
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
  const hintFn = host.keyHint;
  if (hintFn) {
    try { hint = hintFn(EXPAND_KEYBINDING, EXPAND_HINT_FALLBACK); } catch { /* fallback */ }
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
  void loadHostModules();
  // Ctor seam: tests inject a fake via options; pi only ever passes { expanded },
  // so production resolves Text from the lazy pi-tui import.
  const TextCtor = options?.TextCtor ?? host.Text;
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
