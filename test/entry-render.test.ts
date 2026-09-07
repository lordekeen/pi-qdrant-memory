/**
 * entry-render tests — the pi-tui renderer seam.
 *
 * Production resolves `Text`/`Box` from pi's lazy pi-tui import (which plain
 * node never satisfies), so these tests inject fake component ctors through
 * `RendererOptions.TextCtor/BoxCtor` and render the tree with fakes that mirror
 * pi-tui's semantics — above all that a Box's custom bg fn is invoked at
 * *render* time (cache probe then per-line paint), long after the component was
 * constructed and any construction-time try/catch has exited.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { message, statusEntry } from "../src/out.ts";
import type { StatusHealth } from "../src/out.ts";
import { renderEntryComponent } from "../src/entry-render.ts";
import type { EntryComponent, RendererOptions } from "../src/entry-render.ts";

const BG_ANSI = "\x1B[48;2;12;12;12m";
const BG_RESET = "\x1B[49m";

const health: StatusHealth = {
  mode: "mode2",
  qdrant: { state: "ok", collection: "pi-mem-abc", points: 3 },
  embeddings: { state: "ok" },
  detail: {
    collection: "pi-mem-abc",
    qdrantUrl: "http://localhost:6333",
    model: "nomic-embed-text",
    dimension: 768,
    threshold: 0.15,
    maxResults: 10,
  },
};

// ── Fake pi-tui components ──────────────────────────────────────────────────

/** Text stores its styled string; render splits it into lines like pi-tui. */
class FakeText {
  text: string;
  constructor(text = "") { this.text = text; }
  render(): string[] { return this.text === "" ? [] : this.text.split("\n"); }
  invalidate(): void {}
}

/**
 * Box mirrors pi-tui's Box.render contract: the optional custom bg fn is stored
 * at construction but only *called during render* — first as a "test" cache
 * probe, then once per padded child line. That deferral is what makes a bg-fn
 * failure lethal: it happens on the host's render pass, outside the extension's
 * construction-time guards.
 */
class FakeBox {
  children: EntryComponent[] = [];
  paddingX: number;
  bgFn: ((text: string) => string) | undefined;
  constructor(paddingX = 1, _paddingY = 1, bgFn?: (text: string) => string) {
    this.paddingX = paddingX;
    this.bgFn = bgFn;
  }
  addChild(child: unknown): void { this.children.push(child as EntryComponent); }
  render(width: number): string[] {
    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const childLines: string[] = [];
    for (const child of this.children) {
      for (const line of child.render(contentWidth)) childLines.push(" ".repeat(this.paddingX) + line);
    }
    const bgFn = this.bgFn;
    if (bgFn) bgFn("test"); // pi-tui samples the bg here to key its render cache
    if (!bgFn) return childLines;
    return childLines.map((l) => bgFn(l + " ".repeat(Math.max(0, width - l.length))));
  }
  invalidate(): void {}
}

const ctorSeam: RendererOptions = { TextCtor: FakeText, BoxCtor: FakeBox };

// ── Fake host themes ────────────────────────────────────────────────────────

/**
 * Mirrors pi's Theme class (bundle): `bg` is a *method* that reads the receiver
 * — `this.bgColors.get(slot)`. Invoking a detached reference runs it with
 * `this === undefined` and throws `Cannot read properties of undefined
 * (reading 'bgColors')`, exactly the crash that took pi down.
 */
class PiLikeTheme {
  readonly bgColors = new Map<string, string>([["customMessageBg", BG_ANSI]]);
  readonly bgCalls: string[] = [];
  fg(_slot: string, text: string): string { return text; }
  bold(text: string): string { return text; }
  bg(slot: string, text: string): string {
    this.bgCalls.push(slot);
    const ansi = this.bgColors.get(slot);
    if (!ansi) throw new Error(`Unknown theme background color: ${slot}`);
    return `${ansi}${text}${BG_RESET}`;
  }
}

/** A theme whose bg fails at render time (e.g. a theme without the slot). */
class ThrowingBgTheme {
  fg(_slot: string, text: string): string { return text; }
  bold(text: string): string { return text; }
  bg(_slot: string, _text: string): string {
    throw new Error("Unknown theme background color: customMessageBg");
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("status card bg fn runs with the theme as its receiver", () => {
  const theme = new PiLikeTheme();
  const component = renderEntryComponent(statusEntry(health), { ...ctorSeam, expanded: true }, theme);
  assert.ok(component, "expected a status card component");

  // pi-tui calls the bg fn during render. A detached theme.bg (this ===
  // undefined) throws here — outside the extension's construction try/catch.
  const lines = component.render(60);
  assert.ok(lines.length >= 7, "card + detail rows expected");
  assert.ok(lines[0].startsWith(BG_ANSI), "card rows should be bg-painted");
  assert.ok(lines[0].endsWith(BG_RESET));
  assert.ok(!lines[lines.length - 1].startsWith(BG_ANSI), "body rows stay outside the card bg");
  // Every invocation must target the status-card bg slot, with the receiver set.
  assert.ok(theme.bgCalls.length >= 4, "probe + one call per card line");
  assert.ok(theme.bgCalls.every((s) => s === "customMessageBg"));
});

test("status card degrades to plain rows when theme.bg throws at render time", () => {
  const component = renderEntryComponent(statusEntry(health), { ...ctorSeam, expanded: true }, new ThrowingBgTheme());
  assert.ok(component, "expected a status card component");
  // Never throws: a bg failure surfaces as an unstyled row, not a host crash.
  const lines = component.render(60);
  assert.ok(lines.length >= 7);
  assert.ok(!lines[0].startsWith(BG_ANSI), "no bg applied on failure");
});

test("non-status entries render as one styled Text, no bg fn involved", () => {
  const component = renderEntryComponent(message("cleared: collection pi-mem-abc reset"), ctorSeam, new PiLikeTheme());
  assert.ok(component, "expected a message component");
  const lines = component.render(60);
  assert.deepEqual(lines, ["cleared: collection pi-mem-abc reset"]);
});

test("collapsed status entry still paints a card (no detail rows)", () => {
  const theme = new PiLikeTheme();
  const component = renderEntryComponent(statusEntry(health), ctorSeam, theme);
  assert.ok(component, "expected a status card component");
  const lines = component.render(60);
  assert.equal(lines.length, 3, "collapsed status shows only the three card rows");
  assert.ok(lines.every((l) => l.startsWith(BG_ANSI)));
});

test("returns undefined when no Text ctor is available (pi-tui not resolved)", () => {
  const component = renderEntryComponent(message("x"), {}, new PiLikeTheme());
  assert.equal(component, undefined);
});
