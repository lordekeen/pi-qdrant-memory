import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { wireApi } from "../src/index.ts";
import type { CommandUi, WireApi } from "../src/index.ts";
import type { CustomFactoryArgs, MountFn, SettingsComponent } from "../src/settings-ui.ts";
import type { SettingsUI } from "../src/handlers.ts";
import type { Config, RuntimeDeps } from "../src/types.ts";
import type { QdrantLike } from "../src/qdrant.ts";
import { QdrantError } from "../src/qdrant.ts";
import { readEffectiveConfig, saveProjectSettings } from "../src/project-settings.ts";
import { takeLoadWarnings } from "../src/project-settings.ts";
import { configPath, readGlobalConfig } from "../src/config.ts";
import { readState, statePath } from "../src/state.ts";
import { projectIdFrom } from "../src/project.ts";
import { pointId } from "../src/ids.ts";
import { outText } from "../src/out.ts";
import type { OutEntry } from "../src/out.ts";
import { COMMAND_ROWS } from "../src/handlers.ts";
import { ARG_SHAPE, INDEX_KINDS, USAGE_KEYS } from "../src/commands.ts";
import { commandUsageText, indexUsageText, COMMAND_FORMAT_NOTICE_TEXT } from "../src/out.ts";

async function settle(): Promise<void> {
  // refreshStatus is fire-and-forget; yield two ticks so its awaits resolve.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

function fakeApi(): WireApi & { tools: unknown[]; commands: unknown[]; events: Record<string, unknown[]>; entries: unknown[]; statuses: string[] } {
  const api = {
    tools: [], commands: [], events: {} as Record<string, unknown[]>, entries: [], statuses: [],
    registerTool(d: unknown) { (api.tools as unknown[]).push(d); },
    registerCommand(d: unknown) { (api.commands as unknown[]).push(d); },
    on(ev: string, h: (p: unknown) => void | Promise<void>) {
      if (!api.events[ev]) api.events[ev] = [];
      const index = api.events[ev].length;
      api.events[ev].push(h);
      return () => { api.events[ev].splice(index, 1); };
    },
    appendEntry(_t: string, d: unknown) { (api.entries as unknown[]).push(d); },
    setStatus(t: string) { (api.statuses as string[]).push(t); },
  };
  return api as WireApi & typeof api;
}

/**
 * A live command-UI view for the CURRENT invocation (#56). The wireApi seam is
 * `commandUI()`, never a captured ctx, so a test states the mode/hasUI of the
 * invocation it is simulating.
 */
function withCommandUI(
  api: ReturnType<typeof fakeApi>,
  view: Partial<CommandUi> & { dialogs?: SettingsUI; custom?: MountFn },
): ReturnType<typeof fakeApi> {
  return { ...api, commandUI: () => view as CommandUi };
}

const qdrant: QdrantLike = {
  async ensureCollection() { return "exists"; },
  async upsert() {},
  async search() { return []; },
  async count() { return 0; },
  async clearCollection() {},
  deletePointsByFiles: async () => {},
  codeIndexSnapshot: async () => new Map(),
  countBySourceKind: async () => 0,
  countCodeSymbols: async () => 0,
};

const rt: RuntimeDeps = {
  cfg: { qdrantUrl: "http://localhost:6333", qdrantApiKey: null, embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text", embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10, mode: "own", codeKnowledge: "off", codeScoreThreshold: 0.4, memoryForget: "off" },
  agentDir: "/tmp/agent", cwd: "/repo", projectId: "pi-mem-abc",
  embed: async () => new Array(768).fill(0.1), qdrant,
  readGlobalConfig: () => rt.cfg, writeGlobalConfig: () => {}, reloadEffectiveConfig: () => {}, print: () => {},
};

test("wireApi registers memory_save and memory_search tools", () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt);
  try {
    assert.equal(api.tools.length, 2);
    const names = (api.tools as Array<{ name: string }>).map((t) => t.name).sort();
    assert.deepEqual(names, ["memory_save", "memory_search"]);
  } finally { cleanup(); }
});

test("wireApi registers exactly one /qdrant command (the hard cut)", () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt);
  try {
    // One registration, no aliases: the eight /qdrant-* names are gone (A.4).
    assert.deepEqual((api.commands as Array<{ name: string }>).map((c) => c.name), ["qdrant"]);
    assert.ok(!(api.commands as Array<{ name: string }>).some((c) => c.name.startsWith("qdrant-")));
  } finally { cleanup(); }
});

test("wireApi's help rows stay in parity with the dispatch grammar (OI-009)", () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt);
  try {
    // One documented row per ARG_SHAPE key, in the same order.
    assert.deepEqual(COMMAND_ROWS.map((r) => r.name), Object.keys(ARG_SHAPE));
    assert.ok(COMMAND_ROWS.every((r) => r.cmd.startsWith(`/qdrant ${r.name}`)), "every row names its key");
  } finally { cleanup(); }
});

test("the registered command description is one imperative line (#62)", () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt);
  try {
    const cmd = (api.commands as Array<{ name: string; description: string }>).find((c) => c.name === "qdrant")!;
    // Imperative lead, not a noun list: the host shows this in the command
    // palette, where "Project memory: status, search, …" read as a label.
    assert.equal(cmd.description, "Show status, search memories, and manage settings for this project");
    assert.equal(cmd.description.split("\n").length, 1, "one line only");
  } finally { cleanup(); }
});

test("wireApi in own mode registers session_before_compact handler", () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt); // mode: own → mode2
  try {
    assert.ok(api.events["session_before_compact"], "expected session_before_compact hook in mode2");
  } finally { cleanup(); }
});

test("cleanup removes handlers", () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt);
  cleanup();
  assert.equal(api.events["session_before_compact"].length, 0);
});

test("session_start repaints the footer with the stored-memory count", async () => {
  const counted: QdrantLike = { ...qdrant, async count() { return 7; } };
  const localRt: RuntimeDeps = { ...rt, qdrant: counted };
  const api = fakeApi();
  const cleanup = wireApi(api, localRt);
  try {
    const onStart = api.events["session_start"][0] as (p: unknown, ctx?: unknown) => Promise<void>;
    await onStart({}, {});
    await settle();
    const last = api.statuses.at(-1);
    assert.ok(last);
    assert.match(last, /🧠 Memory \(7\): mode2 \(pi-mem-abc\)/);
  } finally { cleanup(); }
});

