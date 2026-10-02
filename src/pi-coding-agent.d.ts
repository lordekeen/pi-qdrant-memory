/**
 * Ambient types for the pi host package (mirror of src/pi-tui.d.ts).
 *
 * pi's extension loader aliases `@earendil-works/pi-coding-agent` at runtime, so
 * extensions never declare it as a dependency. Only the entry renderer and the
 * settings bridge touch it, lazily, so plain-node test runs never resolve the
 * import.
 *
 * Every declaration below is copied from the installed package's `dist/`
 * (file + line noted), so drift is a compile error rather than a runtime blank
 * row or a silently unstyled hint.
 */
declare module "@earendil-works/pi-coding-agent" {
  /** Render a keybinding-aware hint ("⏎ to expand") for the given binding id.
   *  `dist/modes/interactive/components/keybinding-hints.d.ts:11` — the second
   *  argument is a DESCRIPTION, not a fallback key string. */
  export function keyHint(keybinding: string, description: string): string;

  /** The key label for one binding id, e.g. `keyText("tui.select.cancel")`
   *  → "esc". `dist/modes/interactive/components/keybinding-hints.d.ts:9`; the
   *  host parameter type is the `Keybinding` id union, narrowed here to the
   *  two ids the settings hint line names (the ambient declaration cannot
   *  import the id list, and method-parameter bivariance keeps the host's own
   *  broader `KeybindingsManager` assignable to this shape). */
  export function keyText(keybinding: string): string;

  /** `dist/modes/interactive/theme/theme.d.ts:157` — the theme pi's own
   *  settings selector hands to `SettingsList`. */
  export function getSettingsListTheme(): import("@earendil-works/pi-tui").SettingsListTheme;

  /** `dist/modes/interactive/components/dynamic-border.d.ts` — the border
   *  pi's own settings overlay puts above and below the list. The host's own
   *  note applies here too: an extension must pass an explicit colour
   *  function, because the global `theme` may be undefined under the loader's
   *  separate module cache. */
  export class DynamicBorder {
    constructor(color?: (str: string) => string);
    invalidate(): void;
    render(width: number): string[];
  }
}