import test from "node:test";
import assert from "node:assert/strict";
import {
  statusHandler, settingsHandler, rememberHandler, searchHandler, clearHandler, helpHandler, runSettingsForm,
} from "../src/handlers.ts";
import { outText } from "../src/out.ts";
import type { OutEntry } from "../src/out.ts";
import type { HandlerIO, SettingsUI } from "../src/handlers.ts";
import type { ProjectOverridableField, ProjectSettings } from "../src/project-settings.ts";
import { isConfigKnowledge } from "../src/config.ts";
import type { QdrantLike } from "../src/qdrant.ts";
import { QdrantError } from "../src/qdrant.ts";
import type { Config } from "../src/types.ts";

const cfg: Config = {
  qdrantUrl: "http://localhost:6333", qdrantApiKey: null,
  embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text",
  embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10, mode: "auto",
  codeKnowledge: "off", codeScoreThreshold: 0.4,
};

type FakeIO = HandlerIO & {
  emitted: OutEntry[];
  printed: string[];
  globalWrites: Config[];
  projectWrites: ProjectSettings[];
  cleared: ProjectOverridableField[];
  applied: Config[];
  qdrantClears: number;
  /** Live model of the global file (mutate to seed a scenario). */
  globalState: Config;
  /** Live model of the project store (mutate to seed a scenario). */
  storeState: ProjectSettings;
  /** Live env model — set a key to exercise env masking. */
  envState: NodeJS.ProcessEnv;
};

/**
 * Stateful two-store model (AGENTS.md: a fake that models a store must model its
 * side effects, in order). Holds a separate global Config and project store,
 * records which writer each path used, and exposes the *effective* view through
 * the `cfg` getter — mirroring `readEffectiveConfig` (env → store → global).
 */
function io(over: Partial<HandlerIO> = {}): FakeIO {
  const emitted: OutEntry[] = [];
  const printed: string[] = [];
  const globalWrites: Config[] = [];
  const projectWrites: ProjectSettings[] = [];
  const cleared: ProjectOverridableField[] = [];
  const applied: Config[] = [];
  const globalState: Config = { ...cfg };
  const storeState: ProjectSettings = {};
  const envState: NodeJS.ProcessEnv = {};
  let qdrantClears = 0;
  const effective = (): Config => {
    const c: Config = { ...globalState };
    if (!isConfigKnowledge(envState.PI_QDRANT_CODE_KNOWLEDGE) && storeState.codeKnowledge !== undefined) {
      c.codeKnowledge = storeState.codeKnowledge;
    }
    const rawThreshold = envState.PI_QDRANT_CODE_SCORE_THRESHOLD;
    const envPinsThreshold = rawThreshold !== undefined && Number.isFinite(Number(rawThreshold));
    if (!envPinsThreshold && storeState.codeScoreThreshold !== undefined) {
      c.codeScoreThreshold = storeState.codeScoreThreshold;
    }
    return c;
  };
  const qdrant: QdrantLike = {
    async ensureCollection() { return "exists"; },
    async upsert() {},
    async search() { return []; },
    async count() { return 3; },
    async clearCollection() { qdrantClears++; },
    async deletePointsByFiles() {},
    async codeIndexSnapshot() { return new Map(); },
    async countBySourceKind() { return 0; },
  };
  return {
    get cfg() { return effective(); },
    agentDir: "/tmp/agent", cwd: "/repo", projectId: "pi-mem-abc",
    embed: async () => new Array(768).fill(0.1),
    qdrant,
    readGlobalConfig: () => ({ ...globalState }),
    writeGlobalConfig: (c) => { globalWrites.push(c); Object.assign(globalState, c); applied.push(effective()); },
    readProjectSettings: () => ({ ...storeState }),
    writeProjectSettings: (p) => { projectWrites.push(p); Object.assign(storeState, p); applied.push(effective()); },
    clearProjectSetting: (f) => { cleared.push(f); delete storeState[f]; applied.push(effective()); },
    emit: (e) => { emitted.push(e); printed.push(outText(e)); },
    emitted,
    printed,
    globalWrites,
    projectWrites,
    cleared,
    applied,
    get qdrantClears() { return qdrantClears; },
    globalState,
    storeState,
    envState,
    ...over,
  } as FakeIO;
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
  assert.equal(d.globalWrites.length, 1);
  assert.equal(d.globalWrites[0].scoreThreshold, 0.2);
  assert.match(d.printed.join("\n"), /scoreThreshold/);
});

