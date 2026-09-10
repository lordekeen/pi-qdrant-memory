import test from "node:test";
import assert from "node:assert/strict";
import {
  statusHandler, settingsHandler, rememberHandler, searchHandler, clearHandler, helpHandler, runSettingsForm,
} from "../src/handlers.ts";
import { outText } from "../src/out.ts";
import type { OutEntry } from "../src/out.ts";
import type { HandlerIO, SettingsUI } from "../src/handlers.ts";
import type { QdrantLike } from "../src/qdrant.ts";
import { QdrantError } from "../src/qdrant.ts";
import type { Config } from "../src/types.ts";

const cfg: Config = {
  qdrantUrl: "http://localhost:6333", qdrantApiKey: null,
  embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text",
  embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10, mode: "auto",
  codeKnowledge: "off", codeScoreThreshold: 0.4,
};

function io(over: Partial<HandlerIO> = {}): HandlerIO & { emitted: OutEntry[]; printed: string[]; written: Config[] } {
  const emitted: OutEntry[] = [];
  const printed: string[] = [];
  const written: Config[] = [];
  const qdrant: QdrantLike = {
    async ensureCollection() { return "exists"; },
    async upsert() {},
    async search() { return []; },
    async count() { return 3; },
    async clearCollection() { written.push(cfg); },
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
  };
  return {
    cfg, agentDir: "/tmp/agent", cwd: "/repo", projectId: "pi-mem-abc",
    embed: async () => new Array(768).fill(0.1),
    qdrant,
    readConfig: () => cfg,
    writeConfig: (c) => written.push(c),
    emit: (e) => { emitted.push(e); printed.push(outText(e)); },
    emitted,
    printed,
    written,
    ...over,
  } as HandlerIO & { emitted: OutEntry[]; printed: string[]; written: Config[] };
}