test("statusline falls back to a count-less header when Qdrant is unreachable", async () => {
  const down: QdrantLike = { ...qdrant, async count() { throw new QdrantError("unreachable"); } };
  const localRt: RuntimeDeps = { ...rt, qdrant: down };
  const api = fakeApi();
  const cleanup = wireApi(api, localRt);
  try {
    const onStart = api.events["session_start"][0] as (p: unknown, ctx?: unknown) => Promise<void>;
    await onStart({}, {});
    await settle();
    const last = api.statuses.at(-1);
    assert.ok(last);
    // No count in the header, but the mode + collection state stays visible.
    assert.doesNotMatch(last, /Memory \(\d+\)/);
    assert.match(last, /🧠 Memory: mode2 \(pi-mem-abc\)/);
  } finally { cleanup(); }
});

test("statusline reports 0 memories when the collection does not exist yet", async () => {
  const fresh: QdrantLike = {
    ...qdrant,
    async count() { throw new QdrantError("HTTP 404", 404); },
  };
  const localRt: RuntimeDeps = { ...rt, qdrant: fresh };
  const api = fakeApi();
  const cleanup = wireApi(api, localRt);
  try {
    const onStart = api.events["session_start"][0] as (p: unknown, ctx?: unknown) => Promise<void>;
    await onStart({}, {});
    await settle();
    const last = api.statuses.at(-1);
    assert.ok(last);
    assert.match(last, /🧠 Memory \(0\): mode2 \(pi-mem-abc\)/);
  } finally { cleanup(); }
});

const onRt: RuntimeDeps = { ...rt, cfg: { ...rt.cfg, codeKnowledge: "on" } };

test("code_memory tool gates on codeKnowledge; /qdrant index code is always dispatchable", () => {
  const on = fakeApi();
  const off = fakeApi();
  const onCleanup = wireApi(on, onRt);
  const offCleanup = wireApi(off, rt);
  try {
    const onTools = (on.tools as Array<{ name: string }>).map((t) => t.name);
    const offTools = (off.tools as Array<{ name: string }>).map((t) => t.name);
    assert.ok(onTools.includes("code_memory"), "expected code_memory when on");
    assert.ok(!offTools.includes("code_memory"), "no code_memory when off");
    // The single command registers unconditionally (live-config guard per kind
    // inside) so the §12 "index right away" notice is keepable right after an
    // off→on flip.
    assert.deepEqual((on.commands as Array<{ name: string }>).map((c) => c.name), ["qdrant"]);
    assert.deepEqual((off.commands as Array<{ name: string }>).map((c) => c.name), ["qdrant"]);
  } finally { onCleanup(); offCleanup(); }
});

/** The registered command's raw-args entry point (pi splits on the first space). */
function qdrantCmd(api: { commands: unknown[] }): (args: string) => Promise<void> {
  const cmd = (api.commands as Array<{ name: string; execute: (args: string) => Promise<void> }>)
    .find((c) => c.name === "qdrant")!;
  return (args: string) => cmd.execute(args);
}

function entryTexts(api: { entries: unknown[] }): string[] {
  return (api.entries as Array<{ text?: string }>).map((e) => e.text ?? "");
}

test("/qdrant index code emits the count message on success and an error entry on failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-cmd-"));
  try {
    writeFileSync(join(root, "a.ts"), "export function alpha() {}\n");
    const localRt: RuntimeDeps = { ...onRt, cwd: root, embedBatch: async (t: string[]) => t.map(() => new Array(768).fill(0.1)) };
    const api = fakeApi();
    const cleanup = wireApi(api, localRt);
    try {
      await qdrantCmd(api)("index code");
      const texts = entryTexts(api);
      assert.ok(texts.some((t) => /^code memory: 1 files · 1 symbols indexed \(1 file replaced\)$/.test(t)), JSON.stringify(texts));

      // Failure path: sync reports ok:false → error entry (spec §10.1).
      const brokenRt: RuntimeDeps = {
        ...onRt, cwd: root, qdrant: {
          ...qdrant,
          async ensureCollection() { throw new Error("collection boom"); },
        },
      };
      const api2 = fakeApi();
      const cleanup2 = wireApi(api2, brokenRt);
      try {
        await qdrantCmd(api2)("index code");
        const texts2 = (api2.entries as Array<{ kind?: string; text?: string }>).map((e) => ({ kind: e.kind, text: e.text ?? "" }));
        const errEntry = texts2.find((t) => t.text.includes("code memory: sync failed"));
        assert.ok(errEntry, JSON.stringify(texts2));
        assert.equal(errEntry!.kind, "error");
      } finally { cleanup2(); }
    } finally { cleanup(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── /qdrant dispatch ──────────────────────────────────────────────────────────

test("bare /qdrant emits the status block and the command list (self-documenting)", async () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt);
  try {
    await qdrantCmd(api)("");
    const kinds = (api.entries as Array<{ kind: string }>).map((e) => e.kind);
    assert.deepEqual(kinds, ["status", "help"]);
    const help = api.entries.at(-1) as { rows: Array<{ cmd: string }> };
    assert.ok(help.rows.some((r) => r.cmd === "/qdrant status"), JSON.stringify(help.rows));
    assert.ok(help.rows.some((r) => r.cmd.startsWith("/qdrant search")));
  } finally { cleanup(); }
});

test("/qdrant status and /qdrant help each emit their one block", async () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt);
  try {
    await qdrantCmd(api)("status");
    assert.deepEqual((api.entries as Array<{ kind: string }>).map((e) => e.kind), ["status"]);
    api.entries.length = 0;
    await qdrantCmd(api)("help");
    assert.deepEqual((api.entries as Array<{ kind: string }>).map((e) => e.kind), ["help"]);
  } finally { cleanup(); }
});

