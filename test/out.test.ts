import test from "node:test";
import assert from "node:assert/strict";
import {
  message, errorEntry, helpEntry, statusEntry, searchEntry, searchHitView,
  renderOut, outText, typeRole, memoryHeaderText,
} from "../src/out.ts";
import type { OutEntry, OutLine, Span } from "../src/out.ts";
import type { PointPayload, SearchHit } from "../src/types.ts";

const spanText = (l: OutLine): string => l.spans.map((s: Span) => s.text).join("");
const roles = (l: OutLine): Array<string | undefined> => l.spans.map((s: Span) => s.role ?? "default");

function payload(type: string, text: string, extra: Partial<PointPayload> = {}): PointPayload {
  return { type: type as PointPayload["type"], text, project_id: "pi-mem-p", ts: 1, source_kind: "remember_tool", ...extra };
}
function hit(p: PointPayload, score: number): SearchHit { return { id: "x", score, payload: p }; }

const health = {
  mode: "mode2",
  qdrant: { state: "ok" as const, collection: "pi-mem-abc", points: 3 },
  embeddings: { state: "ok" as const },
  detail: {
    collection: "pi-mem-abc", qdrantUrl: "http://localhost:6333",
    model: "nomic-embed-text @ http://localhost:8080/v1",
    dimension: 768, threshold: 0.15, maxResults: 10,
  },
};

test("message renders its text verbatim, default role", () => {
  const e = message("cleared: collection pi-mem-abc reset");
  const lines = renderOut(e);
  assert.equal(lines.length, 1);
  assert.equal(spanText(lines[0]), "cleared: collection pi-mem-abc reset");
  assert.deepEqual(roles(lines[0]), ["default"]);
  assert.equal(outText(e), "cleared: collection pi-mem-abc reset");
});

test("error renders whole line with the error role", () => {
  const e = errorEntry("error: search failed: down");
  const lines = renderOut(e);
  assert.deepEqual(roles(lines[0]), ["error"]);
});

test("help renders the memory header, then a bold title + aligned rows", () => {
  const header = { mode: "mode1", collection: "pi-mem-abc" };
  const e = helpEntry([
    { cmd: "qdrant-status", desc: "health" },
    { cmd: "qdrant-settings", desc: "config" },
  ], header);
  const lines = renderOut(e);
  // Footer-style header brands the block (DESIGN.md footer-status).
  assert.equal(spanText(lines[0]), "🧠 Memory: mode1 (pi-mem-abc)");
  assert.deepEqual(roles(lines[0]), ["default"]);
  assert.equal(spanText(lines[1]), "commands");
  assert.deepEqual(roles(lines[1]), ["bold"]);
  // command column aligned to the longest name + 2
  assert.equal(spanText(lines[2]), `${"qdrant-status".padEnd("qdrant-settings".length + 2)}health`);
  assert.deepEqual(roles(lines[2]), ["default", "dim"]);
});

test("help aligns usage commands past 26 chars without jamming the description", () => {
  const rows = [
    { cmd: "/qdrant-status", desc: "connection health + active mode + collection status" },
    { cmd: "/qdrant-settings <key> <value>", desc: "persist a config field (e.g. scoreThreshold 0.2)" },
  ];
  const lines = renderOut(helpEntry(rows, { mode: "mode2", collection: "pi-mem-abc" }));
  const width = Math.max(...rows.map((r) => r.cmd.length)) + 2; // 31 — an old 26-cap jammed here
  assert.equal(spanText(lines[0]), "🧠 Memory: mode2 (pi-mem-abc)"); // header first
  assert.equal(spanText(lines[2]), `${"/qdrant-status".padEnd(width)}connection health + active mode + collection status`);
  assert.equal(spanText(lines[3]), `${"/qdrant-settings <key> <value>".padEnd(width)}persist a config field (e.g. scoreThreshold 0.2)`);
  assert.equal(spanText(lines[3]).indexOf("persist"), width);
});

test("status renders one plain always-visible block headed by the memory header", () => {
  const e = statusEntry(health);
  const lines = renderOut(e);
  assert.equal(lines.length, 6); // header + qdrant + embeddings + 3 config rows
  // Header mirrors the footer statusline; no separate `memory:` label row.
  assert.equal(spanText(lines[0]), "🧠 Memory: mode2 (pi-mem-abc)");
  assert.deepEqual(roles(lines[0]), ["default"]);
  assert.equal(spanText(lines[1]), "qdrant: ✓ reachable · 3 points");
  assert.deepEqual(roles(lines[1]), ["default", "success", "default"]);
  assert.equal(spanText(lines[2]), "embeddings: ✓ reachable");
  assert.ok(lines.every((l) => !("card" in l)), "no card rows remain (unboxed text)");
});

test("status states: NOT reachable uses error role, missing collection warns", () => {
  const down = statusEntry({
    ...health, qdrant: { state: "err" }, embeddings: { state: "err" },
  });
  const linesDown = renderOut(down);
  assert.match(spanText(linesDown[1]), /✗ NOT reachable/);
  assert.equal(roles(linesDown[1]).includes("error"), true);
  assert.match(spanText(linesDown[2]), /✗ NOT reachable/);

  const missing = statusEntry({
    ...health, qdrant: { state: "warn", collection: "pi-mem-abc" },
  });
  const linesMissing = renderOut(missing);
  // Whole-value warning slot, symmetric to the error row's "✗ NOT reachable"
  // (DESIGN.md status-card variants: "does not exist yet — warning slot").
  assert.equal(spanText(linesMissing[1]), "qdrant: ! collection pi-mem-abc does not exist yet");
  assert.deepEqual(roles(linesMissing[1]), ["default", "warning"]);
});

