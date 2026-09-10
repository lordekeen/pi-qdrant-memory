import test from "node:test";
import assert from "node:assert/strict";
import { wireApi } from "../src/index.ts";
import type { WireApi } from "../src/index.ts";
import type { RuntimeDeps } from "../src/types.ts";
import type { QdrantLike } from "../src/qdrant.ts";
import { QdrantError } from "../src/qdrant.ts";

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
};

const rt: RuntimeDeps = {
  cfg: { qdrantUrl: "http://localhost:6333", qdrantApiKey: null, embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text", embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10, mode: "own", codeKnowledge: "off", codeScoreThreshold: 0.4 },
  agentDir: "/tmp/agent", cwd: "/repo", projectId: "pi-mem-abc",
  embed: async () => new Array(768).fill(0.1), qdrant,
  readConfig: () => rt.cfg, writeConfig: () => {}, print: () => {},
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
