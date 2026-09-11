import test from "node:test";
import assert from "node:assert/strict";
import {
  message, errorEntry, helpEntry, statusEntry, searchEntry, searchHitView,
  renderOut, outText, typeRole, memoryHeaderText, codeMemoryReloadNotice, codeMemorySyncMessage,
  displayValue, settingsScopeLabel, settingsUsageText, settingsUpdatedText, settingsGlobalUpdatedText,
  settingsOverrideClearedText, resetOptionLabel, formNumericPrompt, formSaveMessage, formClearMessage,
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
  assert.doesNotMatch(text, /project settings:/); // no overrides → quiet
  // Collection id lives in the header; the old separate `collection:` row is gone.
  assert.doesNotMatch(text, /^collection: /m);
  // No detail is hidden behind an expand gesture — expanded renders identically.
  assert.deepEqual(renderOut(e, { expanded: true }), lines);
});

test("status renders the project-settings row for one key and for both", () => {
  const one = statusEntry({ ...health, projectSettings: [{ key: "codeKnowledge", value: "on", globalValue: "off" }] });
  const linesOne = renderOut(one);
  assert.equal(spanText(linesOne.at(-1)!), "project settings: codeKnowledge = on (global: off)");

  const both = statusEntry({ ...health, projectSettings: [
    { key: "codeKnowledge", value: "on", globalValue: "off" },
    { key: "codeScoreThreshold", value: 0.6, globalValue: 0.55 },
  ] });
  const linesBoth = renderOut(both);
  assert.equal(spanText(linesBoth.at(-1)!),
    "project settings: codeKnowledge = on (global: off); codeScoreThreshold = 0.6 (global: 0.55)");
});

test("status omits the project-settings row for undefined or empty overrides", () => {
  const undef = renderOut(statusEntry(health));
  assert.ok(!undef.some((l) => spanText(l).startsWith("project settings:")));
  const empty = renderOut(statusEntry({ ...health, projectSettings: [] }));
  assert.deepEqual(empty, undef);
});

