import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { wireApi } from "../src/index.ts";
import type { WireApi } from "../src/index.ts";
import type { Config, RuntimeDeps } from "../src/types.ts";
import type { QdrantLike } from "../src/qdrant.ts";
import { QdrantError } from "../src/qdrant.ts";
import { readEffectiveConfig, saveProjectSettings } from "../src/project-settings.ts";
import { projectIdFrom } from "../src/project.ts";

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

const qdrant: QdrantLike = {
  async ensureCollection() { return "exists"; }, async upsert() {},
  async search() { return []; }, async count() { return 0; }, async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
};

const rt: RuntimeDeps = {
  cfg: { qdrantUrl: "http://localhost:6333", qdrantApiKey: null, embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text", embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10, mode: "own", codeKnowledge: "off", codeScoreThreshold: 0.4 },
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

test("wireApi registers the /qdrant command set", () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt);
  try {
    const names = (api.commands as Array<{ name: string }>).map((c) => c.name);
    for (const n of ["qdrant-status", "qdrant-settings", "qdrant-remember", "qdrant-search", "qdrant-clear", "qdrant-help"]) {
      assert.ok(names.includes(n), `missing command ${n}`);
    }
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

test("code_memory tool gates on codeKnowledge; /qdrant-index-code is always present", () => {
  const on = fakeApi();
  const off = fakeApi();
  const onCleanup = wireApi(on, onRt);
  const offCleanup = wireApi(off, rt);
  try {
    const onTools = (on.tools as Array<{ name: string }>).map((t) => t.name);
    const offTools = (off.tools as Array<{ name: string }>).map((t) => t.name);
    assert.ok(onTools.includes("code_memory"), "expected code_memory when on");
    assert.ok(!offTools.includes("code_memory"), "no code_memory when off");
    // The command registers unconditionally (live-config guard inside) so the
    // §12 "index right away" notice is keepable right after an off→on flip.
    const onCmds = (on.commands as Array<{ name: string }>).map((c) => c.name);
    const offCmds = (off.commands as Array<{ name: string }>).map((c) => c.name);
    assert.ok(onCmds.includes("qdrant-index-code"));
    assert.ok(offCmds.includes("qdrant-index-code"));
  } finally { onCleanup(); offCleanup(); }
});

test("/qdrant-index-code emits the count message on success and an error entry on failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-cmd-"));
  try {
    writeFileSync(join(root, "a.ts"), "export function alpha() {}\n");
    const localRt: RuntimeDeps = { ...onRt, cwd: root, embedBatch: async (t: string[]) => t.map(() => new Array(768).fill(0.1)) };
    const api = fakeApi();
    const cleanup = wireApi(api, localRt);
    try {
      const cmd = (api.commands as Array<{ name: string; execute: (args: string) => Promise<void> }>)
        .find((c) => c.name === "qdrant-index-code")!;
      await cmd.execute("");
      const texts = (api.entries as Array<{ text?: string }>).map((e) => e.text ?? "");
      assert.ok(texts.some((t) => /^code memory: 1 files · 2 symbols indexed \(1 points replaced\)$/.test(t)), JSON.stringify(texts));

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
        const cmd2 = (api2.commands as Array<{ name: string; execute: (args: string) => Promise<void> }>)
          .find((c) => c.name === "qdrant-index-code")!;
        await cmd2.execute("");
        const texts2 = (api2.entries as Array<{ kind?: string; text?: string }>).map((e) => ({ kind: e.kind, text: e.text ?? "" }));
        const errEntry = texts2.find((t) => t.text.includes("code memory: sync failed"));
        assert.ok(errEntry, JSON.stringify(texts2));
        assert.equal(errEntry!.kind, "error");
      } finally { cleanup2(); }
    } finally { cleanup(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("code_memory executes a code-typed search", async () => {
  const api = fakeApi();
  const cleanup = wireApi(api, onRt);
  try {
    const tool = (api.tools as Array<{ name: string; execute: (id: string, p: { query: string }) => Promise<{ content: Array<{ text: string }> }> }>)
      .find((t) => t.name === "code_memory")!;
    const res = await tool.execute("t1", { query: "how does X work" });
    assert.match(res.content[0]!.text, /No relevant memory found/);
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
