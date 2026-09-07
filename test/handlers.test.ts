import test from "node:test";
import assert from "node:assert/strict";
import {
  statusHandler, settingsHandler, rememberHandler, searchHandler, clearHandler, helpHandler,
} from "../src/handlers.ts";
import type { HandlerIO } from "../src/handlers.ts";
import type { QdrantLike } from "../src/qdrant.ts";
import type { Config } from "../src/types.ts";

const cfg: Config = {
  qdrantUrl: "http://localhost:6333", qdrantApiKey: null,
  embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text",
  embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10, mode: "auto",
};

function io(over: Partial<HandlerIO> = {}): HandlerIO & { printed: string[]; written: Config[] } {
  const printed: string[] = [];
  const written: Config[] = [];
  const qdrant: QdrantLike = {
    async ensureCollection() { return "exists"; },
    async upsert() {},
    async search() { return []; },
    async count() { return 3; },
    async clearCollection() { written.push(cfg); },
  };
  return {
    cfg, agentDir: "/tmp/agent", cwd: "/repo", projectId: "pi-mem-abc",
    embed: async () => new Array(768).fill(0.1),
    qdrant,
    readConfig: () => cfg,
    writeConfig: (c) => written.push(c),
    print: (t) => printed.push(t),
    printed,
    written,
    ...over,
  } as HandlerIO & { printed: string[]; written: Config[] };
}

test("statusHandler prints mode and collection health", async () => {
  const d = io();
  await statusHandler(d);
  const all = d.printed.join("\n");
  assert.match(all, /mode2/i); // auto with no blackhole → mode2
  assert.match(all, /pi-mem-abc/);
  assert.match(all, /3/);
});

test("settingsHandler persists field=value and prints confirmation", async () => {
  const d = io();
  await settingsHandler(d, "scoreThreshold", "0.2");
  assert.equal(d.written.length, 1);
  assert.equal(d.written[0].scoreThreshold, 0.2);
  assert.match(d.printed.join("\n"), /scoreThreshold/);
});

test("settingsHandler rejects invalid mode and non-positive numerics", async () => {
  const d = io();
  await settingsHandler(d, "mode", "bogus");
  assert.equal(d.written.length, 0);
  assert.match(d.printed.join("\n"), /auto \| blackhole \| own/);
  await settingsHandler(d, "expectedDimension", "0");
  assert.equal(d.written.length, 0);
  assert.match(d.printed.join("\n"), /positive/);
});

test("statusHandler distinguishes a missing collection from an unreachable server", async () => {
  const qdrant404: QdrantLike = {
    async ensureCollection() { return "created"; }, async upsert() {},
    async search() { return []; },
    async count() { throw new Error("Qdrant request POST ... failed: HTTP 404"); },
    async clearCollection() {},
  };
  const d = io({ qdrant: qdrant404 });
  await statusHandler(d);
  const all = d.printed.join("\n");
  assert.doesNotMatch(all, /NOT reachable/);
  assert.match(all, /does not exist yet/);
});

test("rememberHandler prints success and upserts", async () => {
  const d = io();
  await rememberHandler(d, "use REST", "decision");
  assert.match(d.printed.join("\n"), /use REST/);
});

test("searchHandler prints no-relevant-memory message on empty", async () => {
  const d = io();
  await searchHandler(d, "anything");
  assert.match(d.printed.join("\n"), /No relevant memory/);
});

test("clearHandler calls clearCollection and prints confirmation", async () => {
  const d = io();
  await clearHandler(d);
  assert.equal(d.written.length, 1);
  assert.match(d.printed.join("\n"), /cleared|reset/i);
});

test("helpHandler prints the command list", async () => {
  const d = io();
  await helpHandler(d);
  const all = d.printed.join("\n");
  for (const c of ["/qdrant status", "/qdrant settings", "/qdrant remember", "/qdrant search", "/qdrant clear", "/qdrant help"]) {
    assert.match(all, new RegExp(c.replace("/", "\\/")));
  }
});