test("/qdrant search passes the query verbatim, spaces and quotes included", async () => {
  // The embed call is the observable seam for the exact query text: a query with
  // internal runs of spaces and embedded quotes must arrive intact.
  const embedded: string[] = [];
  const api = fakeApi();
  const cleanup = wireApi(api, { ...rt, embed: async (t: string) => { embedded.push(t); return new Array(768).fill(0.1); } });
  try {
    await qdrantCmd(api)("search   the  \"exact  phrase\"   trailing   ");
    assert.deepEqual(embedded, ["the  \"exact  phrase\"   trailing"]);
    assert.match(entryTexts(api).join("\n"), /No relevant memory found/);
  } finally { cleanup(); }
});

test("/qdrant remember passes its text verbatim", async () => {
  const embedded: string[] = [];
  const api = fakeApi();
  const cleanup = wireApi(api, { ...rt, embed: async (t: string) => { embedded.push(t); return new Array(768).fill(0.1); } });
  try {
    await qdrantCmd(api)("remember   a  \"quoted  fact\"   ");
    assert.deepEqual(embedded, ["a  \"quoted  fact\""]);
    assert.match(entryTexts(api).join("\n"), /^remembered: a  "quoted  fact"/);
  } finally { cleanup(); }
});

test("a none key with a remainder is corrected, not silently ignored", async () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt);
  try {
    await qdrantCmd(api)("status now");
    const entries = api.entries as Array<{ kind: string; text?: string }>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "error");
    assert.equal(entries[0].text, "error: /qdrant status takes no arguments — try /qdrant status");
  } finally { cleanup(); }
});

test("an unknown key emits exactly one error entry carrying the derived usage line", async () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt);
  try {
    await qdrantCmd(api)("bogus thing");
    const entries = api.entries as Array<{ kind: string; text?: string }>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "error");
    // The key list is read from ARG_SHAPE, never restated here (#62).
    assert.deepEqual([...USAGE_KEYS], Object.keys(ARG_SHAPE));
    assert.equal(entries[0].text, `error: unknown key "bogus thing"\n${commandUsageText(USAGE_KEYS)}`);
  } finally { cleanup(); }
});

test("/qdrant clear with a missing, unknown or over-long modifier never clears", async () => {
  let cleared = 0;
  const recording: QdrantLike = { ...qdrant, async clearCollection() { cleared++; } };
  const api = fakeApi();
  const cleanup = wireApi(api, { ...rt, qdrant: recording });
  try {
    await qdrantCmd(api)("clear");
    assert.match(entryTexts(api).join("\n"), /^clear: usage — \/qdrant clear all \| code/m);
    await qdrantCmd(api)("clear documents");
    const unknown = (api.entries as Array<{ kind: string; text?: string }>).at(-1)!;
    assert.equal(unknown.kind, "error");
    assert.match(unknown.text!, /unknown clear value "documents" — accepted: all, code/);
    await qdrantCmd(api)("clear all extra");
    const tooMany = (api.entries as Array<{ kind: string; text?: string }>).at(-1)!;
    assert.equal(tooMany.kind, "error");
    assert.equal(tooMany.text, "error: unexpected arguments — try /qdrant clear all");
    assert.equal(cleared, 0, "no malformed invocation may delete anything");

    // This fake api has no commandUI: `clear all` must refuse, not delete.
    await qdrantCmd(api)("clear all");
    const refused = (api.entries as Array<{ kind: string; text?: string }>).at(-1)!;
    assert.equal(refused.kind, "error");
    assert.equal(refused.text, "error: /qdrant clear all requires interactive UI confirmation");
    assert.equal(cleared, 0);
  } finally { cleanup(); }
});

test("/qdrant clear all dispatches the live dialog UI and clears on confirm", async () => {
  let cleared = 0;
  const recording: QdrantLike = { ...qdrant, async count() { return 2; }, async clearCollection() { cleared++; } };
  let confirms = 0;
const api = withCommandUI(fakeApi(), {
      hasUI: true, mode: "tui",
      dialogs: { async select() { return undefined; }, async input() { return undefined; }, async confirm() { confirms++; return true; } },
    });
  const cleanup = wireApi(api, { ...rt, qdrant: recording });
  try {
    await qdrantCmd(api)("clear all");
    assert.equal(confirms, 1, "the dispatch passes the live UI into the handler");
    assert.equal(cleared, 1);
  } finally { cleanup(); }
});

test("/qdrant clear ALL clears after confirmation — case variants are not rejected (#61)", async () => {
  // Regression: the old /qdrant-clear handler lowercased its target, so `ALL`
  // worked; the refactor's shape check was case-sensitive and rejected it while
  // completion (case-insensitive) kept suggesting the value.
  for (const token of ["all", "ALL", "All"]) {
    let cleared = 0;
    const recording: QdrantLike = { ...qdrant, async count() { return 2; }, async clearCollection() { cleared++; } };
    let confirms = 0;
    const api = withCommandUI(fakeApi(), {
      hasUI: true, mode: "tui",
      dialogs: { async select() { return undefined; }, async input() { return undefined; }, async confirm() { confirms++; return true; } },
    });
    const cleanup = wireApi(api, { ...rt, qdrant: recording });
    try {
      await qdrantCmd(api)(`clear ${token}`);
      assert.equal(confirms, 1, `clear ${token} must reach the confirm dialog`);
      assert.equal(cleared, 1, `clear ${token} must clear`);
      assert.ok(entryTexts(api).some((t) => t.includes("cleared: collection pi-mem-abc reset")));
    } finally { cleanup(); }
  }
});

test("/qdrant index CODE dispatches a real registry kind, not the typed token (#61)", async () => {
  let snapshots = 0;
  const recording: QdrantLike = { ...qdrant, async codeIndexSnapshot() { snapshots++; return new Map(); } };
  const api = fakeApi();
  const cleanup = wireApi(api, { ...onRt, qdrant: recording });
  try {
    await qdrantCmd(api)("index CODE");
    // The guard reads INDEX_KINDS[kind]: a raw "CODE" would miss the registry
    // and throw; the canonicalised spelling reaches the gate and the runner.
    assert.equal(snapshots, 1, "a case variant runs the same kind as the lowercase form");
    assert.ok(entryTexts(api).every((t) => !/unknown index value/.test(t)));
  } finally { cleanup(); }
});

