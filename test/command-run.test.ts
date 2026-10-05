import test from "node:test";
import assert from "node:assert/strict";
import { ARG_SHAPE, INDEX_KINDS, USAGE_KEYS } from "../src/commands.ts";
import type { IndexKind } from "../src/commands.ts";
import { runQdrantCommand } from "../src/command-run.ts";
import type { CommandDeps, CommandUi } from "../src/command-run.ts";
import { commandUsageText, indexUsageText } from "../src/out.ts";
import type { OutEntry } from "../src/out.ts";
import type { HandlerIO, SettingsUI } from "../src/handlers.ts";
import type { SettingsHost } from "../src/host-bridge.ts";
import type { MountFn } from "../src/settings-ui.ts";
import type { QdrantLike } from "../src/qdrant.ts";
import type { SyncResult } from "../src/code-sync.ts";
import type { Config } from "../src/types.ts";

// ── Harness ───────────────────────────────────────────────────────────────────
// The dispatcher takes every runtime touchpoint through `CommandDeps`, so these
// tests drive the real routing code with a fake IO and a fake invocation UI —
// no WireApi, no pi surface, no filesystem.

const cfg: Config = {
  qdrantUrl: "http://localhost:6333", qdrantApiKey: null,
  embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text", embeddingApiKey: null,
  expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10, mode: "own",
  codeKnowledge: "off", codeScoreThreshold: 0.4, memoryForget: "off",
};

const qdrant: QdrantLike = {
  async ensureCollection() { return "exists"; },
  async collectionDimension() { return undefined; },
  async upsert() {},
  async search() { return []; },
  async count() { return 0; },
  async clearCollection() {},
  deletePointsByFiles: async () => {},
  codeIndexSnapshot: async () => new Map(),
  countBySourceKind: async () => 0,
  countCodeSymbols: async () => 0,
  deletePointsBySourceKind: async () => {},
  deletePointsBySourceEntryIds: async () => {},
  deletePointsByIds: async (_name, ids) => ids.length,
  existingPointIds: async () => new Set<string>(),
};

interface FakeIO extends HandlerIO {
  /** Every structured entry the dispatch emitted, in order. */
  emitted: OutEntry[];
  /** Every text handed to `embed` — the observable seam for verbatim arguments. */
  embedded: string[];
}

function fakeIO(over: Partial<HandlerIO> = {}): FakeIO {
  const emitted: OutEntry[] = [];
  const embedded: string[] = [];
  const live: Config = over.cfg ?? cfg;
  const io: HandlerIO = {
    cfg: live,
    agentDir: "/tmp/agent",
    cwd: "/repo",
    projectId: "pi-mem-abc",
    embed: async (t) => { embedded.push(t); return new Array(768).fill(0.1); },
    qdrant,
    readGlobalConfig: () => live,
    writeGlobalConfig: () => {},
    readProjectSettings: () => ({}),
    writeProjectSettings: () => {},
    clearProjectSetting: () => {},
    emit: (e) => { emitted.push(e); },
    ...over,
  };
  return Object.assign(io, { emitted, embedded });
}

const okSync = (): SyncResult => ({ ok: true, files: 2, symbols: 5, skipped: 0, deleted: 1 });

interface Harness {
  io: FakeIO;
  deps: CommandDeps;
  notices: () => number;
  refreshes: () => number;
  indexed: IndexKind[];
}

function harness(over: {
  io?: Partial<HandlerIO>;
  ui?: CommandUi;
  host?: Partial<SettingsHost>;
  index?: (kind: IndexKind) => Promise<SyncResult>;
} = {}): Harness {
  const io = fakeIO(over.io);
  let noticeCount = 0;
  let refreshCount = 0;
  const indexed: IndexKind[] = [];
  const deps: CommandDeps = {
    io,
    ...(over.ui ? { ui: over.ui } : {}),
    ...(over.host ? { host: over.host } : {}),
    index: async (kind) => { indexed.push(kind); return over.index ? over.index(kind) : okSync(); },
    notice: () => { noticeCount++; },
    refreshStatus: () => { refreshCount++; },
  };
  return { io, deps, notices: () => noticeCount, refreshes: () => refreshCount, indexed };
}

function entryTexts(io: FakeIO): string[] {
  return io.emitted.map((e) => ("text" in e ? e.text : ""));
}

/** The dialog trio `CommandUi.dialogs` carries, scripted per test. */
function dialogs(over: Partial<SettingsUI> = {}): SettingsUI {
  return {
    async select() { return undefined; },
    async input() { return undefined; },
    async confirm() { return true; },
    ...over,
  };
}