test("settingsHandler rejects invalid mode and non-positive numerics", async () => {
  const d = io();
  await settingsHandler(d, "mode", "bogus");
  assert.equal(d.globalWrites.length, 0);
  assert.match(d.printed.join("\n"), /auto \| blackhole \| own/);
  await settingsHandler(d, "expectedDimension", "0");
  assert.equal(d.globalWrites.length, 0);
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
    async countBySourceKind() { return 0; },
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
  assert.equal(d.qdrantClears, 1);
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
  assert.equal(d.globalWrites.length, 1);
  assert.equal(d.globalWrites[0].scoreThreshold, 0.25);
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
  assert.equal(d.globalWrites.length, 0);
  assert.equal(d.projectWrites.length, 0);
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
  assert.equal(d.globalWrites.length, 0);
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
  assert.equal(d.globalWrites.length, 0);
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
  assert.equal(d.globalWrites.length, 1);
  assert.equal(d.globalWrites[0].mode, "own");
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
    async countBySourceKind() { return 0; },
  };
  const d = io({ qdrant: qdrantErr });
  await searchHandler(d, "query");
  assert.equal(d.emitted[0].kind, "error");
  // Command voice: /qdrant-search failures read "error: search failed: <reason>"
  // (plan §1.2). `res.error` is a bare reason, so the LLM tool's
  // "memory_search failed:" lead never leaks here (DESIGN.md agent-tool-results)
  // — and the reason is not double-labelled.
  assert.equal(d.printed.join("\n"), "error: search failed: Error: connection refused");
  assert.doesNotMatch(d.printed.join("\n"), /memory_search failed/);
  assert.doesNotMatch(d.printed.join("\n"), /search failed: search failed/);
});

test("searchHandler names the command once when the query is empty", async () => {
  const d = io();
  await searchHandler(d, "   ");
  assert.equal(d.emitted[0].kind, "error");
  assert.equal(d.printed.join("\n"), "error: search failed: query is empty");
});

test("rememberHandler emits an error entry when embedding fails", async () => {
  const d = io({ embed: async () => { throw new Error("embedder down"); } });
  await rememberHandler(d, "use REST");
  assert.equal(d.emitted[0].kind, "error");
  assert.equal(d.printed.join("\n"), "error: remember failed: Error: embedder down");
  assert.doesNotMatch(d.printed.join("\n"), /remember failed: remember/);
});

