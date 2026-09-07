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
  export class Text {
    constructor(text?: string, paddingX?: number, paddingY?: number, customBgFn?: (text: string) => string);
    setText(text: string): void;
    setCustomBgFn(customBgFn?: (text: string) => string): void;
    invalidate(): void;
    render(width: number): string[];
  }

  /** Container that applies padding + background to its children (vertical). */
  export class Box {
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