/** A host bridge fake good enough for the dispatch to consider mounting. */
function fakeBridge(): Partial<SettingsHost> {
  return {
    SettingsList: class { render() { return []; } invalidate() {} handleInput() {} updateValue() {} } as never,
    Input: class { getValue() { return ""; } setValue() {} handleInput() {} render() { return []; } invalidate() {} } as never,
    getSettingsListTheme: () => ({
      label: (t: string) => t, value: (t: string) => t, description: (t: string) => t, cursor: "", hint: (t: string) => t,
    }),
  };
}

const mountSpy = (onMount: () => void): MountFn =>
  (async () => { onMount(); return undefined; }) as unknown as MountFn;

// ── Parse + shape errors: one entry each, never a dispatch ────────────────────

test("an unknown key emits exactly one error entry carrying the derived usage line", async () => {
  const h = harness();
  await runQdrantCommand("bogus thing", h.deps);
  assert.equal(h.io.emitted.length, 1);
  assert.equal(h.io.emitted[0]!.kind, "error");
  // The key list is read from ARG_SHAPE, never restated here (#62).
  assert.deepEqual([...USAGE_KEYS], Object.keys(ARG_SHAPE));
  assert.equal(entryTexts(h.io)[0], `error: unknown key "bogus thing"\n${commandUsageText(USAGE_KEYS)}`);
  assert.equal(h.notices(), 0, "an unknown key has demonstrably not migrated");
});

test("a none key with a remainder is corrected, not silently ignored", async () => {
  const h = harness();
  await runQdrantCommand("status now", h.deps);
  assert.equal(h.io.emitted.length, 1);
  assert.equal(h.io.emitted[0]!.kind, "error");
  assert.equal(entryTexts(h.io)[0], "error: /qdrant status takes no arguments — try /qdrant status");
  assert.equal(h.notices(), 0, "a shape error has demonstrably not migrated");
});

test("/qdrant index prints its usage when the kind is missing, names kinds when unknown", async () => {
  const h = harness({ io: { cfg: { ...cfg, codeKnowledge: "on" } } });
  await runQdrantCommand("index", h.deps);
  assert.equal(entryTexts(h.io).at(-1), indexUsageText(INDEX_KINDS));
  await runQdrantCommand("index documents", h.deps);
  const unknown = h.io.emitted.at(-1)!;
  assert.equal(unknown.kind, "error");
  assert.equal(entryTexts(h.io).at(-1), `error: unknown index value "documents" — accepted: ${Object.keys(INDEX_KINDS).join(", ")}\n${commandUsageText(USAGE_KEYS)}`);
  await runQdrantCommand("index code extra", h.deps);
  assert.equal(entryTexts(h.io).at(-1), "error: unexpected arguments — try /qdrant index code");
  assert.equal(h.notices(), 0, "nothing past the grammar gate may arm the notice");
});

// ── Namespacing the notice + footer seams ─────────────────────────────────────

test("the notice fires for the bare form and every grammar-accepted dispatch, never for a rejection", async () => {
  const accepted = harness();
  await runQdrantCommand("", accepted.deps);
  assert.equal(accepted.notices(), 1, "the bare form is a recognised dispatch");
  await runQdrantCommand("status", accepted.deps);
  assert.equal(accepted.notices(), 2);

  const rejected = harness();
  for (const args of ["bogus", "status now", "clear", "index documents", "clear all extra"]) {
    await runQdrantCommand(args, rejected.deps);
  }
  assert.equal(rejected.notices(), 0, "only a grammar-accepted invocation arms the notice");
});

test("refreshStatus fires for the mutating keys, never for reads or index", async () => {
  const reads = harness({ io: { cfg: { ...cfg, codeKnowledge: "on" } } });
  for (const args of ["status", "help", "search q", "settings", "settings maxResults 5", "index code"]) {
    await runQdrantCommand(args, reads.deps);
  }
  assert.equal(reads.refreshes(), 0, "a read must never repaint the footer");

  const mutations = harness();
  for (const args of ["remember hello", "forget hello", "clear code", "clear all"]) {
    await runQdrantCommand(args, mutations.deps);
  }
  assert.equal(mutations.refreshes(), 4, "every mutating dispatch repaints the footer");
});

// ── Successful keyed dispatch ─────────────────────────────────────────────────