test("rememberHandler names the command once when the text is empty", async () => {
  const d = io();
  await rememberHandler(d, "   ");
  assert.equal(d.emitted[0].kind, "error");
  assert.equal(d.printed.join("\n"), "error: remember failed: text is empty");
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

test("runSettingsForm codeKnowledge field writes the project store", async () => {
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
  // Re-pointed intent (§7.3): an allowlisted form write now lands in the project
  // store, not the global file.
  assert.deepEqual(d.projectWrites[0], { codeKnowledge: "on" });
  assert.equal(d.globalWrites.length, 0);
  assert.match(d.printed.join("\n"), /codeKnowledge = on \(this project; global: off\)/);
});

test("runSettingsForm covers codeScoreThreshold with 0-1 validation", async () => {
  const d = io();
  const ui: SettingsUI = {
    async select(_title, options) { return options.find((o) => o.startsWith("codeScoreThreshold =")); },
    async input() { return "1.5"; },
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.equal(d.projectWrites.length, 0);
  assert.equal(d.globalWrites.length, 0);
  assert.match(d.printed.join("\n"), /between 0 and 1/);
});

test("settings usage message lists the code-memory fields", async () => {
  const d = io();
  await settingsHandler(d);
  const all = d.printed.join("\n");
  assert.match(all, /codeKnowledge/);
  assert.match(all, /codeScoreThreshold/);
});

test("CLI codeKnowledge write lands in the project store and emits the reload notice", async () => {
  const on = io();
  await settingsHandler(on, "codeKnowledge", "on");
  assert.deepEqual(on.projectWrites[0], { codeKnowledge: "on" });
  assert.equal(on.globalWrites.length, 0);
  let all = on.printed.join("\n");
  assert.match(all, /codeKnowledge = on \(this project; global: off\)/);
  assert.match(all, /takes effect at the next session start/);
  assert.match(all, /code_memory tool registers on reload/);

  // Effective is on before the write, so the off write flips it and the
  // direction-aware (unregisters) notice fires.
  const off = io();
  off.globalState.codeKnowledge = "on";
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

test("statusHandler surfaces this project's overrides in the project-settings row", async () => {
  const d = io();
  d.globalState.codeKnowledge = "off";
  d.globalState.codeScoreThreshold = 0.55;
  d.storeState.codeKnowledge = "on";
  d.storeState.codeScoreThreshold = 0.6;
  await statusHandler(d);
  assert.match(d.printed.join("\n"),
    /project settings: codeKnowledge = on \(global: off\); codeScoreThreshold = 0\.6 \(global: 0\.55\)/);
});

test("statusHandler project-settings row is the only explanation when an override turns codeKnowledge off", async () => {
  const d = io(); // codeMemory not wired → the `code memory:` row is absent
  d.globalState.codeKnowledge = "on";
  d.storeState.codeKnowledge = "off";
  await statusHandler(d);
  const all = d.printed.join("\n");
  assert.doesNotMatch(all, /code memory/);
  assert.match(all, /project settings: codeKnowledge = off \(global: on\)/);
});

test("statusHandler omits the project-settings row on an empty store", async () => {
  const d = io();
  await statusHandler(d);
  assert.doesNotMatch(d.printed.join("\n"), /project settings/);
});

test("help lists /qdrant-index-code only when codeKnowledge is on", async () => {
  const on = io({ cfg: { ...cfg, codeKnowledge: "on" } });
  await helpHandler(on);
  assert.match(on.printed.join("\n"), /qdrant-index-code/);

  const off = io();
  await helpHandler(off);
  assert.doesNotMatch(off.printed.join("\n"), /qdrant-index-code/);
});

// ── §7.3 mixed-scope routing ─────────────────────────────────────────────────

test("allowlisted set writes only the project store", async () => {
  const d = io();
  await settingsHandler(d, "codeKnowledge", "on");
  assert.deepEqual(d.projectWrites, [{ codeKnowledge: "on" }]);
  assert.equal(d.globalWrites.length, 0);
  assert.match(d.printed.join("\n"), /codeKnowledge = on \(this project; global: off\)/);
});

test("allowlisted numeric set records a JSON number and names both values", async () => {
  const d = io();
  await settingsHandler(d, "codeScoreThreshold", "0.6");
  const w = d.projectWrites[0].codeScoreThreshold;
  assert.equal(typeof w, "number");
  assert.equal(w, 0.6);
  assert.equal(d.globalWrites.length, 0);
  const all = d.printed.join("\n");
  assert.match(all, /codeScoreThreshold = 0\.6 \(this project; global: 0\.4\)/);
  assert.doesNotMatch(all, /next session start/);
});

test("non-allowlisted writes go to the global file and leave the store untouched", async () => {
  const d = io();
  await settingsHandler(d, "mode", "blackhole");
  await settingsHandler(d, "qdrantUrl", "http://x:6333");
  await settingsHandler(d, "scoreThreshold", "0.2");
  assert.equal(d.globalWrites.length, 3);
  assert.equal(d.projectWrites.length, 0);
  assert.equal(d.storeState.codeKnowledge, undefined);
  const all = d.printed.join("\n");
  assert.match(all, /mode updated \(global config; reloaded at runtime\)/);
  assert.match(all, /qdrantUrl updated \(global config; reloaded at runtime\)/);
});

test("a global write keeps the GLOBAL codeKnowledge when the store overrides it (D10, both directions)", async () => {
  const d = io();
  d.globalState.codeKnowledge = "on";
  d.storeState.codeKnowledge = "off";
  await settingsHandler(d, "scoreThreshold", "0.2");
  assert.equal(d.globalWrites.length, 1);
  assert.equal(d.globalWrites[0].codeKnowledge, "on"); // global value materialized, never the override
  assert.equal(d.applied.at(-1)!.codeKnowledge, "off"); // reload used the effective reader → override survives
  assert.equal(d.storeState.codeKnowledge, "off");
});

test("`<key> default` clears an allowlisted override and confirms the global value", async () => {
  const d = io();
  d.storeState.codeKnowledge = "on"; // effective on; global off
  await settingsHandler(d, "codeKnowledge", "default");
  assert.deepEqual(d.cleared, ["codeKnowledge"]);
  assert.equal(d.storeState.codeKnowledge, undefined);
  assert.equal(d.projectWrites.length, 0);
  const all = d.printed.join("\n");
  assert.match(all, /settings: codeKnowledge override cleared \(now using global: off\)/);
  assert.match(all, /unregisters on reload/);
});

test("a no-op clear still confirms but emits no reload notice", async () => {
  const d = io(); // no override, effective off
  await settingsHandler(d, "codeKnowledge", "default");
  assert.match(d.printed.join("\n"), /override cleared \(now using global: off\)/);
  assert.doesNotMatch(d.printed.join("\n"), /next session start/);
});

test("`codeScoreThreshold default` is consumed before the numeric parse", async () => {
  const d = io();
  d.storeState.codeScoreThreshold = 0.6;
  await settingsHandler(d, "codeScoreThreshold", "default");
  assert.deepEqual(d.cleared, ["codeScoreThreshold"]);
  assert.match(d.printed.join("\n"), /codeScoreThreshold override cleared \(now using global: 0\.4\)/);
  assert.doesNotMatch(d.printed.join("\n"), /expects a number/);
});

test("`default` stays an ordinary value for the nine non-allowlisted keys", async () => {
  const d = io();
  await settingsHandler(d, "embeddingApiKey", "default");
  assert.equal(d.globalWrites.length, 1);
  assert.equal(d.globalWrites[0].embeddingApiKey, "default");
  assert.equal(d.projectWrites.length, 0);
});

test("an unknown key errors; an allowlist miss is a route, not a failure", async () => {
  const d = io();
  await settingsHandler(d, "zzz", "1");
  assert.equal(d.printed.join("\n"), "error: settings: unknown key zzz");
  assert.equal(d.globalWrites.length, 0);
  assert.equal(d.projectWrites.length, 0);

  const routed = io();
  await settingsHandler(routed, "mode", "blackhole");
  await settingsHandler(routed, "qdrantUrl", "http://x");
  assert.doesNotMatch(routed.printed.join("\n"), /error:/);
});

test("invalid values keep the same errors and write nothing", async () => {
  const d = io();
  await settingsHandler(d, "codeKnowledge", "maybe");
  assert.match(d.printed.join("\n"), /settings: codeKnowledge must be one of off \| on/);
  assert.equal(d.projectWrites.length, 0);

  const d2 = io();
  await settingsHandler(d2, "codeScoreThreshold", "2.0");
  assert.match(d2.printed.join("\n"), /codeScoreThreshold expects a number between 0 and 1/);
  await settingsHandler(d2, "codeScoreThreshold", "abc");
  assert.match(d2.printed.join("\n"), /codeScoreThreshold expects a number/);
  assert.equal(d2.projectWrites.length, 0);
});

test("both allowlisted keys in the store: usage lists both; clearing one keeps the other", async () => {
  const d = io();
  d.storeState.codeKnowledge = "on";
  d.storeState.codeScoreThreshold = 0.6;
  await settingsHandler(d);
  let all = d.printed.join("\n");
  assert.match(all, /codeKnowledge = on \(this project; global: off\)/);
  assert.match(all, /codeScoreThreshold = 0\.6 \(this project; global: 0\.4\)/);

  await settingsHandler(d, "codeKnowledge", "default");
  assert.deepEqual(d.storeState, { codeScoreThreshold: 0.6 });
  assert.match(d.printed.join("\n"), /codeKnowledge override cleared \(now using global: off\)/);
});

test("bare command (headless) prints the scope rule, both paths, and this project's rows", async () => {
  const d = io();
  d.storeState.codeScoreThreshold = 0.6;
  await settingsHandler(d);
  assert.equal(d.emitted.length, 1);
  const all = d.printed.join("\n");
  assert.match(all, /codeKnowledge and codeScoreThreshold are per project/);
  assert.match(all, /pi-qdrant-memory\/projects\/pi-mem-abc\.json/);
  assert.match(all, /pi-qdrant-memory\/pi-qdrant-memory-config\.json/);
  assert.match(all, /codeKnowledge = off \(inherited from global\)/);
  assert.match(all, /codeScoreThreshold = 0\.6 \(this project; global: 0\.4\)/);
});

test("a masked project write (env pins the value) confirms but emits no notice", async () => {
  const d = io();
  d.envState.PI_QDRANT_CODE_KNOWLEDGE = "off";
  await settingsHandler(d, "codeKnowledge", "on");
  assert.deepEqual(d.projectWrites[0], { codeKnowledge: "on" });
  assert.match(d.printed.join("\n"), /codeKnowledge = on \(this project; global: off\)/);
  assert.doesNotMatch(d.printed.join("\n"), /next session start/);
});

test("form, project scope: an allowlisted write goes to the store and reloads", async () => {
  const d = io();
  d.globalState.codeKnowledge = "on"; // global on
  d.storeState.codeKnowledge = "off"; // override off → effective off
  let selects = 0;
  const ui: SettingsUI = {
    async select(_title, options) {
      selects++;
      if (selects === 1) return options.find((o) => o === "codeKnowledge = off (this project; global: on)");
      return options.find((o) => o === "on");
    },
    async input() { throw new Error("not used"); },
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.deepEqual(d.projectWrites[0], { codeKnowledge: "on" });
  assert.equal(d.globalWrites.length, 0);
  assert.match(d.printed.join("\n"), /takes effect at the next session start/); // off → on
});

test("form, global scope: persists the GLOBAL reader even with an override displayed", async () => {
  const d = io();
  d.globalState.codeKnowledge = "on";
  d.storeState.codeKnowledge = "off"; // effective off, but the label still names the layer
  const ui: SettingsUI = {
    async select(_title, options) { return options.find((o) => o.startsWith("qdrantUrl =")); },
    async input() { return "http://x:6333"; },
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.equal(d.globalWrites.length, 1);
  assert.equal(d.globalWrites[0].codeKnowledge, "on"); // the global value, not the override
  assert.equal(d.globalWrites[0].qdrantUrl, "http://x:6333");
  assert.equal(d.projectWrites.length, 0);
});

test("form reset-to-inherited: the select default option clears the override", async () => {
  const d = io();
  d.storeState.codeKnowledge = "on"; // override on; global off
  let selects = 0;
  const ui: SettingsUI = {
    async select(_title, options) {
      selects++;
      if (selects === 1) return options.find((o) => o.startsWith("codeKnowledge ="));
      return options.find((o) => o === "default (inherit global: off)");
    },
    async input() { throw new Error("not used"); },
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.deepEqual(d.cleared, ["codeKnowledge"]);
  assert.equal(d.projectWrites.length, 0);
  assert.match(d.printed.join("\n"), /codeKnowledge override cleared \(now using global: off\)/);
});

test("form reset-to-inherited: typed `default` clears the numeric override", async () => {
  const d = io();
  d.globalState.codeScoreThreshold = 0.55;
  d.storeState.codeScoreThreshold = 0.6;
  const ui: SettingsUI = {
    async select(_title, options) { return options.find((o) => o.startsWith("codeScoreThreshold =")); },
    async input(title) { assert.match(title, /"default" inherits global: 0\.55/); return "default"; },
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.deepEqual(d.cleared, ["codeScoreThreshold"]);
  assert.equal(d.projectWrites.length, 0);
  const all = d.printed.join("\n");
  assert.match(all, /codeScoreThreshold override cleared \(now using global: 0\.55\)/);
  assert.doesNotMatch(all, /expects a number/);
});

test("form: non-allowlisted fields expose no clear affordance", async () => {
  const d = io();
  let modeOptions: string[] = [];
  const ui: SettingsUI = {
    async select(title, options) {
      if (title.startsWith("Qdrant Memory")) return options.find((o) => o.startsWith("mode ="));
      modeOptions = options;
      return undefined;
    },
    async input() { throw new Error("mode is a select"); },
    async confirm() { return false; },
  };
  await runSettingsForm(ui, d);
  assert.deepEqual(modeOptions, ["auto", "blackhole", "own"]);

  let maxInputTitle = "";
  const d2 = io();
  const ui2: SettingsUI = {
    async select(_t, options) { return options.find((o) => o.startsWith("maxResults =")); },
    async input(title) { maxInputTitle = title; return undefined; },
    async confirm() { return false; },
  };
  await runSettingsForm(ui2, d2);
  assert.doesNotMatch(maxInputTitle, /default|inherit/);
});

test("help row names the scope rule and adds no second command", async () => {
  const d = io();
  await helpHandler(d);
  const all = d.printed.join("\n");
  assert.match(all, /persist a config field — codeKnowledge\/codeScoreThreshold apply to this project, other keys are global/);
  assert.match(all, /\/qdrant-settings <key> <value>/);
  assert.doesNotMatch(all, /qdrant-project-settings/);
});