test("/qdrant clear ALL extra quotes the canonical command, not the typed one (#61)", async () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt);
  try {
    await qdrantCmd(api)("clear ALL extra");
    const last = (api.entries as Array<{ kind: string; text?: string }>).at(-1)!;
    assert.equal(last.kind, "error");
    assert.equal(last.text, "error: unexpected arguments — try /qdrant clear all");
  } finally { cleanup(); }
});

test("/qdrant index prints its usage when the kind is missing, names kinds when unknown", async () => {
  const api = fakeApi();
  const cleanup = wireApi(api, onRt);
  try {
    await qdrantCmd(api)("index");
    assert.equal(entryTexts(api).at(-1), indexUsageText(INDEX_KINDS));
    await qdrantCmd(api)("index documents");
    const unknown = (api.entries as Array<{ kind: string; text?: string }>).at(-1)!;
    assert.equal(unknown.kind, "error");
    assert.equal(unknown.text, `error: unknown index value "documents" — accepted: ${Object.keys(INDEX_KINDS).join(", ")}\n${commandUsageText(USAGE_KEYS)}`);
    await qdrantCmd(api)("index code extra");
    const tooMany = (api.entries as Array<{ kind: string; text?: string }>).at(-1)!;
    assert.equal(tooMany.text, "error: unexpected arguments — try /qdrant index code");
  } finally { cleanup(); }
});

test("/qdrant index code answers the disabled guard instead of syncing", async () => {
  let snapshots = 0;
  const recording: QdrantLike = { ...qdrant, async codeIndexSnapshot() { snapshots++; return new Map(); } };
  const api = fakeApi();
  const cleanup = wireApi(api, { ...rt, qdrant: recording }); // codeKnowledge: "off"
  try {
    await qdrantCmd(api)("index code");
    assert.deepEqual(entryTexts(api), ["code memory is disabled (codeKnowledge: off)"]);
    assert.equal(snapshots, 0, "a disabled kind must not sync");
  } finally { cleanup(); }
});

test("/qdrant settings <key> <value> routes to the shared write path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-set-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const api = fakeApi();
    const localRt: RuntimeDeps = { ...rt, agentDir: dir };
    const cleanup = wireApi(api, localRt);
    try {
      await qdrantCmd(api)("settings maxResults not-a-number");
      assert.match(entryTexts(api).join("\n"), /positive integer|maxResults/);
      await qdrantCmd(api)("settings");
      // No dialog-capable ui in the fake → the usage entry, not the form.
      assert.match(entryTexts(api).at(-1)!, /settings: usage — \/qdrant settings opens the settings screen/);
    } finally { cleanup(); }
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the qdrant command exposes two-level argument completion", async () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt);
  try {
    const cmd = (api.commands as Array<{ name: string; getArgumentCompletions?: (p: string) => Array<{ value: string }> | null }>)
      .find((c) => c.name === "qdrant")!;
    assert.deepEqual(cmd.getArgumentCompletions?.("")?.map((c) => c.value), Object.keys(ARG_SHAPE));
    assert.deepEqual(cmd.getArgumentCompletions?.("clear ")?.map((c) => c.value), ["all", "code"]);
    assert.equal(cmd.getArgumentCompletions?.("search "), null);
  } finally { cleanup(); }
});

test("code_memory executes a code-typed search", async () => {
  const api = fakeApi();
  const cleanup = wireApi(api, onRt);
  try {
    const tool = (api.tools as Array<{ name: string; execute: (id: string, p: { query: string }) => Promise<{ content: Array<{ text: string }> }> }>)
      .find((t) => t.name === "code_memory")!;
    const res = await tool.execute("t1", { query: "how does X work" });
    assert.match(res.content[0]!.text, /No memories stored yet/);
  } finally { cleanup(); }
});

test("tool errors name the invoked tool exactly once", async () => {
  const api = fakeApi();
  const cleanup = wireApi(api, onRt); // on → memory_save, memory_search, code_memory all registered
  try {
    type Tool = { name: string; execute: (id: string, p: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> };
    const tools = api.tools as Tool[];
    const save = tools.find((t) => t.name === "memory_save")!;
    const search = tools.find((t) => t.name === "memory_search")!;
    const code = tools.find((t) => t.name === "code_memory")!;

    assert.equal((await save.execute("t", { text: "  " })).content[0]!.text, "remember failed: text is empty");
    assert.equal((await search.execute("t", { query: "  " })).content[0]!.text, "memory_search failed: query is empty");

    const codeErr = (await code.execute("t", { query: "  " })).content[0]!.text;
    assert.equal(codeErr, "code_memory failed: query is empty");
    // Strengthened intent: code_memory's error must never name memory_search,
    // and no message carries the doubled `X failed: X:` shape.
    assert.doesNotMatch(codeErr, /memory_search/);
    assert.doesNotMatch(codeErr, /code_memory failed: code_memory/);
  } finally { cleanup(); }
});

test("session_start runs the code sync and repaints the footer after it", async () => {
  const counted: QdrantLike = {
    ...qdrant,
    async count() { return 5; },
    async codeIndexSnapshot() { return new Map(); },
  };
  const localRt: RuntimeDeps = { ...onRt, qdrant: counted };
  const api = fakeApi();
  const cleanup = wireApi(api, localRt);
  try {
    const onStart = api.events["session_start"][0] as (p: unknown, ctx?: unknown) => Promise<void>;
    await onStart({}, {});
    await settle();
    await settle();
    const last = api.statuses.at(-1);
    assert.ok(last);
    assert.match(last, /🧠 Memory \(5\): mode2 \(pi-mem-abc\)/);
  } finally { cleanup(); }
});

// ── Phase 5: session_start re-anchor + live effective code-sync gate ──────────

function idxAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-qm-idx-"));
}