test("bare /qdrant emits the status block and the command list (self-documenting)", async () => {
  const h = harness();
  await runQdrantCommand("", h.deps);
  assert.deepEqual(h.io.emitted.map((e) => e.kind), ["status", "help"]);
  const help = h.io.emitted.at(-1) as { rows: Array<{ cmd: string }> };
  assert.ok(help.rows.some((r) => r.cmd === "/qdrant status"), JSON.stringify(help.rows));
  assert.ok(help.rows.some((r) => r.cmd.startsWith("/qdrant search")));
});

test("/qdrant status and /qdrant help each emit their one block", async () => {
  const h = harness();
  await runQdrantCommand("status", h.deps);
  assert.deepEqual(h.io.emitted.map((e) => e.kind), ["status"]);
  h.io.emitted.length = 0;
  await runQdrantCommand("help", h.deps);
  assert.deepEqual(h.io.emitted.map((e) => e.kind), ["help"]);
});

test("/qdrant search passes the query verbatim, spaces and quotes included", async () => {
  // The embed call is the observable seam for the exact query text: a query with
  // internal runs of spaces and embedded quotes must arrive intact.
  const h = harness();
  await runQdrantCommand("search   the  \"exact  phrase\"   trailing   ", h.deps);
  assert.deepEqual(h.io.embedded, ["the  \"exact  phrase\"   trailing"]);
  assert.match(entryTexts(h.io).join("\n"), /No relevant memory found/);
});

test("/qdrant remember passes its text verbatim", async () => {
  const h = harness();
  await runQdrantCommand("remember   a  \"quoted  fact\"   ", h.deps);
  assert.deepEqual(h.io.embedded, ["a  \"quoted  fact\""]);
  assert.match(entryTexts(h.io).join("\n"), /^remembered: a  "quoted  fact"/);
});

// ── clear ─────────────────────────────────────────────────────────────────────

test("/qdrant clear with a missing, unknown or over-long modifier never clears", async () => {
  let cleared = 0;
  const recording: QdrantLike = { ...qdrant, async clearCollection() { cleared++; } };
  const h = harness({ io: { qdrant: recording } });
  await runQdrantCommand("clear", h.deps);
  assert.match(entryTexts(h.io).join("\n"), /^clear: usage — \/qdrant clear all \| code/m);
  await runQdrantCommand("clear documents", h.deps);
  const unknown = h.io.emitted.at(-1)!;
  assert.equal(unknown.kind, "error");
  assert.match(entryTexts(h.io).at(-1)!, /unknown clear value "documents" — accepted: all, code/);
  await runQdrantCommand("clear all extra", h.deps);
  const tooMany = h.io.emitted.at(-1)!;
  assert.equal(tooMany.kind, "error");
  assert.equal(entryTexts(h.io).at(-1), "error: unexpected arguments — try /qdrant clear all");
  assert.equal(cleared, 0, "no malformed invocation may delete anything");

  // These deps carry no dialog UI: `clear all` must refuse, not delete.
  await runQdrantCommand("clear all", h.deps);
  const refused = h.io.emitted.at(-1)!;
  assert.equal(refused.kind, "error");
  assert.equal(entryTexts(h.io).at(-1), "error: /qdrant clear all requires interactive UI confirmation");
  assert.equal(cleared, 0);
});

test("/qdrant clear ALL clears after confirmation — case variants are not rejected (#61)", async () => {
  // Regression: the old /qdrant-clear handler lowercased its target, so `ALL`
  // worked; the refactor's shape check was case-sensitive and rejected it while
  // completion (case-insensitive) kept suggesting the value.
  for (const token of ["all", "ALL", "All"]) {
    let cleared = 0;
    let confirms = 0;
    const recording: QdrantLike = { ...qdrant, async count() { return 2; }, async clearCollection() { cleared++; } };
    const h = harness({
      io: { qdrant: recording },
      ui: { hasUI: true, mode: "tui", dialogs: dialogs({ confirm: async () => { confirms++; return true; } }) },
    });
    await runQdrantCommand(`clear ${token}`, h.deps);
    assert.equal(confirms, 1, `clear ${token} must reach the confirm dialog`);
    assert.equal(cleared, 1, `clear ${token} must clear`);
    assert.ok(entryTexts(h.io).some((t) => t.includes("cleared: collection pi-mem-abc reset")));
  }
});

test("/qdrant clear ALL extra quotes the canonical command, not the typed one (#61)", async () => {
  const h = harness();
  await runQdrantCommand("clear ALL extra", h.deps);
  const last = h.io.emitted.at(-1)!;
  assert.equal(last.kind, "error");
  assert.equal(entryTexts(h.io).at(-1), "error: unexpected arguments — try /qdrant clear all");
});

// ── index: gate + result rows ─────────────────────────────────────────────────

