/**
 * Host bridge: the host-shaped component types plus the guarded lazy imports
 * of pi-tui / pi-coding-agent — THE bridge every consumer reads through
 * `hostModules()`.
 *
 * Plain-node runs never resolve pi-tui / pi-coding-agent, so this module must
 * not touch them at import time: both are loaded through guarded dynamic
 * imports and the renderer returns `undefined` until they resolve (pi then
 * skips the row).
 */
import type { EntryComponent } from "./entry-render.ts";

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