test("status shows config detail in every render (no API keys), ignoring expanded", () => {
  const e = statusEntry(health);
  const lines = renderOut(e);
  const text = lines.map(spanText).join("\n");
  assert.match(text, /🧠 Memory: mode2 \(pi-mem-abc\)/);
  assert.match(text, /qdrant url: http:\/\/localhost:6333/);
  assert.match(text, /dimension: 768 · threshold: 0.15 · maxResults: 10/);
  assert.doesNotMatch(text, /apiKey|api_key|key=/i);
  // Collection id lives in the header; the old separate `collection:` row is gone.
  assert.doesNotMatch(text, /^collection: /m);
  // No detail is hidden behind an expand gesture — expanded renders identically.
  assert.deepEqual(renderOut(e, { expanded: true }), lines);
});

test("search collapsed is one line with a colored top-type tag + top-hit preview", () => {
  const e = searchEntry([
    searchHitView(hit(payload("fact", "use REST", { source_entry_id: "id1" }), 0.8765)),
  ]);
  const lines = renderOut(e);
  assert.equal(lines.length, 1);
  assert.equal(spanText(lines[0]), "1 result · top [fact] 0.88 · use REST");
  assert.deepEqual(roles(lines[0]), ["default", typeRole("fact"), "default", "default", "default"]);
});

test("search collapsed pluralizes and previews the top hit verbatim when short", () => {
  const e = searchEntry([
    searchHitView(hit(payload("decision", "alpha", { source_entry_id: "a" }), 0.9)),
    searchHitView(hit(payload("fact", "beta", { session_id: "s1" }), 0.7)),
  ]);
  const collapsed = spanText(renderOut(e)[0]);
  assert.equal(collapsed, "2 results · top [decision] 0.90 · alpha");
});

test("search collapsed preview truncates at 200 chars with …, never when expanded", () => {
  const long = "y".repeat(250);
  const e = searchEntry([searchHitView(hit(payload("fact", long), 0.5))]);
  assert.equal(spanText(renderOut(e)[0]), `1 result · top [fact] 0.50 · ${"y".repeat(200)}…`);
  assert.equal(spanText(renderOut(e, { expanded: true })[1]), long);
});

test("search expanded: verbatim text, colored meta, source pointer, blank between hits", () => {
  const e = searchEntry([
    searchHitView(hit(payload("decision", "alpha text", { source_entry_id: "a1" }), 0.9)),
    searchHitView(hit(payload("constraint", "beta text", { session_id: "s1" }), 0.7)),
  ]);
  const lines = renderOut(e, { expanded: true });
  assert.equal(lines.length, 5); // meta+text + blank + meta+text
  assert.equal(spanText(lines[0]), "[decision] 0.90 (source_entry_id=a1)");
  assert.deepEqual(roles(lines[0]), [typeRole("decision"), "default", "dim"]);
  assert.equal(spanText(lines[1]), "alpha text");
  assert.deepEqual(roles(lines[1]), ["default"]);
  assert.equal(spanText(lines[2]), "");
  assert.equal(spanText(lines[3]), "[constraint] 0.70 (session_id=s1)");
  assert.equal(roles(lines[3])[0], typeRole("constraint"));
  assert.equal(spanText(lines[4]), "beta text");
});

test("search long text is never truncated when expanded", () => {
  const long = "x".repeat(500);
  const e = searchEntry([searchHitView(hit(payload("fact", long), 0.5))]);
  assert.equal(spanText(renderOut(e, { expanded: true })[1]), long);
});

test("search hit with no pointer says so", () => {
  const v = searchHitView(hit(payload("fact", "orphan"), 0.4));
  assert.equal(v.pointer, "no source pointer");
});

test("search hit tolerates a payload without text", () => {
  const broken = { type: "decision", project_id: "p", ts: 1, source_kind: "remember_tool" } as unknown as PointPayload;
  const v = searchHitView(hit(broken, 0.5));
  assert.equal(v.text, "");
});

test("search zero hits falls back to a plain message line", () => {
  const lines = renderOut(searchEntry([]));
  assert.equal(lines.length, 1);
  assert.equal(spanText(lines[0]), "No relevant memory found.");
});

test("typeRole maps every memory type to a semantic slot", () => {
  assert.equal(typeRole("decision"), "accent");
  assert.equal(typeRole("fact"), "success");
  assert.equal(typeRole("constraint"), "warning");
  assert.equal(typeRole("preference"), "dim");
  assert.equal(typeRole("session_summary"), "muted");
});

test("message splitting on newlines keeps error wording in error kind only", () => {
  const e: OutEntry = message("settings: scoreThreshold updated (reloaded at runtime)");
  assert.equal(outText(e), "settings: scoreThreshold updated (reloaded at runtime)");
});

test("memoryHeaderText renders the count-bearing footer variant when points are known", () => {
  assert.equal(
    memoryHeaderText({ mode: "mode2", collection: "pi-mem-abc", points: 42 }),
    "🧠 Memory (42): mode2 (pi-mem-abc)");
  assert.equal(
    memoryHeaderText({ mode: "mode2", collection: "pi-mem-abc", points: 0 }),
    "🧠 Memory (0): mode2 (pi-mem-abc)");
});