test("project-settings numeric value renders as its stored form (never toFixed)", () => {
  const lines = renderOut(statusEntry({ ...health, projectSettings: [{ key: "codeScoreThreshold", value: 0.6, globalValue: 0.5 }] }));
  assert.equal(spanText(lines.at(-1)!), "project settings: codeScoreThreshold = 0.6 (global: 0.5)");
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

test("search hit pointer uses file_path for code hits (line-level and file-level)", () => {
  const line = searchHitView(hit(payload("code", "function f — src/a.ts:2-4 — f()", { source_kind: "code_summary", file_path: "src/a.ts", start_line: 2, end_line: 4 }), 0.9));
  assert.equal(line.pointer, "src/a.ts:2");
  const file = searchHitView(hit(payload("code", "src/qdrant.ts — 7 definitions", { source_kind: "code_summary", file_path: "src/qdrant.ts" }), 0.64));
  assert.equal(file.pointer, "src/qdrant.ts");
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

test("typeRole maps code to the muted slot", () => {
  assert.equal(typeRole("code"), "muted");
});

test("status lines render code-memory rows in all three states", () => {
  const base = { mode: "mode2", embeddings: { state: "ok" as const }, detail: {
    collection: "pi-mem-abc", qdrantUrl: "http://x", model: "m", dimension: 768,
    threshold: 0.18, maxResults: 10,
  } };
  const off = outText(statusEntry({ ...base, qdrant: { state: "err" }, codeMemory: { state: "off" } }));
  assert.match(off, /code memory: off/);
  const syncing = outText(statusEntry({ ...base, qdrant: { state: "err" }, codeMemory: { state: "syncing" } }));
  assert.match(syncing, /on \(syncing…\)/);
  const synced = outText(statusEntry({ ...base, qdrant: { state: "err" }, codeMemory: { state: "synced", files: 4, symbols: 21 } }));
  assert.match(synced, /code memory: ✓ 4 files · 21 symbols/);
  const failed = outText(statusEntry({ ...base, qdrant: { state: "err" }, codeMemory: { state: "error", error: "boom" } }));
  assert.match(failed, /code memory: ✗ sync failed/);
});

test("codeMemoryReloadNotice is direction-aware", () => {
  assert.match(codeMemoryReloadNotice("on"), /registers on reload/);
  assert.match(codeMemoryReloadNotice("off"), /unregisters on reload/);
  assert.equal(codeMemorySyncMessage({ files: 2, symbols: 9, deleted: 1 }),
    "code memory: 2 files · 9 symbols indexed (1 points replaced)");
});

// ── settings scope builders ──────────────────────────────────────────────────

test("displayValue renders null and numbers", () => {
  assert.equal(displayValue(null), "null");
  assert.equal(displayValue(0.6), "0.6");
  assert.equal(displayValue("off"), "off");
});

test("settingsScopeLabel annotates both wordings", () => {
  const row = { key: "codeKnowledge", value: "on", globalValue: "off", overridden: true };
  assert.equal(settingsScopeLabel(row), "codeKnowledge = on (this project; global: off)");
  assert.equal(settingsScopeLabel(row, "inherited from global"), "codeKnowledge = on (this project; global: off)");
  const noOverride = { key: "qdrantUrl", value: "http://localhost:6333", globalValue: "http://localhost:6333", overridden: false };
  assert.equal(settingsScopeLabel(noOverride), "qdrantUrl = http://localhost:6333 (global)");
  assert.equal(settingsScopeLabel(noOverride, "inherited from global"), "qdrantUrl = http://localhost:6333 (inherited from global)");
});

test("settingsUsageText is one multi-line string naming the scope rule and both paths", () => {
  const text = settingsUsageText({
    projectPath: "/a/pi-qdrant-memory/projects/pi-mem-abc.json",
    globalPath: "/a/pi-qdrant-memory/pi-qdrant-memory-config.json",
    rows: [
      { key: "codeKnowledge", value: "off", globalValue: "off", overridden: false },
      { key: "codeScoreThreshold", value: 0.6, globalValue: 0.55, overridden: true },
    ],
  });
  const lines = text.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "settings: usage — /qdrant-settings opens the form; /qdrant-settings <key> <value> sets a field.");
  assert.match(lines[1], /^ {10}codeKnowledge and codeScoreThreshold are per project \(\/a\/pi-qdrant-memory\/projects\/pi-mem-abc\.json\);$/);
  assert.match(lines[2], /^ {10}the other keys are global \(\/a\/pi-qdrant-memory\/pi-qdrant-memory-config\.json\)\.$/);
  assert.equal(lines[3], "          this project: codeKnowledge = off (inherited from global); codeScoreThreshold = 0.6 (this project; global: 0.55)");
});

test("settings set/clear/global confirmation strings", () => {
  assert.equal(settingsUpdatedText("codeKnowledge", "on", "off"), "settings: codeKnowledge = on (this project; global: off)");
  assert.equal(settingsUpdatedText("codeScoreThreshold", 0.6, 0.55), "settings: codeScoreThreshold = 0.6 (this project; global: 0.55)");
  assert.equal(settingsOverrideClearedText("codeKnowledge", "off"), "settings: codeKnowledge override cleared (now using global: off)");
  assert.equal(settingsGlobalUpdatedText("qdrantUrl"), "settings: qdrantUrl updated (global config; reloaded at runtime)");
});

test("form builders produce the destination-naming strings", () => {
  assert.equal(resetOptionLabel("off"), "default (inherit global: off)");
  assert.equal(formNumericPrompt("codeScoreThreshold", 0.55), 'codeScoreThreshold (number; "default" inherits global: 0.55)');
  assert.equal(
    formSaveMessage("codeScoreThreshold", 0.6, 0.4, "project", 0.55),
    "codeScoreThreshold = 0.6 → this project's settings file (global: 0.55) (was 0.4; run /qdrant-settings again to edit another field)",
  );
  assert.equal(
    formSaveMessage("qdrantUrl", "http://x:6333", "http://localhost:6333", "global"),
    "qdrantUrl = http://x:6333 → the global config file (was http://localhost:6333; run /qdrant-settings again to edit another field)",
  );
  assert.equal(formClearMessage("codeScoreThreshold", 0.55), "codeScoreThreshold returns to the global value (0.55)");
});