test("/qdrant index CODE dispatches a real registry kind, not the typed token (#61)", async () => {
  const h = harness({ io: { cfg: { ...cfg, codeKnowledge: "on" } } });
  await runQdrantCommand("index CODE", h.deps);
  // The guard reads INDEX_KINDS[kind]: a raw "CODE" would miss the registry and
  // print the usage line; the canonicalised spelling reaches the runner.
  assert.deepEqual(h.indexed, ["code"], "a case variant runs the same kind as the lowercase form");
  assert.ok(entryTexts(h.io).every((t) => !/unknown index value/.test(t)));
});

test("/qdrant index code answers the disabled guard instead of syncing", async () => {
  const h = harness(); // codeKnowledge: "off"
  await runQdrantCommand("index code", h.deps);
  assert.deepEqual(entryTexts(h.io), ["code memory is disabled (codeKnowledge: off)"]);
  assert.deepEqual(h.indexed, [], "a disabled kind must not sync");
});

test("/qdrant index code emits the count message on success and an error entry on failure", async () => {
  const ok = harness({ io: { cfg: { ...cfg, codeKnowledge: "on" } } });
  await runQdrantCommand("index code", ok.deps);
  assert.deepEqual(entryTexts(ok.io), ["code memory: 2 files · 5 symbols indexed (1 file replaced)"]);

  const failed = harness({
    io: { cfg: { ...cfg, codeKnowledge: "on" } },
    index: async () => ({ ok: false, error: "collection boom", files: 0, symbols: 0, skipped: 0, deleted: 0 }),
  });
  await runQdrantCommand("index code", failed.deps);
  assert.equal(failed.io.emitted.at(-1)!.kind, "error");
  assert.equal(entryTexts(failed.io).at(-1), "code memory: sync failed — collection boom");
});

// ── settings: routing branches ────────────────────────────────────────────────

test("/qdrant settings <key> <value> routes to the shared write path", async () => {
  const h = harness();
  await runQdrantCommand("settings maxResults not-a-number", h.deps);
  assert.match(entryTexts(h.io).join("\n"), /positive integer|maxResults/);
  h.io.emitted.length = 0;
  await runQdrantCommand("settings", h.deps);
  // No dialog-capable UI on the deps → the usage entry, not the form.
  assert.match(entryTexts(h.io).at(-1)!, /settings: usage — \/qdrant settings opens the settings screen/);
});

test("bare /qdrant settings in tui mode mounts the SettingsList screen", async () => {
  let mounted = 0;
  const h = harness({
    ui: { hasUI: true, mode: "tui", dialogs: dialogs({ confirm: async () => false }), custom: mountSpy(() => { mounted++; }) },
    host: fakeBridge(),
  });
  await runQdrantCommand("settings", h.deps);
  assert.equal(mounted, 1, "tui mode mounts the modal");
  // The dialog form must NOT also run.
  assert.ok(!entryTexts(h.io).some((t) => t.startsWith("settings: usage")));
});

test("bare /qdrant settings in rpc mode runs the dialog form, never the modal", async () => {
  let mounted = 0;
  let selects = 0;
  const h = harness({
    ui: { hasUI: true, mode: "rpc", dialogs: dialogs({ select: async () => { selects++; return undefined; } }), custom: mountSpy(() => { mounted++; }) },
    host: fakeBridge(),
  });
  await runQdrantCommand("settings", h.deps);
  assert.equal(selects, 1, "rpc keeps the dialog sequence");
  assert.equal(mounted, 0, "rpc's ctx.ui.custom is a silent no-op, so it must never be mounted");
});

test("bare /qdrant settings with no dialog UI falls back to the usage entry", async () => {
  const h = harness({ ui: { hasUI: false, mode: "print" } });
  await runQdrantCommand("settings", h.deps);
  assert.ok(
    entryTexts(h.io).some((t) => t.startsWith("settings: usage")),
    `expected the usage entry, got ${JSON.stringify(entryTexts(h.io))}`,
  );
});

test("tui mode with an unresolved host bridge degrades to the dialog form (never throws)", async () => {
  let mounted = 0;
  let selects = 0;
  const h = harness({
    ui: { hasUI: true, mode: "tui", dialogs: dialogs({ select: async () => { selects++; return undefined; } }), custom: mountSpy(() => { mounted++; }) },
    host: {}, // SettingsList is missing — the bridge did not resolve
  });
  await runQdrantCommand("settings", h.deps);
  assert.equal(mounted, 0, "an incomplete bridge must not mount a half-built screen");
  assert.equal(selects, 1, "it degrades to the dialog form instead");
});