function gitRepo(dir: string, name: string): string {
  const repo = join(dir, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

/** A runtime whose injected reload swaps ONLY `cfg` — cfg-only, never the
 * clients. Risk 8: a lifecycle unit test must never construct real
 * embedding/Qdrant clients (the production reload calls `applyConfig`). */
function runtimeWith(
  agentDir: string,
  cfg: Config,
  qdrantClient: QdrantLike,
  embedBatch: (texts: string[]) => Promise<number[][]>,
  cwd = "/repo",
): RuntimeDeps {
  const local: RuntimeDeps = {
    cfg,
    agentDir, cwd, projectId: "pi-mem-abc",
    embed: async () => new Array(768).fill(0.1),
    embedBatch,
    qdrant: qdrantClient,
    readGlobalConfig: () => local.cfg,
    writeGlobalConfig: () => {},
    reloadEffectiveConfig: () => { local.cfg = readEffectiveConfig(agentDir, local.projectId, {}); },
    print: () => {},
  };
  return local;
}

test("session_start re-anchors the project and re-resolves the effective config", async () => {
  const agentDir = idxAgentDir();
  try {
    const repo = gitRepo(agentDir, "target");
    const targetId = await projectIdFrom(repo);
    saveProjectSettings(agentDir, targetId, { codeKnowledge: "off" });
    const localRt = runtimeWith(
      agentDir,
      { ...rt.cfg, codeKnowledge: "on" }, // factory-time frozen value
      qdrant,
      async (t) => t.map(() => new Array(768).fill(0.1)),
    );
    const api = fakeApi();
    const cleanup = wireApi(api, localRt);
    try {
      const onStart = api.events["session_start"][0] as (p: unknown, ctx?: unknown) => Promise<void>;
      await onStart({}, { cwd: repo });
      assert.equal(localRt.projectId, targetId); // re-anchored to the hosting repo
      assert.equal(localRt.cfg.codeKnowledge, "off"); // re-resolved for that project
    } finally { cleanup(); }
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test("session_start gate reads the LIVE effective value: an override-off project does not sync", async () => {
  const agentDir = idxAgentDir();
  try {
    const repo = gitRepo(agentDir, "target");
    const targetId = await projectIdFrom(repo);
    saveProjectSettings(agentDir, targetId, { codeKnowledge: "off" });
    let snapshots = 0;
    let embedBatches = 0;
    const recording: QdrantLike = {
      ...qdrant,
      async codeIndexSnapshot() { snapshots++; return new Map(); },
    };
    const localRt = runtimeWith(
      agentDir,
      { ...rt.cfg, codeKnowledge: "on" }, // the FROZEN registration value is on…
      recording,
      async (t) => { embedBatches++; return t.map(() => new Array(768).fill(0.1)); },
    );
    const api = fakeApi();
    const cleanup = wireApi(api, localRt);
    try {
      const onStart = api.events["session_start"][0] as (p: unknown, ctx?: unknown) => Promise<void>;
      await onStart({}, { cwd: repo });
      await settle();
      await settle();
      // …but the live effective value is off, so no sync work may happen. This
      // genuinely fails if the gate reads the frozen `codeMemoryOn` boolean.
      assert.equal(snapshots, 0, "override-off must suppress the code sync even when registration-time codeKnowledge was on");
      assert.equal(embedBatches, 0);

      // Verify codeMemoryState.state was updated to "off" instead of freezing on "syncing" (Issue #43)
      await qdrantCmd(api)("status");
      const statusEntry = api.entries.at(-1) as { kind: string; health: { codeMemory?: { state?: string } } };
      assert.equal(statusEntry.health.codeMemory?.state, "off");
    } finally { cleanup(); }
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test("session_start gate reads the LIVE effective value: an override-on project syncs", async () => {
  const agentDir = idxAgentDir();
  try {
    const repo = gitRepo(agentDir, "target");
    writeFileSync(join(repo, "a.ts"), "export function alpha() {}\n");
    const targetId = await projectIdFrom(repo);
    saveProjectSettings(agentDir, targetId, { codeKnowledge: "on" });
    let snapshots = 0;
    const recording: QdrantLike = {
      ...qdrant,
      async codeIndexSnapshot() { snapshots++; return new Map(); },
    };
    const localRt = runtimeWith(
      agentDir,
      { ...rt.cfg, codeKnowledge: "off" }, // the FROZEN registration value is off…
      recording,
      async (t) => t.map(() => new Array(768).fill(0.1)),
    );
    const api = fakeApi();
    const cleanup = wireApi(api, localRt);
    try {
      const onStart = api.events["session_start"][0] as (p: unknown, ctx?: unknown) => Promise<void>;
      await onStart({}, { cwd: repo });
      await settle();
      await settle();
      // …but the live effective value turned on, so the sync runs (indexing for
      // the next session even though this session's tool set is fixed).
      assert.equal(localRt.cfg.codeKnowledge, "on");
      assert.ok(snapshots >= 1, "override-on must run the code sync even when registration-time codeKnowledge was off");
    } finally { cleanup(); }
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test("/qdrant status reflects collection totals from codeMemoryState after sync", async () => {
  const agentDir = idxAgentDir();
  try {
    const repo = gitRepo(agentDir, "target");
    const sha = (c: string): string => createHash("sha256").update(c).digest("hex");
    const bContent = "export function beta() {}\n";
    const cContent = "export function gamma() {}\n";
    writeFileSync(join(repo, "a.ts"), "export function alpha() {}\n");
    writeFileSync(join(repo, "b.ts"), bContent);
    writeFileSync(join(repo, "c.ts"), cContent);
    const targetId = await projectIdFrom(repo);
    saveProjectSettings(agentDir, targetId, { codeKnowledge: "on" });

    const snapshot = new Map<string, string>([
      ["a.ts", "stale-sha"],
      ["b.ts", sha(bContent)],
      ["c.ts", sha(cContent)],
    ]);

    const recording: QdrantLike = {
      ...qdrant,
      async codeIndexSnapshot() { return snapshot; },
      // countCodeSymbols (not countBySourceKind): file anchors are excluded (#49).
      async countCodeSymbols() { return 18; },
    };
    const localRt = runtimeWith(
      agentDir,
      { ...rt.cfg, codeKnowledge: "on" },
      recording,
      async (t) => t.map(() => new Array(768).fill(0.1)),
    );
    const api = fakeApi();
    const cleanup = wireApi(api, localRt);
    try {
      const onStart = api.events["session_start"][0] as (p: unknown, ctx?: unknown) => Promise<void>;
      await onStart({}, { cwd: repo });
      await settle();
      await settle();

      await qdrantCmd(api)("status");

      const lastEntry = api.entries.at(-1) as { kind: string; health: { codeMemory?: { files?: number; symbols?: number } } };
      assert.equal(lastEntry.kind, "status");
      assert.equal(lastEntry.health.codeMemory?.files, 3); // 3 total files
      assert.equal(lastEntry.health.codeMemory?.symbols, 18); // 18 total symbols
      assert.match(outText(lastEntry as OutEntry), /3 files · 18 symbols/);
    } finally { cleanup(); }
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test("runCodeSync deduplicates concurrent invocations", async () => {
  const agentDir = idxAgentDir();
  try {
    const repo = gitRepo(agentDir, "target");
    writeFileSync(join(repo, "a.ts"), "export function alpha() {}\n");
    const targetId = await projectIdFrom(repo);
    saveProjectSettings(agentDir, targetId, { codeKnowledge: "on" });

    let snapshots = 0;
    const recording: QdrantLike = {
      ...qdrant,
      async codeIndexSnapshot() {
        snapshots++;
        await new Promise((r) => setTimeout(r, 10));
        return new Map();
      },
    };
    const localRt = runtimeWith(
      agentDir,
      { ...rt.cfg, codeKnowledge: "on" },
      recording,
      async (t) => t.map(() => new Array(768).fill(0.1)),
      repo,
    );
    localRt.projectId = targetId;
    const api = fakeApi();
    const cleanup = wireApi(api, localRt);
    try {
      const onStart = api.events["session_start"][0] as (p: unknown, ctx?: unknown) => Promise<void>;
      const cmd = qdrantCmd(api);
      await Promise.all([onStart({}, { cwd: repo }), cmd("index code")]);
      await settle();
      assert.equal(snapshots, 1, "expected exactly one sync, not two concurrent ones");
    } finally { cleanup(); }
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test("runCodeSync sets codeMemoryState to syncing while in-flight", async () => {
  const agentDir = idxAgentDir();
  try {
    const repo = gitRepo(agentDir, "target");
    writeFileSync(join(repo, "a.ts"), "export function alpha() {}\n");
    const targetId = await projectIdFrom(repo);
    saveProjectSettings(agentDir, targetId, { codeKnowledge: "on" });

    let stateDuringSnapshot: string | undefined;
    const api = fakeApi();

    const recording: QdrantLike = {
      ...qdrant,
      async codeIndexSnapshot() {
        await qdrantCmd(api)("status");
        const lastEntry = api.entries.at(-1) as { kind: string; health: { codeMemory?: { state?: string } } };
        stateDuringSnapshot = lastEntry?.health?.codeMemory?.state;
        return new Map();
      },
    };
    const localRt = runtimeWith(
      agentDir,
      { ...rt.cfg, codeKnowledge: "on" },
      recording,
      async (t) => t.map(() => new Array(768).fill(0.1)),
      repo,
    );
    localRt.projectId = targetId;
    const cleanup = wireApi(api, localRt);
    try {
      const cmd = qdrantCmd(api);
      await cmd("index code");
      await settle();
      assert.equal(stateDuringSnapshot, "syncing");
    } finally { cleanup(); }
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test("wireApi registers memory_forget tool only when memoryForget is 'on'", () => {
  const apiOff = fakeApi();
  const cleanupOff = wireApi(apiOff, rt);
  try {
    const namesOff = (apiOff.tools as Array<{ name: string }>).map((t) => t.name);
    assert.ok(!namesOff.includes("memory_forget"));
  } finally { cleanupOff(); }

  const apiOn = fakeApi();
  const onRtForget: RuntimeDeps = {
    ...rt,
    cfg: { ...rt.cfg, memoryForget: "on" },
  };
  const cleanupOn = wireApi(apiOn, onRtForget);
  try {
    const namesOn = (apiOn.tools as Array<{ name: string }>).map((t) => t.name);
    assert.ok(namesOn.includes("memory_forget"));
  } finally { cleanupOn(); }
});

test("memory_forget tool executes forgetLogic and retracts memory", async () => {
  const text = "we chose redis for caching";
  const id = pointId(text, "remember_tool", "");
  const deleted: string[] = [];
  const q: QdrantLike = {
    async ensureCollection() { return "exists"; },
    async upsert() {},
    async search() { return []; },
    async count() { return 1; },
    async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
    async countBySourceKind() { return 0; },
    async countCodeSymbols() { return 0; },
    async existingPointIds() { return new Set([id]); },
    async deletePointsByIds(_n, ids) { deleted.push(...ids); return ids.length; },
  };
  const api = fakeApi();
  const forgetRt: RuntimeDeps = {
    ...rt,
    cfg: { ...rt.cfg, memoryForget: "on" },
    qdrant: q,
  };
  const cleanup = wireApi(api, forgetRt);
  try {
    const tool = (api.tools as Array<{ name: string; execute: (id: string, p: { text: string }) => Promise<{ content: Array<{ text: string }> }> }>)
      .find((t) => t.name === "memory_forget")!;
    const res = await tool.execute("t1", { text });
    assert.equal(res.content[0]!.text, `forgotten: ${text}`);
    assert.deepEqual(deleted, [id]);

    const resFail = await tool.execute("t2", { text: "unknown fact" });
    assert.match(resFail.content[0]!.text, /memory_forget failed: no memory_save point with that exact text/);
  } finally { cleanup(); }
});

test("/qdrant status omits codeMemory when codeKnowledge is 'off' (Issue #42)", async () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt); // default rt has codeKnowledge: "off"
  try {
    const statusCmd = (api.commands as Array<{ name: string; execute: (args: string) => Promise<void> }>).find((c) => c.name === "qdrant")!;
    await statusCmd.execute("status");
    const lastEntry = api.entries.at(-1) as { kind: string; health: { codeMemory?: unknown; detail: { codeThreshold?: unknown } } };
    assert.equal(lastEntry.health.codeMemory, undefined);
    assert.equal(lastEntry.health.detail.codeThreshold, undefined);
  } finally { cleanup(); }
});



// ── /qdrant-* → /qdrant migration notice (plan Part D) ──────────────────────

/** A wireApi over a real, empty agent dir so state.json is a real file. */
function noticeFixture(): {
  api: ReturnType<typeof fakeApi>;
  cleanup: () => void;
  dir: string;
  localRt: RuntimeDeps;
} {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-notice-"));
  const localRt: RuntimeDeps = { ...rt, agentDir: dir };
  const api = fakeApi();
  return { api, cleanup: wireApi(api, localRt), dir, localRt };
}

const sessionStart = (api: ReturnType<typeof fakeApi>) =>
  api.events["session_start"][0] as (p: unknown, ctx?: unknown) => Promise<void>;

const noticeTexts = (api: ReturnType<typeof fakeApi>) =>
  (api.entries as Array<{ text?: string }>).map((e) => e.text ?? "").filter((t) => t.includes("/qdrant-* is now"));

test("session_start emits the migration notice and does NOT write the flag (Part D.2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-notice-"));
  const localRt: RuntimeDeps = { ...rt, agentDir: dir };
  const api = fakeApi();
  const cleanup = wireApi(api, localRt);
  try {
    await sessionStart(api)({}, { mode: "tui" });
    const notices = noticeTexts(api);
    assert.equal(notices.length, 1, "the notice is emitted on the first session");
    assert.equal(notices[0], COMMAND_FORMAT_NOTICE_TEXT);
    // Emit-only: consuming the one-shot here would silence a session the user
    // may have scrolled past.
    assert.equal(existsSync(statePath(dir)), false, "session_start must never write the flag");
  } finally { cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("the notice repeats in each new session until a /qdrant command is used", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-notice-"));
  try {
    for (const session of [1, 2]) {
      const localRt: RuntimeDeps = { ...rt, agentDir: dir };
      const api = fakeApi();
      const cleanup = wireApi(api, localRt);
      try {
        await sessionStart(api)({}, { mode: "tui" });
        assert.equal(noticeTexts(api).length, 1, `session ${session} shows the notice`);
      } finally { cleanup(); }
    }
    assert.equal(existsSync(statePath(dir)), false, "still nothing written after two sessions");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a successful /qdrant dispatch writes the flag and silences the next session", async () => {
  const { api, cleanup, dir } = noticeFixture();
  try {
    // Bare form: status + help counts as a successful dispatch.
    await qdrantCmd(api)("");
    const state = JSON.parse(readFileSync(statePath(dir), "utf8")) as Record<string, unknown>;
    assert.deepEqual(state, { commandFormatNoticeShown: true }, "the flag file is written by the dispatch");

    // Next session over the same agent dir: silent.
    const localRt: RuntimeDeps = { ...rt, agentDir: dir };
    const api2 = fakeApi();
    const cleanup2 = wireApi(api2, localRt);
    try {
      await sessionStart(api2)({}, { mode: "tui" });
      assert.equal(noticeTexts(api2).length, 0, "the notice is gone once the user has migrated");
    } finally { cleanup2(); }
  } finally { cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("every valid key that clears checkArgShape arms the flag", async () => {
  for (const args of ["status", "help", "search some query", "remember hello world", "clear all", "index code", "settings", "settings mode own"]) {
    const { api, cleanup, dir } = noticeFixture();
    try {
      await qdrantCmd(api)(args);
      assert.equal(readState(dir).commandFormatNoticeShown, true, `"/qdrant ${args}" must arm the flag`);
    } finally { cleanup(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test("an unknown key does NOT arm the flag — the user has not migrated", async () => {
  const { api, cleanup, dir } = noticeFixture();
  try {
    await qdrantCmd(api)("bogus thing");
    assert.equal(existsSync(statePath(dir)), false, "unknown key must leave the notice armed");
  } finally { cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("an argument-shape error does NOT arm the flag", async () => {
  for (const args of ["status now", "clear", "index documents", "index code extra"]) {
    const { api, cleanup, dir } = noticeFixture();
    try {
      await qdrantCmd(api)(args);
      assert.equal(existsSync(statePath(dir)), false, `"/qdrant ${args}" must leave the notice armed`);
    } finally { cleanup(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test("the flag is written at most once per process, no matter how many commands run", async () => {
  const { api, cleanup, dir } = noticeFixture();
  try {
    await qdrantCmd(api)("status");
    const first = statSync(statePath(dir)).mtimeMs;
    await qdrantCmd(api)("help");
    await qdrantCmd(api)("status");
    // The in-memory latch means later commands do no filesystem work at all.
    assert.equal(statSync(statePath(dir)).mtimeMs, first, "no further writes after the first success");
    assert.equal(readState(dir).commandFormatNoticeShown, true);
  } finally { cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("headless sessions emit nothing; rpc still gets the notice (Part D.2)", async () => {
  for (const mode of ["json", "print"]) {
    const { api, cleanup, dir } = noticeFixture();
    try {
      await sessionStart(api)({}, { mode });
      assert.equal(noticeTexts(api).length, 0, `${mode} has no transcript to show it in`);
      assert.equal(existsSync(statePath(dir)), false, "a headless session must not consume the one-shot");
    } finally { cleanup(); rmSync(dir, { recursive: true, force: true }); }
  }
  // rpc renders a transcript, so it is NOT gated.
  const { api, cleanup, dir } = noticeFixture();
  try {
    await sessionStart(api)({}, { mode: "rpc" });
    assert.equal(noticeTexts(api).length, 1, "rpc shows the notice");
  } finally { cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("a missing ctx.mode is treated as a transcript session", async () => {
  const { api, cleanup, dir } = noticeFixture();
  try {
    await sessionStart(api)({}, {});
    assert.equal(noticeTexts(api).length, 1);
  } finally { cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("corrupt or non-object state.json reads as 'not shown' without throwing", async () => {
  for (const raw of ["{not json", '"a string"', "null", "[]", "{}"]) {
    const dir = mkdtempSync(join(tmpdir(), "pi-qm-notice-"));
    try {
      mkdirSync(dirname(statePath(dir)), { recursive: true });
      writeFileSync(statePath(dir), raw, "utf8");
      const localRt: RuntimeDeps = { ...rt, agentDir: dir };
      const api = fakeApi();
      const cleanup = wireApi(api, localRt);
      try {
        await assert.doesNotReject(() => sessionStart(api)({}, { mode: "tui" }));
        const expected = raw === "{}" ? 1 : 1; // every shape above is "not shown"
        assert.equal(noticeTexts(api).length, expected, `state ${raw} must show the notice`);
        assert.equal(readFileSync(statePath(dir), "utf8"), raw, "session_start must not rewrite state.json");
      } finally { cleanup(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("a corrupt config file is reported once, on session_start, naming the path (#57)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-notice-"));
  try {
    mkdirSync(dirname(configPath(dir)), { recursive: true });
    writeFileSync(configPath(dir), "{not json", "utf8");
    takeLoadWarnings(); // drain
    const localRt: RuntimeDeps = { ...rt, agentDir: dir, cfg: readGlobalConfig(dir, {}) };
    const api = fakeApi();
    const cleanup = wireApi(api, localRt);
    try {
      await sessionStart(api)({}, { mode: "tui" });
      const warnings = (api.entries as Array<{ text?: string }>).map((e) => e.text ?? "").filter((t) => t.includes("settings:"));
      assert.equal(warnings.length, 1, "one warning entry");
      assert.ok(warnings[0]!.includes(configPath(dir)), "the warning names the unreadable file");

      // The drain means a later session does not repeat it.
      const api2 = fakeApi();
      const cleanup2 = wireApi(api2, localRt);
      try {
        await sessionStart(api2)({}, { mode: "tui" });
        assert.equal((api2.entries as Array<{ text?: string }>).filter((e) => (e.text ?? "").includes("settings:")).length, 0);
      } finally { cleanup2(); }
    } finally { cleanup(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Bare /qdrant settings: mode routing (plan B.5, #56) ─────────────────────
//
// The decision comes from the LIVE ctx of the invocation, read through
// `commandUI()` — never from a previously captured one. Three outcomes:
//   mode === "tui" + the host bridge → the SettingsList modal
//   hasUI (rpc)                   → the select → input → confirm form
//   no dialog UI                  → the usage entry

/** A host bridge fake good enough for the dispatch to consider mounting. */
function fakeBridge() {
  return {
    SettingsList: class { render() { return []; } invalidate() {} handleInput() {} updateValue() {} } as never,
    Input: class { getValue() { return ""; } setValue() {} handleInput() {} render() { return []; } invalidate() {} } as never,
    getSettingsListTheme: () => ({
      label: (t: string) => t, value: (t: string) => t, description: (t: string) => t, cursor: "", hint: (t: string) => t,
    }),
  };
}

test("bare /qdrant settings in tui mode mounts the SettingsList screen", async () => {
  let mounted = 0;
  let seenTheme: unknown;
  const api = withCommandUI(fakeApi(), {
    hasUI: true,
    mode: "tui",
    dialogs: { async select() { return undefined; }, async input() { return undefined; }, async confirm() { return false; } },
    custom: (async (factory: (args: CustomFactoryArgs) => SettingsComponent) => {
      mounted++;
      const component = factory({
        tui: {},
        theme: { fg: (_c: string, t: string) => t },
        keybindings: { matches: () => false },
        done: () => {},
      });
      seenTheme = component === undefined ? undefined : "mounted";
      return undefined;
    }) as unknown as MountFn,
  });
  const withBridge = { ...api, hostBridge: () => fakeBridge() };
  const cleanup = wireApi(withBridge, rt);
  try {
    await qdrantCmd(withBridge)("settings");
    assert.equal(mounted, 1, "tui mode mounts the modal");
    assert.ok(seenTheme, "the screen is handed the host theme");
    // The dialog form must NOT also run.
    assert.ok(!entryTexts(withBridge).some((t) => t.startsWith("settings: usage")));
  } finally { cleanup(); }
});

test("bare /qdrant settings in rpc mode runs the dialog form, never the modal", async () => {
  let mounted = 0;
  let selects = 0;
  const api = withCommandUI(fakeApi(), {
    hasUI: true,
    mode: "rpc",
    dialogs: {
      async select() { selects++; return undefined; },
      async input() { return undefined; },
      async confirm() { return false; },
    },
    custom: (async () => { mounted++; return undefined; }) as unknown as MountFn,
  });
  const withBridge = { ...api, hostBridge: () => fakeBridge() };
  const cleanup = wireApi(withBridge, rt);
  try {
    await qdrantCmd(withBridge)("settings");
    assert.equal(selects, 1, "rpc keeps the dialog sequence");
    assert.equal(mounted, 0, "rpc's ctx.ui.custom is a silent no-op, so it must never be mounted");
  } finally { cleanup(); }
});

test("bare /qdrant settings with no dialog UI falls back to the usage entry", async () => {
  const api = withCommandUI(fakeApi(), { hasUI: false, mode: "print" });
  const cleanup = wireApi(api, rt);
  try {
    await qdrantCmd(api)("settings");
    assert.ok(
      entryTexts(api).some((t) => t.startsWith("settings: usage")),
      `expected the usage entry, got ${JSON.stringify(entryTexts(api))}`,
    );
  } finally { cleanup(); }
});

test("tui mode with an unresolved host bridge degrades to the dialog form (never throws)", async () => {
  let selects = 0;
  let mounted = 0;
  // mode is tui, but the bridge resolved nothing — SettingsList is missing.
  const api = withCommandUI(fakeApi(), {
    hasUI: true,
    mode: "tui",
    dialogs: {
      async select() { selects++; return undefined; },
      async input() { return undefined; },
      async confirm() { return false; },
    },
    custom: (async () => { mounted++; return undefined; }) as unknown as MountFn,
  });
  const cleanup = wireApi({ ...api, hostBridge: () => ({}) }, rt);
  try {
    await qdrantCmd(api)("settings");
    assert.equal(mounted, 0, "an incomplete bridge must not mount a half-built screen");
    assert.equal(selects, 1, "it degrades to the dialog form instead");
  } finally { cleanup(); }
});

test("commandUI() is only defined DURING the handler, never after it (#56)", async () => {
  const base = fakeApi();
  const api: WireApi = { ...base, commandUI: () => undefined };
  const cleanup = wireApi(api, rt);
  try {
    const cmd = (base.commands as Array<{ name: string; execute: (args: string) => Promise<void> }>).find((c) => c.name === "qdrant")!;
    // The seam is a closure over the invocation; with no invocation it is
    // undefined, which is what stops a later handler reading a stale ctx.
    assert.equal(api.commandUI!(), undefined, "no invocation → no ctx-derived view");
    await cmd.execute("help");
    assert.equal(api.commandUI!(), undefined, "released in finally after the handler returns");
  } finally { cleanup(); }
});
