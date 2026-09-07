/**
 * Ambient types for the pi host package (mirror of src/pi-tui.d.ts).
 *
 * pi's extension loader aliases `@earendil-works/pi-coding-agent` at runtime, so
 * extensions never declare it as a dependency. Only the entry-renderer module
 * touches it, lazily, so plain-node test runs never resolve the import.
 */
declare module "@earendil-works/pi-coding-agent" {
  /** Render a keybinding-aware hint ("⏎ to expand") for the given binding id. */
  export function keyHint(keybinding: string, description: string): string;
}
