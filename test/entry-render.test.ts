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
import { renderEntryComponent, loadRendererModules, textComponentResolved } from "../src/entry-render.ts";
import type { RendererOptions } from "../src/entry-render.ts";

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

/** Text stores its styled string; render splits it into lines like pi-tui. */
class FakeText {
  text: string;
  constructor(text = "") { this.text = text; }
  render(): string[] { return this.text === "" ? [] : this.text.split("\n"); }
  invalidate(): void {}
}

/** Theme that wraps styled slots so tests can see role application. */
class WrapTheme {
  fg(slot: string, text: string): string { return `<${slot}>${text}</${slot}>`; }
  bold(text: string): string { return `*${text}*`; }
}
const IDENTITY_THEME = { fg: (_s: string, t: string) => t, bold: (t: string) => t };

const seam: RendererOptions = { TextCtor: FakeText };

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
    [{ cmd: "/qdrant-status", desc: "health" }, { cmd: "/qdrant-clear", desc: "reset" }],
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

test("collapsed search appends the expand hint to the summary line only", () => {
  const entry = searchEntry([searchHitView(hit(payload("decision", "use REST"), 0.9))]);
  const collapsed = renderEntryComponent(entry, seam, IDENTITY_THEME);
  assert.ok(collapsed, "expected a search component");
  const lines = collapsed.render(60);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith("(enter to expand)"), `hint on summary: ${lines[0]}`);
});

test("expanded search shows every hit with no hint", () => {
  const entry = searchEntry([searchHitView(hit(payload("decision", "use REST"), 0.9))]);
  const expanded = renderEntryComponent(entry, { ...seam, expanded: true }, IDENTITY_THEME);
  assert.ok(expanded, "expected a search component");
  const lines = expanded.render(60);
  assert.equal(lines.length, 2); // meta + text
  assert.equal(lines[1], "use REST");
  assert.ok(!lines.some((l) => l.includes("enter to expand")));
});

test("zero-hit search and message entries get no expand hint", () => {
  const zero = renderEntryComponent(searchEntry([]), seam, IDENTITY_THEME);
  assert.ok(zero, "expected a search component");
  assert.deepEqual(zero.render(60), ["No relevant memory found."]);

  const msg = renderEntryComponent(message("remembered: x"), seam, IDENTITY_THEME);
  assert.ok(msg, "expected a message component");
  assert.ok(!msg.render(60).some((l) => l.includes("enter to expand")));
});

test("returns undefined when no Text ctor is available (pi-tui not resolved)", async () => {
  await loadRendererModules();
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
