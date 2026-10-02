/**
 * Ambient types for pi's TUI component library.
 *
 * pi's extension loader aliases `@earendil-works/pi-tui` to its own bundled copy
 * (see getAliases() in pi's dist/core/extensions/loader.js), so extensions never
 * declare it as a dependency — pi-ketch does the same. We import it lazily at
 * runtime so plain-node test runs (which never render entries) don't need it on
 * the module graph. This file only satisfies `tsc`; the surface we use is a
 * fraction of the real package (see pi-tui/dist/components/*.d.ts).
 */
declare module "@earendil-works/pi-tui" {
  /**
   * Host component contract (`pi-tui/dist/tui.d.ts`, `Component`): `render` and
   * `invalidate` are required by the host, `handleInput` is optional.
   */
  export interface Component {
    render(width: number): string[];
    handleInput?(data: string): void;
    invalidate(): void;
  }

  /**
   * Host `SettingItem` — the settings primitive pi's own `/settings` uses
   * (`dist/components/settings-list.d.ts`). An ambient module declaration may
   * NOT reference a relative module, so the row shape is copied verbatim from
   * dist here; `src/settings-ui.ts` proves at compile time that its own pure
   * mapping is assignable to this shape, so the two can never drift apart
   * without a `tsc` error. Host-shaped means "no functions to run", except the
   * `submenu` factory the settings screen attaches.
   */
  export interface SettingItem {
    id: string;
    label: string;
    description?: string;
    currentValue: string;
    /** Enter/Space cycles through these values. */
    values?: string[];
    /** Enter opens this submenu; `done(value)` commits, `done()` cancels. */
    submenu?: (currentValue: string, done: (selectedValue?: string, options?: { navigateTo?: string }) => void) => Component;
  }

  export class Text implements Component {
    /**
     * The host signature is `constructor(text = "", paddingX = 1, paddingY = 1,
     * customBgFn?)` (`dist/components/text.js`), i.e. the padding parameters have
     * real defaults of 1 — and the host's custom-entry wrapper already inserts
     * its own `Spacer(1)` above every entry. Declaring `text`/`paddingX`/
     * `paddingY` REQUIRED is the deliberate tightening from #54: with the host's
     * own optional-parameter shape, `new Text(text)` type-checked while the host
     * silently padded a blank line above and below the entry.
     */
    constructor(text: string, paddingX: number, paddingY: number, customBgFn?: (text: string) => string);
    setText(text: string): void;
    setCustomBgFn(customBgFn?: (text: string) => string): void;
    invalidate(): void;
    render(width: number): string[];
  }

  export interface InputOptions {
    prompt?: string;
    placeholder?: string;
    placeholderStyle?: (text: string) => string;
  }

  /** Single-line text input used by the settings screen's value submenu. */
  export class Input implements Component {
    constructor(options?: InputOptions);
    /** Optional submit/escape callbacks; the screen matches keys itself
     *  through the injected keybindings object instead (the extension rule). */
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    focused: boolean;
    getValue(): string;
    setValue(value: string): void;
    handleInput(data: string): void;
    invalidate(): void;
    render(width: number): string[];
  }

  /**
   * The settings primitive pi's own `/settings` uses
   * (`dist/components/settings-list.d.ts`). Copy of the host row/theme shapes:
   * the label column is aligned and the value column truncated by the HOST, so
   * this repo only ever supplies strings.
   */
  export interface SettingsListTheme {
    label: (text: string, selected: boolean) => string;
    value: (text: string, selected: boolean) => string;
    description: (text: string) => string;
    cursor: string;
    hint: (text: string) => string;
  }

  export interface SettingsListOptions { enableSearch?: boolean; }

  export class SettingsList implements Component {
    constructor(
      items: SettingItem[],
      maxVisible: number,
      theme: SettingsListTheme,
      onChange: (id: string, newValue: string) => void,
      onCancel: () => void,
      options?: SettingsListOptions,
    );
    /** Update an item's currentValue — the ONLY way back after a rejected
     *  write, because the host mutates `item.currentValue` BEFORE onChange. */
    updateValue(id: string, newValue: string): void;
    selectItem(id: string): void;
    invalidate(): void;
    render(width: number): string[];
    handleInput(data: string): void;
  }

  /** Container that applies padding + background to its children (vertical). */
  export class Box implements Component {
    constructor(paddingX?: number, paddingY?: number, bgFn?: (text: string) => string);
    children: unknown[];
    addChild(component: unknown): void;
    removeChild(component: unknown): void;
    clear(): void;
    setBgFn(bgFn?: (text: string) => string): void;
    invalidate(): void;
    render(width: number): string[];
  }
}
