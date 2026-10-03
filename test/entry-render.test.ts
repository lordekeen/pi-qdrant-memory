/**
 * entry-render tests — the pi-tui renderer seam.
 *
 * Production resolves `Text` from pi's lazy pi-tui import (which plain node
 * never satisfies), so these tests inject a fake component ctor through
 * `RendererOptions.TextCtor` and assert on its rendered lines. There is no Box:
 * every entry — status included — is one multi-line `Text` (DESIGN.md: no
 * cards, no bg fills). Only collapsed search summaries get the expand hint.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { message, errorEntry, helpEntry, statusEntry, searchEntry, searchHitView } from "../src/out.ts";
import type { StatusHealth } from "../src/out.ts";
import type { PointPayload, SearchHit } from "../src/types.ts";
import { renderEntryComponent, loadHostModules, textComponentResolved, hostModules } from "../src/entry-render.ts";
import type { RendererOptions, TextCtor } from "../src/entry-render.ts";

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

function payload(type: string, text: string): PointPayload {
  return { type: type as PointPayload["type"], text, project_id: "pi-mem-abc", ts: 1, source_kind: "remember_tool" };
}
function hit(p: PointPayload, score: number): SearchHit { return { id: "x", score, payload: p }; }

/**
 * Text models the HOST's real defaults (`dist/components/text.js:15`:
 * `constructor(text = "", paddingX = 1, paddingY = 1, …)`) and RECORDS the
 * arguments it was given. The old fake took only `text`, so it could not see
 * that omitting the padding let the host add a blank line above and below every
 * entry on top of its own spacer — `new TextCtor(text)` type-checked and the
 * spacing bug shipped anyway (#54). Defaulting like the host here makes the
 * renderer pass `(text, 0, 0)` the only way to get no padding, so a regression
 * is a failing assertion instead of a silent blank line.
 */
class FakeText {
  static lastArgs: [string, number, number] | undefined;
  text: string;
  paddingX: number;
  paddingY: number;
  constructor(text = "", paddingX = 1, paddingY = 1) {
    this.text = text;
    this.paddingX = paddingX;
    this.paddingY = paddingY;
    FakeText.lastArgs = [text, paddingX, paddingY];
  }
  render(): string[] { return this.text === "" ? [] : this.text.split("\n"); }
  invalidate(): void {}
}

/** Read through a function so the caller's control-flow analysis does not
 *  narrow the recorded tuple away after a `= undefined` reset. */
function lastTextArgs(): [string, number, number] | undefined {
  return FakeText.lastArgs;
}

/** Theme that wraps styled slots so tests can see role application. */
class WrapTheme {
  fg(slot: string, text: string): string { return `<${slot}>${text}</${slot}>`; }
  bold(text: string): string { return `*${text}*`; }
}
const IDENTITY_THEME = { fg: (_s: string, t: string) => t, bold: (t: string) => t };

const seam: RendererOptions = { TextCtor: FakeText as unknown as TextCtor };

// ── Tests ───────────────────────────────────────────────────────────────────

test("status renders one plain text block: header + subsystem + config detail", () => {
  const component = renderEntryComponent(statusEntry(health), seam, IDENTITY_THEME);
  assert.ok(component, "expected a status component");
  const lines = component.render(60);
  assert.equal(lines.length, 6); // header + qdrant + embeddings + 3 config rows
  assert.equal(lines[0], "🧠 Memory: mode2 (pi-mem-abc)");
  assert.equal(lines[1], "qdrant: ✓ reachable · 3 points");
  assert.equal(lines[2], "embeddings: ✓ reachable");
  assert.ok(lines.some((l) => l.includes("qdrant url: http://localhost:6333")));
  assert.ok(lines.some((l) => l.includes("dimension: 768 · threshold: 0.15 · maxResults: 10")));
  // Status is never a bg card: no Box involved, same plain text any other entry gets.
  assert.ok(!lines.some((l) => l.includes("customMessageBg")), "no background slot requested");
});

