import test from "node:test";
import assert from "node:assert/strict";
import { wireApi } from "../src/index.ts";
import type { WireApi } from "../src/index.ts";
import type { RuntimeDeps } from "../src/types.ts";
import type { QdrantLike } from "../src/qdrant.ts";

function fakeApi(): WireApi & { tools: unknown[]; commands: unknown[]; events: Record<string, unknown[]>; entries: unknown[]; messages: string[]; statuses: string[] } {
  const api = {
    tools: [], commands: [], events: {} as Record<string, unknown[]>, entries: [], messages: [], statuses: [],
    registerTool(d: unknown) { (api.tools as unknown[]).push(d); },
    registerCommand(d: unknown) { (api.commands as unknown[]).push(d); },
    on(ev: string, h: (p: unknown) => void | Promise<void>) {
      if (!api.events[ev]) api.events[ev] = [];
      const index = api.events[ev].length;
      api.events[ev].push(h);
      return () => { api.events[ev].splice(index, 1); };
    },
    appendEntry(_t: string, d: unknown) { (api.entries as unknown[]).push(d); },
    sendMessage(t: string) { (api.messages as string[]).push(t); },
    setStatus(t: string) { (api.statuses as string[]).push(t); },
  };
  return api as WireApi & typeof api;
}

const qdrant: QdrantLike = {
  async ensureCollection() { return "exists"; }, async upsert() {},
  async search() { return []; }, async count() { return 0; }, async clearCollection() {},
};

const rt: RuntimeDeps = {
  cfg: { qdrantUrl: "http://localhost:6333", qdrantApiKey: null, embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text", embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10, mode: "own" },
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