test("statusHandler prints mode and collection health", async () => {
  const d = io();
  await statusHandler(d);
  const all = d.printed.join("\n");
  assert.match(all, /mode2/i); // auto with no blackhole → mode2
  assert.match(all, /✓ reachable · 3 points/);
  // The entry heads with the footer-style header and shows the collection id
  // inline — nothing is hidden behind an expand gesture anymore.
  assert.match(all, /🧠 Memory: mode2 \(pi-mem-abc\)/);
  assert.match(all, /qdrant url: http:\/\/localhost:6333/);
  assert.equal(d.emitted.length, 1);
  assert.equal(d.emitted[0].kind, "status");
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
    async count() { throw new QdrantError("Qdrant request POST ... failed: HTTP 404", 404); },
    async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
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
  const all = d.printed.join("\n");
  assert.match(all, /use REST/);
  // Command voice: plain "remembered: <text>" — never the stored point's
  // internal source kind "remember_tool" (DESIGN.md message vs agent-tool-results).
  assert.match(all, /remembered: use REST/);
  assert.doesNotMatch(all, /remember_tool/);
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

test("runSettingsForm edits a numeric field after confirm", async () => {
  const d = io();
  const ui: SettingsUI = {
    async select(_title, options) {
      return options.find((o) => o.startsWith("scoreThreshold ="));
    },
    async input(_title, _placeholder) { return "0.25"; },
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.equal(d.written.length, 1);
  assert.equal(d.written[0].scoreThreshold, 0.25);
  assert.match(d.printed.join("\n"), /scoreThreshold updated/);
});

test("runSettingsForm Esc on the field list writes nothing", async () => {
  const d = io();
  const ui: SettingsUI = {
    async select() { return undefined; },
    async input() { return "0.25"; },
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.equal(d.written.length, 0);
  assert.equal(d.printed.length, 0);
});

test("runSettingsForm rejects an invalid value before confirming", async () => {
  const d = io();
  let confirms = 0;
  const ui: SettingsUI = {
    async select(_title, options) { return options.find((o) => o.startsWith("scoreThreshold =")); },
    async input() { return "not-a-number"; },
    async confirm() { confirms++; return true; },
  };
  await runSettingsForm(ui, d);
  assert.equal(confirms, 0);
  assert.equal(d.written.length, 0);
  assert.match(d.printed.join("\n"), /expects a number/);
});

test("runSettingsForm leaves config untouched when confirm is declined", async () => {
  const d = io();
  const ui: SettingsUI = {
    async select(_title, options) { return options.find((o) => o.startsWith("scoreThreshold =")); },
    async input() { return "0.3"; },
    async confirm() { return false; },
  };
  await runSettingsForm(ui, d);
  assert.equal(d.written.length, 0);
  assert.match(d.printed.join("\n"), /unchanged \(cancelled\)/);
});

test("runSettingsForm mode field uses a nested select", async () => {
  const d = io();
  let secondSelectTitle = "";
  const ui: SettingsUI = {
    async select(title, options) {
      if (title.startsWith("Qdrant Memory")) return options.find((o) => o.startsWith("mode ="));
      secondSelectTitle = title;
      return "own";
    },
    async input() { throw new Error("mode must not open a text input"); },
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.match(secondSelectTitle, /mode/);
  assert.equal(d.written.length, 1);
  assert.equal(d.written[0].mode, "own");
});

test("helpHandler prints the command list", async () => {
  const d = io();
  await helpHandler(d);
  const all = d.printed.join("\n");
  for (const c of ["/qdrant-status", "/qdrant-settings", "/qdrant-remember", "/qdrant-search", "/qdrant-clear", "/qdrant-help"]) {
    assert.match(all, new RegExp(c.replace("/", "\\/")));
  }
});

test("statusHandler emits exactly one structured status entry", async () => {
  const d = io();
  await statusHandler(d);
  assert.equal(d.emitted.length, 1);
  assert.equal(d.emitted[0].kind, "status");
  assert.equal(d.printed.length, 1, "one entry, not three rows");
});

test("searchHandler emits a message entry when nothing matches", async () => {
  const d = io(); // default fake qdrant.search returns []
  await searchHandler(d, "anything");
  assert.equal(d.emitted.length, 1);
  assert.equal(d.emitted[0].kind, "message");
  assert.match(d.printed.join("\n"), /No relevant memory/);
});

test("searchHandler emits an error entry when the search fails", async () => {
  const qdrantErr: QdrantLike = {
    async ensureCollection() { return "exists"; }, async upsert() {},
    async search() { throw new Error("connection refused"); },
    async count() { return 0; }, async clearCollection() {},
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
  };
  const d = io({ qdrant: qdrantErr });
  await searchHandler(d, "query");
  assert.equal(d.emitted[0].kind, "error");
  // Command voice: /qdrant-search failures read "error: search failed: <reason>"
  // (plan §1.2), never the LLM tool's "memory_search failed:" lead (DESIGN.md
  // agent-tool-results — which stays on the memory_search tool return).
  assert.match(d.printed.join("\n"), /error: search failed: .*connection refused/);
  assert.doesNotMatch(d.printed.join("\n"), /memory_search failed/);
});

test("rememberHandler emits an error entry when embedding fails", async () => {
  const d = io({ embed: async () => { throw new Error("embedder down"); } });
  await rememberHandler(d, "use REST");
  assert.equal(d.emitted[0].kind, "error");
  assert.match(d.printed.join("\n"), /error: remember failed: .*embedder down/);
});

test("emitted output never carries a /qdrant: text prefix", async () => {
  const d = io();
  await statusHandler(d);
  await clearHandler(d);
  await rememberHandler(d, "use REST", "decision");
  await helpHandler(d);
  const all = d.printed.join("\n");
  assert.doesNotMatch(all, /\/qdrant: /);
});

test("runSettingsForm codeKnowledge field uses a nested select", async () => {
  const d = io();
  let selects = 0;
  const ui: SettingsUI = {
    async select(_title, options) {
      selects++;
      // First call: the field list. Second call: the nested off/on select.
      return selects === 1
        ? options.find((o) => o.startsWith("codeKnowledge ="))
        : options.find((o) => o === "on");
    },
    async input() { throw new Error("codeKnowledge must select, not free-text"); },
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.equal(selects, 2);
  assert.equal(d.written.length, 1);
  assert.equal(d.written[0].codeKnowledge, "on");
  assert.match(d.printed.join("\n"), /codeKnowledge updated/);
});

test("runSettingsForm covers codeScoreThreshold with 0-1 validation", async () => {
  const d = io();
  const ui: SettingsUI = {
    async select(_title, options) { return options.find((o) => o.startsWith("codeScoreThreshold =")); },
    async input() { return "1.5"; },
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.equal(d.written.length, 0);
  assert.match(d.printed.join("\n"), /between 0 and 1/);
});

test("settings usage message lists the code-memory fields", async () => {
  const d = io();
  await settingsHandler(d);
  const all = d.printed.join("\n");
  assert.match(all, /codeKnowledge/);
  assert.match(all, /codeScoreThreshold/);
});

test("CLI codeKnowledge write emits the reload notice; other fields do not", async () => {
  const d = io();
  await settingsHandler(d, "codeKnowledge", "on");
  let all = d.printed.join("\n");
  assert.match(all, /takes effect at the next session start/);
  assert.match(all, /code_memory tool registers on reload/);

  const off = io();
  await settingsHandler(off, "codeKnowledge", "off");
  all = off.printed.join("\n");
  assert.match(all, /unregisters on reload/);

  const other = io();
  await settingsHandler(other, "scoreThreshold", "0.2");
  assert.doesNotMatch(other.printed.join("\n"), /next session start/);
});

test("form codeKnowledge write emits the reload notice", async () => {
  const d = io();
  let selects = 0;
  const ui: SettingsUI = {
    async select(_title, options) {
      selects++;
      return selects === 1
        ? options.find((o) => o.startsWith("codeKnowledge ="))
        : options.find((o) => o === "on");
    },
    async input() { throw new Error("not used"); },
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.match(d.printed.join("\n"), /takes effect at the next session start/);
});

test("statusHandler includes the code-memory row when the feature is wired", async () => {
  const d = io({ codeMemory: { state: "synced", files: 4, symbols: 21 } });
  await statusHandler(d);
  const all = d.printed.join("\n");
  assert.match(all, /code memory: ✓ 4 files · 21 symbols/);
});

test("statusHandler omits the code-memory row when not wired", async () => {
  const d = io();
  await statusHandler(d);
  assert.doesNotMatch(d.printed.join("\n"), /code memory/);
});

test("help lists /qdrant-index-code only when codeKnowledge is on", async () => {
  const on = io({ cfg: { ...cfg, codeKnowledge: "on" } });
  await helpHandler(on);
  assert.match(on.printed.join("\n"), /qdrant-index-code/);

  const off = io();
  await helpHandler(off);
  assert.doesNotMatch(off.printed.join("\n"), /qdrant-index-code/);
});