test("status project-settings row survives the role→theme mapping", () => {
  const withOverride: StatusHealth = {
    ...health,
    projectSettings: [{ key: "codeKnowledge", value: "on", globalValue: "off" }],
  };
  const component = renderEntryComponent(statusEntry(withOverride), seam, IDENTITY_THEME);
  assert.ok(component, "expected a status component");
  const lines = component.render(60);
  assert.ok(lines.includes("project settings: codeKnowledge = on (global: off)"), lines.join("\n"));
});

test("status state rows carry semantic roles through the theme", () => {
  const warn = statusEntry({
    ...health, qdrant: { state: "warn", collection: "pi-mem-abc" },
    embeddings: { state: "err" },
  });
  const component = renderEntryComponent(warn, seam, new WrapTheme());
  assert.ok(component, "expected a status component");
  const lines = component.render(60);
  assert.ok(lines[1].includes("<warning>! collection pi-mem-abc does not exist yet</warning>"));
  assert.ok(lines[2].includes("<error>✗ NOT reachable</error>"));
});

test("help renders the memory header then the aligned command list", () => {
  const entry = helpEntry(
    [{ cmd: "/qdrant status", desc: "health" }, { cmd: "/qdrant clear all | code", desc: "reset" }],
    { mode: "mode1", collection: "pi-mem-abc" },
  );
  const component = renderEntryComponent(entry, seam, new WrapTheme());
  assert.ok(component, "expected a help component");
  const lines = component.render(60);
  assert.equal(lines[0], "🧠 Memory: mode1 (pi-mem-abc)");
  assert.equal(lines[1], "*commands*");
  assert.ok(lines[2].includes("<dim>health</dim>"), "descriptions map to the dim slot");
});

test("message and error render verbatim through role slots", () => {
  const m = renderEntryComponent(message("cleared: collection pi-mem-abc reset"), seam, IDENTITY_THEME);
  assert.ok(m, "expected a message component");
  assert.deepEqual(m.render(60), ["cleared: collection pi-mem-abc reset"]);

  const err = renderEntryComponent(errorEntry("error: search failed: down"), seam, new WrapTheme());
  assert.ok(err, "expected an error component");
  assert.deepEqual(err.render(60), ["<error>error: search failed: down</error>"]);
});

/**
 * A fake `keyHint` reproducing the host's REAL output
 * (`dist/modes/interactive/components/keybinding-hints.js:30-31`):
 * dim key + muted description, with the host's default `app.tools.expand`
 * keys (`ctrl+o`). The old test ran without pi resolved and asserted the
 * dead fallback string, so it could never see the wrong description or the
 * double colouring (#53) — this fake makes both regressions fail.
 */
const DIM = "\u001b[2m";
const MUTED = "\u001b[9m";
const RESET = "\u001b[0m";
function fakeKeyHint(_keybinding: string, description: string): string {
  return `${DIM}ctrl+o${RESET}${MUTED} ${description}${RESET}`;
}

/** Swap the host bridge's keyHint for the fake and restore it afterwards.
 * Explicitly overriding (not just deleting) matters: under an environment
 * where the real pi packages resolve, loadHostModules would otherwise leave
 * the real function in place. */
async function withFakeKeyHint(fn: (hintFn: (kb: string, desc: string) => string) => void): Promise<void> {
  const bridge = hostModules();
  const previous = bridge.keyHint;
  try {
    bridge.keyHint = fakeKeyHint;
    fn(fakeKeyHint);
  } finally {
    bridge.keyHint = previous;
  }
}

test("collapsed search appends the host's two-tone expand hint, un-recoloured", async () => {
  await withFakeKeyHint(() => {
    const entry = searchEntry([searchHitView(hit(payload("decision", "use REST"), 0.9))]);
    const collapsed = renderEntryComponent(entry, seam, IDENTITY_THEME);
    assert.ok(collapsed, "expected a search component");
    const lines = collapsed.render(60);
    assert.equal(lines.length, 1);
    // The description is "to expand", and the host's two-tone output must be
    // intact: dim key + muted description, no wrapping escapes around them
    // (a muted role span would re-wrap the whole string and flatten the key).
    assert.ok(lines[0].endsWith(` (${DIM}ctrl+o${RESET}${MUTED} to expand${RESET})`),
      `hint on summary: ${JSON.stringify(lines[0])}`);
  });
});

test("collapsed search shows NO hint when keyHint has not resolved (plain node)", async () => {
  const bridge = hostModules();
  const previous = bridge.keyHint;
  try {
    bridge.keyHint = undefined; // plain-node run: the host package never resolved
    const entry = searchEntry([searchHitView(hit(payload("decision", "use REST"), 0.9))]);
    const collapsed = renderEntryComponent(entry, seam, new WrapTheme());
    assert.ok(collapsed, "expected a search component");
    const lines = collapsed.render(60);
    assert.equal(lines.length, 1);
    // No invented key name, no fallback wording, no muted wrap: bare summary.
    assert.ok(!lines.some((l) => l.includes("expand")), `no hint expected: ${lines.join("\n")}`);
  } finally {
    bridge.keyHint = previous;
  }
});

test("expanded search shows every hit with no hint", () => {
  const entry = searchEntry([searchHitView(hit(payload("decision", "use REST"), 0.9))]);
  const expanded = renderEntryComponent(entry, { ...seam, expanded: true }, IDENTITY_THEME);
  assert.ok(expanded, "expected a search component");
  const lines = expanded.render(60);
  assert.equal(lines.length, 2); // meta + text
  assert.equal(lines[1], "use REST");
  assert.ok(!lines.some((l) => l.includes("to expand")));
});

test("zero-hit search and message entries get no expand hint", () => {
  const zero = renderEntryComponent(searchEntry([]), seam, IDENTITY_THEME);
  assert.ok(zero, "expected a search component");
  assert.deepEqual(zero.render(60), ["No relevant memory found."]);

  const msg = renderEntryComponent(message("remembered: x"), seam, IDENTITY_THEME);
  assert.ok(msg, "expected a message component");
  assert.ok(!msg.render(60).some((l) => l.includes("to expand")));
});

test("every entry is built with zero padding — the host defaults to 1 and pads it (#54)", () => {
  // The host's Text defaults are paddingX = 1, paddingY = 1 AND the host's
  // custom-entry wrapper already inserts a Spacer(1) above the entry, so the
  // defaults produced a blank line above and below on top of that spacer.
  // The fake models those real defaults, so only an explicit (0, 0) can pass.
  const cases: Array<[string, unknown]> = [
    ["message", message("remembered: x")],
    ["error", errorEntry("error: search failed: down")],
    ["status", statusEntry(health)],
    ["help", helpEntry([{ cmd: "/qdrant status", desc: "health" }], { mode: "mode2", collection: "pi-mem-abc" })],
    ["search", searchEntry([searchHitView(hit(payload("decision", "use REST"), 0.9))])],
  ];
  for (const [name, entry] of cases) {
    FakeText.lastArgs = undefined;
    const component = renderEntryComponent(entry, seam, IDENTITY_THEME);
    assert.ok(component, `${name}: expected a component`);
    const args = lastTextArgs();
    assert.ok(args, `${name}: the renderer must construct Text`);
    assert.deepEqual(args.slice(1), [0, 0], `${name}: Text must be built with (text, 0, 0)`);
  }
});

test("returns undefined when no Text ctor is available (pi-tui not resolved)", async () => {
  await loadHostModules();
  // Deterministic in both environments: when pi-tui is NOT resolvable (plain
  // node without peers) the no-ctor render must bail with undefined; when it
  // IS resolvable (npm auto-installs peerDependencies in CI) the real Text
  // must render. Theme-missing and malformed entries always bail.
  const noCtor = renderEntryComponent(message("x"), {}, new WrapTheme());
  if (textComponentResolved()) assert.ok(noCtor, "expected a component from the real Text");
  else assert.equal(noCtor, undefined);
  assert.equal(renderEntryComponent(message("x"), seam, undefined), undefined);
  assert.equal(renderEntryComponent({ bogus: true }, seam, new WrapTheme()), undefined);
});
