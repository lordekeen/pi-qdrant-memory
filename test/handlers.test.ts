import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  statusHandler, settingsHandler, rememberHandler, searchHandler, forgetHandler, clearHandler, helpHandler, runSettingsForm,
  FORGET_MAX_HITS,
} from "../src/handlers.ts";
import { outText } from "../src/out.ts";
import type { OutEntry } from "../src/out.ts";
import type { HandlerIO, SettingsUI } from "../src/handlers.ts";
import type { ProjectOverridableField, ProjectSettings } from "../src/project-settings.ts";
import {
  clearProjectField,
  loadProjectSettings,
  readEffectiveConfig,
  saveProjectSettings,
} from "../src/project-settings.ts";
import { readGlobalConfig, writeConfigFile } from "../src/config.ts";
import { DimensionMismatchError, QdrantClient, QdrantError, type QdrantLike } from "../src/qdrant.ts";
import { pointId } from "../src/ids.ts";
import { createMemoryStore } from "./support/memory-store.ts";
import type { MemoryStore, SeedPoint } from "./support/memory-store.ts";
import type { Config } from "../src/types.ts";

const cfg: Config = {
  qdrantUrl: "http://localhost:6333", qdrantApiKey: null,
  embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text",
  embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10, mode: "auto",
  codeKnowledge: "off", codeScoreThreshold: 0.4, memoryForget: "off",
};

/** A literal id in the shape projectIdFrom emits — the real project-store
 *  writers refuse anything else (src/project-settings.ts). */
const PROJECT_ID = "pi-mem-0123456789abcdef";

type FakeIO = HandlerIO & {
  emitted: OutEntry[];
  printed: string[];
  globalWrites: Config[];
  projectWrites: ProjectSettings[];
  cleared: ProjectOverridableField[];
  applied: Config[];
  /** The Qdrant side: the shared stateful store, not a call recorder. Clear
   *  and forget tests seed points and assert what the store still holds. */
  store: MemoryStore;
  /** Live view of the global config file (set a property to seed a scenario). */
  globalState: Config;
  /** Live view of the project store file (set a property to seed a scenario). */
  storeState: ProjectSettings;
  /** Live env model — set a key to exercise env masking. */
  envState: NodeJS.ProcessEnv;
};

/** Temp agent dirs are real; the process-exit hook cleans them up (node:test
 *  runs each test file in its own child process). */
const tempDirs: string[] = [];
process.on("exit", () => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function handlerAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-handlers-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * A live, mutable view over one JSON file the real reader/writer owns: reads
 * reflect the file, and a property write is a read-modify-write through the
 * real writer. That is what lets a test seed a scenario with
 * `d.globalState.scoreThreshold = 0.2` while the file stays the source of truth.
 */
function fileBacked<T extends object>(read: () => T, write: (next: T) => void): T {
  const snapshot = (): Record<string, unknown> => read() as unknown as Record<string, unknown>;
  return new Proxy({} as T, {
    get: (_target, key) => snapshot()[key as string],
    set: (_target, key, value) => {
      write({ ...snapshot(), [key as string]: value } as unknown as T);
      return true;
    },
    has: (_target, key) => (key as string) in snapshot(),
    ownKeys: () => Reflect.ownKeys(snapshot()),
    getOwnPropertyDescriptor: (_target, key) => {
      const desc = Reflect.getOwnPropertyDescriptor(snapshot(), key as string);
      return desc ? { ...desc, configurable: true } : undefined;
    },
  });
}

/**
 * Stateful two-store model backed by a REAL temp agent dir (AGENTS.md: a fake
 * that models a store must model its side effects). The global file and the
 * project store go through the production readers/writers — `readGlobalConfig`,
 * `readEffectiveConfig`, `writeConfigFile`, `saveProjectSettings`,
 * `clearProjectField` — so precedence is never re-implemented here. The
 * recording arrays and the `globalState`/`storeState` live views stay for
 * scenario seeding and assertions.
 */
function io(over: Partial<HandlerIO> = {}): FakeIO {
  const emitted: OutEntry[] = [];
  const printed: string[] = [];
  const globalWrites: Config[] = [];
  const projectWrites: ProjectSettings[] = [];
  const cleared: ProjectOverridableField[] = [];
  const applied: Config[] = [];
  const agentDir = over.agentDir ?? handlerAgentDir();
  const projectId = over.projectId ?? PROJECT_ID;
  const envState: NodeJS.ProcessEnv = {};
  // Seed the global file with the same base config the previous in-memory
  // model started from, so every scenario keeps its exact starting point.
  writeConfigFile(agentDir, { ...cfg });
  const effective = (): Config => readEffectiveConfig(agentDir, projectId, envState);
  const recordApplied = (): void => { applied.push(effective()); };
  const globalState = fileBacked<Config>(
    () => readGlobalConfig(agentDir, {}),
    (next) => writeConfigFile(agentDir, next),
  );
  const storeState = fileBacked<ProjectSettings>(
    () => loadProjectSettings(agentDir, projectId),
    (next) => saveProjectSettings(agentDir, projectId, next),
  );
  // Stateful Qdrant model (AGENTS.md testing conventions): an operation really
  // adds/removes points, so a clear/forget test asserts the store's POST state
  // (and its op timeline) instead of a call count. An unseeded store has no
  // collection, which is exactly what the read paths observe as missing.
  const store = createMemoryStore({ name: projectId });
  const qdrant: QdrantLike = store;
  return {
    get cfg() { return effective(); },
    get env() { return envState; },
    agentDir, cwd: "/repo", projectId,
    embed: async () => new Array(768).fill(0.1),
    qdrant,
    readGlobalConfig: () => readGlobalConfig(agentDir, envState),
    writeGlobalConfig: (c) => { globalWrites.push(c); writeConfigFile(agentDir, c); recordApplied(); },
    readProjectSettings: () => loadProjectSettings(agentDir, projectId),
    writeProjectSettings: (p) => { projectWrites.push(p); saveProjectSettings(agentDir, projectId, p); recordApplied(); },
    clearProjectSetting: (f) => { cleared.push(f); clearProjectField(agentDir, projectId, f); recordApplied(); },
    emit: (e) => { emitted.push(e); printed.push(outText(e)); },
    emitted,
    printed,
    globalWrites,
    projectWrites,
    cleared,
    applied,
    store,
    globalState,
    storeState,
    envState,
    ...over,
  } as FakeIO;
}

/** Temp agent dir with an operational pi-blackhole config (#50). */
function blackholeAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-bh-"));
  mkdirSync(join(dir, "pi-blackhole"), { recursive: true });
  writeFileSync(join(dir, "pi-blackhole", "pi-blackhole-config.json"), JSON.stringify({ enabled: true }));
  return dir;
}

/** A valid stored conversation memory for the in-memory store. */
function memoryPoint(id: string, text = `memory ${id}`): SeedPoint {
  return { id, payload: { type: "fact", text, project_id: PROJECT_ID, ts: 1, source_kind: "remember_tool" } };
}

/** A valid stored code-summary point for the in-memory store. */
function codePoint(id: string): SeedPoint {
  return { id, payload: { type: "code", text: `code ${id}`, project_id: PROJECT_ID, ts: 1, source_kind: "code_summary" } };
}

test("statusHandler prints mode and collection health", async () => {
  const d = io();
  d.store.seed([memoryPoint("m1"), memoryPoint("m2"), memoryPoint("m3")]);
  await statusHandler(d);
  const all = d.printed.join("\n");
  assert.match(all, /mode2/i); // auto with no blackhole → mode2
  assert.match(all, /✓ reachable · 3 points/);
  // The entry heads with the footer-style header and shows the collection id
  // inline — nothing is hidden behind an expand gesture anymore.
  assert.ok(all.includes(`🧠 Memory: mode2 (${PROJECT_ID})`));
  assert.match(all, /qdrant url: http:\/\/localhost:6333/);
  assert.equal(d.emitted.length, 1);
  assert.equal(d.emitted[0].kind, "status");
});

test("statusHandler redacts credentials in detail output", async () => {
  const d = io();
  d.globalState.qdrantUrl = "http://admin:hunter2@qdrant.local:6333";
  d.globalState.embeddingBaseURL = "http://tok:pass@embed.local:8080/v1";
  await statusHandler(d);
  const text = d.printed.join("\n");
  assert.ok(!text.includes("hunter2"), "qdrantUrl password leaked");
  assert.ok(!text.includes("pass@"), "embeddingBaseURL password leaked");
  assert.ok(text.includes("***"), "redacted placeholder present");
});

test("settingsHandler persists field=value and prints confirmation", async () => {
  const d = io();
  await settingsHandler(d, "scoreThreshold", "0.2");
  assert.equal(d.globalWrites.length, 1);
  assert.equal(d.globalWrites[0].scoreThreshold, 0.2);
  assert.match(d.printed.join("\n"), /scoreThreshold/);
});

test("settingsHandler delegates an allowlisted write to the project store", async () => {
  const d = io();
  await settingsHandler(d, "codeKnowledge", "on");
  assert.deepEqual(d.projectWrites, [{ codeKnowledge: "on" }]);
  assert.equal(d.globalWrites.length, 0);
});

test("statusHandler distinguishes a missing collection from an unreachable server", async () => {
  // An unseeded store has no collection: count() raises the same 404 a fresh
  // project does, which must read as "does not exist yet" — never as a down
  // server (`err`).
  const missing = io();
  await statusHandler(missing);
  assert.doesNotMatch(missing.printed.join("\n"), /NOT reachable/);
  assert.match(missing.printed.join("\n"), /does not exist yet/);

  // Any other count failure is a down server, not an empty collection.
  const down = io();
  down.qdrant.count = async () => { throw new QdrantError("Qdrant request GET ... failed: HTTP 500", 500); };
  await statusHandler(down);
  assert.match(down.printed.join("\n"), /qdrant: ✗ NOT reachable/);
});

test("statusHandler warns when mode=own conflicts with an operational pi-blackhole (#50)", async () => {
  const agentDir = blackholeAgentDir();
  try {
    const own = io({ agentDir });
    own.globalState.mode = "own";
    await statusHandler(own);
    assert.match(own.printed.join("\n"), /mode: ! own while pi-blackhole is installed/);

    const auto = io({ agentDir });
    auto.globalState.mode = "auto";
    await statusHandler(auto);
    assert.match(auto.printed.join("\n"), /🧠 Memory: mode1/);
    assert.doesNotMatch(auto.printed.join("\n"), /both extensions claim session_before_compact/);
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test("statusHandler reads the pi-blackhole state once per invocation (#69)", async () => {
  // `modeConflict` is the #50 check: mode `own` + an operational pi-blackhole.
  // The blackhole config flips DURING the invocation — inside the embedding
  // probe, after the mode was resolved but before the health block is built.
  // Two detections would report mode2 and still warn about a state the mode
  // snapshot never saw (or miss a state it did see); one detection reports the
  // snapshot both facts were resolved from.
  const appeared = io();
  appeared.globalState.mode = "own";
  const embed = appeared.embed;
  appeared.embed = async (t: string) => {
    mkdirSync(join(appeared.agentDir, "pi-blackhole"), { recursive: true });
    writeFileSync(join(appeared.agentDir, "pi-blackhole", "pi-blackhole-config.json"), JSON.stringify({ enabled: true }));
    return embed(t);
  };
  await statusHandler(appeared);
  assert.match(appeared.printed.join("\n"), /🧠 Memory: mode2/); // explicit own → mode2
  assert.doesNotMatch(appeared.printed.join("\n"), /mode: ! own while pi-blackhole is installed/,
    "no conflict may appear from a detection the resolved mode did not come from");

  // Mirrored flip: the file vanishing mid-invocation must not erase the
  // conflict the resolved snapshot saw.
  const agentDir = blackholeAgentDir();
  try {
    const vanished = io({ agentDir });
    vanished.globalState.mode = "own";
    const embed2 = vanished.embed;
    vanished.embed = async (t: string) => {
      rmSync(join(agentDir, "pi-blackhole"), { recursive: true, force: true });
      return embed2(t);
    };
    await statusHandler(vanished);
    assert.match(vanished.printed.join("\n"), /🧠 Memory: mode2/);
    assert.match(vanished.printed.join("\n"), /mode: ! own while pi-blackhole is installed/);
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test("statusHandler with real QdrantClient reports collection does not exist yet on 404", async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ status: "error", message: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
  const realClient = new QdrantClient("http://qdrant:6333", null, fakeFetch);
  const d = io({ qdrant: realClient });
  await statusHandler(d);
  const all = d.printed.join("\n");
  assert.doesNotMatch(all, /NOT reachable/);
  assert.match(all, /does not exist yet/);
});

test("statusHandler caches embedding probe for 30s TTL (OI-011)", async () => {
  let probeCount = 0;
  let now = 1000;
  const d = io({
    embed: async (t: string) => {
      if (t === "probe") probeCount++;
      return new Array(768).fill(0.1);
    },
    now: () => now,
  });

  // First call probes
  await statusHandler(d);
  assert.equal(probeCount, 1);
  assert.match(d.printed[0], /✓ reachable/);

  // Second call within TTL (e.g. +10s) uses cached probe result
  now += 10_000;
  await statusHandler(d);
  assert.equal(probeCount, 1);

  // Third call after 30s TTL (now + 31s from first call) probes again
  now += 21_000;
  await statusHandler(d);
  assert.equal(probeCount, 2);
});

test("statusHandler caches embedding probe failure for 5s TTL (OI-011)", async () => {
  let probeCount = 0;
  let now = 1000;
  const d = io({
    embed: async (t: string) => {
      if (t === "probe") probeCount++;
      throw new Error("endpoint unreachable");
    },
    now: () => now,
  });

  // First call probes and fails
  await statusHandler(d);
  assert.equal(probeCount, 1);
  assert.match(d.printed[0], /✗ NOT reachable/);

  // Second call within 5s failure TTL (e.g. +3s) uses cached failure
  now += 3_000;
  await statusHandler(d);
  assert.equal(probeCount, 1);
  assert.match(d.printed[1], /✗ NOT reachable/);

  // Third call after 5s TTL (now + 6s from first call) probes again
  now += 3_000;
  await statusHandler(d);
  assert.equal(probeCount, 2);
});

test("statusHandler invalidates probe cache when embedding config changes (OI-011)", async () => {
  let probeCount = 0;
  let now = 1000;
  const d = io({
    embed: async (t: string) => {
      if (t === "probe") probeCount++;
      return new Array(768).fill(0.1);
    },
    now: () => now,
  });

  await statusHandler(d);
  assert.equal(probeCount, 1);

  // Within TTL, but config changes
  d.globalState.embeddingModel = "another-model";
  await statusHandler(d);
  assert.equal(probeCount, 2);
});

test("statusHandler bounds hanging embedding probe within probe timeout (OI-011)", async () => {
  const d = io({
    embed: async () => new Promise<number[]>(() => {}), // never resolves
    embedProbeTimeoutMs: 20, // fast timeout for test
  });

  const start = Date.now();
  await statusHandler(d);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 2000, `Expected probe to time out quickly, took ${elapsed}ms`);
  const all = d.printed.join("\n");
  assert.match(all, /✗ NOT reachable/);
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

test("rememberHandler prints already saved when point already exists (Shape C)", async () => {
  const d = io();
  const targetId = pointId("use REST", "remember_tool", "");
  d.qdrant.existingPointIds = async (_name, ids) => new Set(ids.filter((id) => id === targetId));
  await rememberHandler(d, "use REST", "decision");
  const all = d.printed.join("\n");
  assert.match(all, /already saved: use REST/);
});

test("searchHandler prints no-relevant-memory message on empty", async () => {
  const d = io();
  await searchHandler(d, "anything");
  assert.match(d.printed.join("\n"), /No relevant memory/);
});

test("clearHandler with 'all' refuses without a UI and deletes nothing", async () => {
  const d = io();
  await clearHandler(d, "all");
  assert.ok(!d.store.timeline.some((op) => op.op === "clear"), "the refusal must not clear");
  assert.equal(d.emitted.length, 1);
  assert.equal(d.emitted[0].kind, "error");
  assert.match(d.printed[0], /error: \/qdrant clear all requires interactive UI confirmation/);
});

test("clearHandler with 'all' clears after a confirmed dialog", async () => {
  const d = io();
  d.store.seed([memoryPoint("m1"), memoryPoint("m2"), memoryPoint("m3")]);
  let confirms = 0;
  let confirmTitle = "";
  let confirmMessage = "";
  const ui: SettingsUI = {
    async select() { return undefined; },
    async input() { return undefined; },
    async confirm(t, m) { confirms++; confirmTitle = t; confirmMessage = m; return true; },
  };
  await clearHandler(d, "all", ui);
  assert.equal(confirms, 1);
  // The dialog names the project and the exact stored count (3 seeded points).
  assert.equal(confirmTitle, `Reset ${PROJECT_ID} and delete all 3 stored memories?`);
  assert.equal(confirmMessage, "Deletes every memory and code summary for this project from Qdrant. This cannot be undone.");
  // The store really lost the points — not merely a recorded call.
  assert.ok(d.store.timeline.some((op) => op.op === "clear"), "the confirmed clear reached the store");
  assert.equal(d.store.dimensionOf(), undefined);
  assert.deepEqual(d.store.points(), []);
  assert.ok(d.printed.join("\n").includes(`cleared: collection ${PROJECT_ID} reset`));
});

test("clearHandler with 'all' uses the singular title for one point", async () => {
  const d = io();
  d.store.seed([memoryPoint("m1")]);
  let confirmTitle = "";
  const ui: SettingsUI = {
    async select() { return undefined; },
    async input() { return undefined; },
    async confirm(t) { confirmTitle = t; return true; },
  };
  await clearHandler(d, "all", ui);
  assert.equal(confirmTitle, `Reset ${PROJECT_ID} and delete all 1 stored memory?`);
  assert.ok(d.store.timeline.some((op) => op.op === "clear"));
  assert.deepEqual(d.store.points(), []);
});

test("clearHandler with 'all' does not clear when the dialog is declined", async () => {
  const d = io();
  d.store.seed([memoryPoint("m1"), memoryPoint("m2"), memoryPoint("m3")]);
  let confirms = 0;
  const ui: SettingsUI = {
    async select() { return undefined; },
    async input() { return undefined; },
    async confirm() { confirms++; return false; },
  };
  await clearHandler(d, "all", ui);
  assert.equal(confirms, 1);
  assert.ok(!d.store.timeline.some((op) => op.op === "clear"), "a declined dialog must not clear");
  assert.equal(d.store.points().length, 3, "the stored points survive");
  assert.match(d.printed.join("\n"), /clear: unchanged \(cancelled\)/);
});

test("clearHandler with 'all' on an empty collection never opens a dialog", async () => {
  const d = io();
  d.store.seed([]); // the collection exists but holds no points
  let confirms = 0;
  const ui: SettingsUI = {
    async select() { return undefined; },
    async input() { return undefined; },
    async confirm() { confirms++; return true; },
  };
  await clearHandler(d, "all", ui);
  assert.equal(confirms, 0, "nothing to act on means no dialog");
  assert.ok(!d.store.timeline.some((op) => op.op === "clear"));
  assert.equal(d.store.dimensionOf(), 768, "the empty collection is left in place");
  assert.ok(d.printed.join("\n").includes(`clear: collection ${PROJECT_ID} is already empty`));
});

test("clearHandler with 'all' treats a missing collection (count 404) as empty", async () => {
  // Unseeded store → no collection → count() raises the same 404 a fresh
  // project does; that must read as empty, never as a failed clear.
  const d = io();
  let confirms = 0;
  const ui: SettingsUI = {
    async select() { return undefined; },
    async input() { return undefined; },
    async confirm() { confirms++; return true; },
  };
  await clearHandler(d, "all", ui);
  assert.equal(confirms, 0, "absent collection is empty — no dialog");
  assert.ok(!d.store.timeline.some((op) => op.op === "clear"));
  assert.ok(d.printed.join("\n").includes(`clear: collection ${PROJECT_ID} is already empty`));
});

test("clearHandler with 'all' reports a non-404 count failure without clearing or confirming", async () => {
  const d = io();
  d.qdrant.count = async () => { throw new QdrantError(`Qdrant request GET http://localhost:6333/collections/${PROJECT_ID} failed: HTTP 500`, 500); };
  let confirms = 0;
  const ui: SettingsUI = {
    async select() { return undefined; },
    async input() { return undefined; },
    async confirm() { confirms++; return true; },
  };
  await clearHandler(d, "all", ui);
  assert.equal(confirms, 0);
  assert.ok(!d.store.timeline.some((op) => op.op === "clear"));
  assert.equal(d.emitted.length, 1);
  assert.equal(d.emitted[0].kind, "error");
  assert.match(d.printed[0], /error: clear failed: .*HTTP 500/);
});

test("clearHandler without arguments prints usage guidance without clearing", async () => {
  const d = io();
  await clearHandler(d);
  assert.deepEqual(d.store.timeline, []);
  assert.match(d.printed.join("\n"), /clear: usage — \/qdrant clear all \| code/);
});

test("clearHandler with invalid modifier prints usage guidance without clearing", async () => {
  const d = io();
  await clearHandler(d, "nonsense");
  assert.deepEqual(d.store.timeline, []);
  assert.match(d.printed.join("\n"), /clear: usage — \/qdrant clear all \| code/);
});

test("clearHandler with 'code' when points exist deletes them and prints count", async () => {
  const d = io();
  d.store.seed(["c1", "c2", "c3", "c4", "c5"].map(codePoint));
  await clearHandler(d, "code");
  assert.equal(await d.store.countBySourceKind(PROJECT_ID, "code_summary"), 0);
  assert.deepEqual(d.store.points(), []);
  assert.ok(d.store.timeline.some((op) =>
    op.op === "delete" && op.by === "source_kind" && op.kind === "code_summary"),
    "the code points were deleted by source kind");
  assert.ok(!d.store.timeline.some((op) => op.op === "clear"), "clear code never wipes the collection");
  assert.match(d.printed.join("\n"), /cleared: 5 code memory points removed/);
});

test("clearHandler with 'code' when 0 points exist reports no points indexed", async () => {
  const d = io();
  d.store.seed([memoryPoint("m1")]); // a memory exists, but no code point
  await clearHandler(d, "code");
  assert.deepEqual(d.store.timeline, [], "nothing is deleted when no code point exists");
  assert.match(d.printed.join("\n"), /clear: no code points indexed/);
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

test("runSettingsForm Esc on the field list writes nothing, and says so (#58)", async () => {
  const d = io();
  const ui: SettingsUI = {
    async select() { return undefined; },
    async input() { return "0.25"; },
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.equal(d.globalWrites.length, 0);
  assert.equal(d.projectWrites.length, 0);
  // #58: this path used to return silently. Esc before a field is chosen has no
  // key to name, so it reports the form as a whole.
  assert.deepEqual(
    d.emitted.map((e) => outText(e)),
    ["settings: unchanged (cancelled)"],
  );
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

test("runSettingsForm clears an API key when input is emptied", async () => {
  const d = io();
  d.globalState.qdrantApiKey = "old-key";
  const ui: SettingsUI = {
    async select(_title, options) {
      return options.find((o) => o.startsWith("qdrantApiKey ="));
    },
    async input(_prompt, _default) { return ""; }, // user clears the field
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.equal(d.globalWrites.length, 1);
  assert.equal(d.globalWrites[0].qdrantApiKey, null, "API key should be null");
});

test("runSettingsForm Esc on API key input writes nothing", async () => {
  const d = io();
  d.globalState.qdrantApiKey = "old-key";
  const ui: SettingsUI = {
    async select(_title, options) {
      return options.find((o) => o.startsWith("qdrantApiKey ="));
    },
    async input() { return undefined; }, // Esc
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.equal(d.globalWrites.length, 0, "Esc must not write");
});

test("runSettingsForm empty input on a non-nullable field cancels", async () => {
  const d = io();
  const ui: SettingsUI = {
    async select(_title, options) {
      return options.find((o) => o.startsWith("qdrantUrl ="));
    },
    async input() { return ""; }, // empty input
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.equal(d.globalWrites.length, 0, "non-nullable empty input must cancel");
});

test("runSettingsForm prompt for API key includes clear hint", async () => {
  const d = io();
  d.globalState.qdrantApiKey = "key";
  let capturedPrompt = "";
  const ui: SettingsUI = {
    async select(_title, options) {
      return options.find((o) => o.startsWith("qdrantApiKey ="));
    },
    async input(prompt) { capturedPrompt = prompt; return undefined; },
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.ok(capturedPrompt.includes("clear to remove"),
    `prompt should hint removal, got: ${capturedPrompt}`);
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
  for (const c of ["/qdrant status", "/qdrant settings", "/qdrant remember", "/qdrant search", "/qdrant forget", "/qdrant clear", "/qdrant help"]) {
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
  const d = io();
  d.qdrant.search = async () => { throw new Error("connection refused"); };
  await searchHandler(d, "query");
  assert.equal(d.emitted[0].kind, "error");
  // Command voice: /qdrant search failures read "error: search failed: <reason>"
  // (plan §1.2). `res.error` is a bare reason, so the LLM tool's
  // "memory_search failed:" lead never leaks here (DESIGN.md agent-tool-results)
  // — and the reason is not double-labelled.
  assert.equal(d.printed.join("\n"), "error: search failed: Error: connection refused");
  assert.doesNotMatch(d.printed.join("\n"), /memory_search failed/);
  assert.doesNotMatch(d.printed.join("\n"), /search failed: search failed/);
});

test("searchHandler emits an error entry on dimension mismatch (OI-001)", async () => {
  const d = io();
  // A collection from a previous embedding model: the read path's ensure
  // policy surfaces the mismatch as an error instead of recreating.
  d.qdrant.ensureCollection = async (name, dim) => { throw new DimensionMismatchError(name, 384, dim); };
  await searchHandler(d, "query");
  assert.equal(d.emitted[0].kind, "error");
  assert.match(d.printed.join("\n"), /error: search failed: .* dim 384 ≠ expectedDimension 768/);
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

test("statusHandler includes the code-memory row when the feature is wired", async () => {
  const d = io({ codeMemory: { state: "synced", files: 4, symbols: 21 } });
  await statusHandler(d);
  const all = d.printed.join("\n");
  assert.match(all, /code memory: ✓ 4 files · 21 symbols/);
  assert.match(all, /code threshold: 0\.4/);
});

test("statusHandler omits the code-memory row when not wired", async () => {
  const d = io();
  await statusHandler(d);
  const all = d.printed.join("\n");
  assert.doesNotMatch(all, /code memory/);
  assert.doesNotMatch(all, /code threshold:/);
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

test("help lists /qdrant index code only when codeKnowledge is on", async () => {
  const on = io({ cfg: { ...cfg, codeKnowledge: "on" } });
  await helpHandler(on);
  assert.match(on.printed.join("\n"), /\/qdrant index code/);

  const off = io();
  await helpHandler(off);
  assert.doesNotMatch(off.printed.join("\n"), /\/qdrant index/);
});

// ── §7.3 mixed-scope routing ─────────────────────────────────────────────────

test("usage lists every allowlisted override in the store", async () => {
  const d = io();
  d.storeState.codeKnowledge = "on";
  d.storeState.codeScoreThreshold = 0.6;
  await settingsHandler(d);
  const all = d.printed.join("\n");
  assert.match(all, /codeKnowledge = on \(this project; global: off\)/);
  assert.match(all, /codeScoreThreshold = 0\.6 \(this project; global: 0\.4\)/);
});

test("bare command (headless) prints the scope rule, both paths, and this project's rows", async () => {
  const d = io();
  d.storeState.codeScoreThreshold = 0.6;
  await settingsHandler(d);
  assert.equal(d.emitted.length, 1);
  const all = d.printed.join("\n");
  assert.match(all, /codeKnowledge and codeScoreThreshold are per project/);
  assert.ok(all.includes(`pi-qdrant-memory/projects/${PROJECT_ID}.json`));
  assert.match(all, /pi-qdrant-memory\/pi-qdrant-memory-config\.json/);
  assert.match(all, /codeKnowledge = off \(inherited from global\)/);
  assert.match(all, /codeScoreThreshold = 0\.6 \(this project; global: 0\.4\)/);
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
  assert.match(all, /\/qdrant settings \[key\] \[value\]/);
  assert.match(all, /\/qdrant forget <query>/);
  assert.doesNotMatch(all, /qdrant-project-settings/);
  // The old per-verb command names are gone from the help block (hard cut).
  assert.doesNotMatch(all, /qdrant-(status|settings|remember|search|forget|clear|help|index-code)/);
});

test("forgetHandler validates query and requires arguments", async () => {
  const d = io();
  await forgetHandler(d, "   ");
  assert.equal(d.emitted.length, 1);
  assert.equal(d.emitted[0].kind, "message");
  assert.match(d.printed[0], /usage: \/qdrant forget <search query>/);
});

test("forgetHandler emits message when no memories match query", async () => {
  const d = io();
  await forgetHandler(d, "nonexistent");
  assert.equal(d.emitted.length, 1);
  assert.equal(d.emitted[0].kind, "message");
  assert.match(d.printed[0], /forget: no memories matched "nonexistent"/);
});

test("forgetHandler emits error when search fails", async () => {
  const d = io();
  d.qdrant.search = async () => { throw new Error("qdrant down"); };
  await forgetHandler(d, "test");
  assert.equal(d.emitted.length, 1);
  assert.equal(d.emitted[0].kind, "error");
  assert.match(d.printed[0], /error: forget failed: Error: qdrant down/);
});

test("forgetHandler requires interactive UI when hits match", async () => {
  const hit = { id: "pt-1", score: 0.9, payload: { type: "fact" as const, text: "auth uses JWT", project_id: "p", ts: 1, source_kind: "remember_tool" as const } };
  const d = io();
  d.store.seed([memoryPoint("pt-1")]);
  d.qdrant.search = async () => [hit];
  await forgetHandler(d, "auth");
  assert.equal(d.emitted.length, 1);
  assert.equal(d.emitted[0].kind, "error");
  assert.match(d.printed[0], /error: \/qdrant forget requires interactive UI confirmation/);
  assert.equal(d.store.points().length, 1, "no UI means nothing is deleted");
});

test("forgetHandler cancels when user declines confirmation", async () => {
  const hit = { id: "pt-1", score: 0.9, payload: { type: "fact" as const, text: "auth uses JWT", project_id: "p", ts: 1, source_kind: "remember_tool" as const } };
  const d = io();
  d.store.seed([memoryPoint("pt-1")]);
  d.qdrant.search = async () => [hit];
  const ui: SettingsUI = {
    async select() { return undefined; },
    async input() { return undefined; },
    async confirm() { return false; },
  };
  await forgetHandler(d, "auth", ui);
  assert.equal(d.emitted.length, 2);
  assert.equal(d.emitted[0].kind, "search");
  assert.equal(d.emitted[1].kind, "message");
  assert.match(d.printed[1], /forget: unchanged \(cancelled\)/);
  assert.ok(!d.store.timeline.some((op) => op.op === "delete"), "a declined confirm deletes nothing");
  assert.equal(d.store.points().length, 1, "the matched point survives");
});

test("forgetHandler deletes points and emits confirmation when confirmed", async () => {
  const hits = [
    { id: "pt-1", score: 0.9, payload: { type: "fact" as const, text: "auth uses JWT", project_id: "p", ts: 1, source_kind: "remember_tool" as const } },
    { id: "pt-2", score: 0.85, payload: { type: "decision" as const, text: "session tokens expire in 1h", project_id: "p", ts: 2, source_kind: "remember_tool" as const } },
  ];
  const d = io();
  d.store.seed([memoryPoint("pt-1"), memoryPoint("pt-2")]);
  d.qdrant.search = async () => hits;
  let confirmTitle = "";
  let confirmMessage = "";
  const ui: SettingsUI = {
    async select() { return undefined; },
    async input() { return undefined; },
    async confirm(t, m) { confirmTitle = t; confirmMessage = m; return true; },
  };
  await forgetHandler(d, "auth", ui);
  assert.equal(confirmTitle, "Remove memories?");
  assert.match(confirmMessage, /Delete 2 matching memories/);
  // The dialog names exactly which memories the Yes deletes (#48).
  assert.match(confirmMessage, /1\. \[fact\] 0\.90 — "auth uses JWT"/);
  assert.match(confirmMessage, /2\. \[decision\] 0\.85 — "session tokens expire in 1h"/);
  assert.equal(d.emitted.length, 2);
  assert.equal(d.emitted[0].kind, "search");
  assert.equal(d.emitted[1].kind, "message");
  assert.match(d.printed[1], /forgotten: 2 memories removed/);
  // The store really lost both points (and only those).
  assert.deepEqual(d.store.points(), []);
  assert.deepEqual(d.store.timeline.filter((op) => op.op === "delete"), [
    { op: "delete", by: "ids", ids: ["pt-1", "pt-2"] },
  ]);
});

test("forgetHandler caps at FORGET_MAX_HITS and says further matches are untouched (#48)", async () => {
  const hits = Array.from({ length: FORGET_MAX_HITS + 1 }, (_v, i) => ({
    id: `pt-${String(i + 1)}`,
    score: 0.9 - i * 0.01,
    payload: { type: "fact" as const, text: `match ${String(i + 1)}`, project_id: "p", ts: i, source_kind: "remember_tool" as const },
  }));
  const d = io();
  d.store.seed(hits.map((h) => memoryPoint(h.id)));
  d.qdrant.search = async () => hits;
  let confirmMessage = "";
  const ui: SettingsUI = {
    async select() { return undefined; },
    async input() { return undefined; },
    async confirm(_t, m) { confirmMessage = m; return true; },
  };
  await forgetHandler(d, "fact", ui);
  const searchEntry = d.emitted[0] as { kind: string; hits: unknown[] };
  assert.equal(searchEntry.kind, "search");
  assert.equal(searchEntry.hits.length, FORGET_MAX_HITS, "the probe hit is never shown");
  assert.match(confirmMessage, /Delete 5 matching memories/);
  assert.match(confirmMessage, /1\. \[fact\] 0\.90 — "match 1"/);
  assert.match(confirmMessage, /5\. \[fact\] 0\.86 — "match 5"/);
  assert.doesNotMatch(confirmMessage, /match 6/);
  assert.match(confirmMessage, /Only these 5 closest matches are deleted; other matches above the threshold are left untouched\./);
  // Exactly the five confirmed points are gone; the sixth probe hit survives.
  assert.deepEqual(d.store.points().map((p) => p.id), ["pt-6"]);
  assert.deepEqual(d.store.timeline.filter((op) => op.op === "delete"), [
    { op: "delete", by: "ids", ids: ["pt-1", "pt-2", "pt-3", "pt-4", "pt-5"] },
  ]);
  assert.equal(d.printed.at(-1), "forgotten: 5 memories removed");
});

test("forgetHandler emits error when deletePointsByIds throws", async () => {
  const hits = [
    { id: "pt-1", score: 0.9, payload: { type: "fact" as const, text: "auth uses JWT", project_id: "p", ts: 1, source_kind: "remember_tool" as const } },
  ];
  const d = io();
  d.store.seed([memoryPoint("pt-1")]);
  d.qdrant.search = async () => hits;
  d.qdrant.deletePointsByIds = async () => { throw new Error("Qdrant write failed: timeout"); };
  const ui: SettingsUI = {
    async select() { return undefined; },
    async input() { return undefined; },
    async confirm() { return true; },
  };
  await forgetHandler(d, "auth", ui);
  assert.equal(d.emitted.length, 2);
  assert.equal(d.emitted[0].kind, "search");
  assert.equal(d.emitted[1].kind, "error");
  assert.match(d.printed[1], /error: forget failed: Qdrant write failed: timeout/);
  assert.equal(d.store.points().length, 1, "a failed delete leaves the point in place");
});

test("clearHandler resets codeMemory counters to 0 on clear code and clear all", async () => {
  const d = io({ codeMemory: { state: "synced", files: 2, symbols: 5 } });
  d.store.seed(["c1", "c2", "c3", "c4", "c5"].map(codePoint));
  await clearHandler(d, "code");
  assert.equal(d.codeMemory?.files, 0);
  assert.equal(d.codeMemory?.symbols, 0);

  const d2 = io({ codeMemory: { state: "synced", files: 4, symbols: 20 } });
  d2.store.seed([memoryPoint("m1"), memoryPoint("m2"), memoryPoint("m3")]);
  const ui2: SettingsUI = {
    async select() { return undefined; },
    async input() { return undefined; },
    async confirm() { return true; },
  };
  await clearHandler(d2, "all", ui2);
  assert.equal(d2.codeMemory?.files, 0);
  assert.equal(d2.codeMemory?.symbols, 0);
});

test("clearHandler resets stale codeMemory counters on the empty-collection path (#61)", async () => {
  // Regression of #44: the count === 0 early return skipped the reset, so an
  // empty collection with a stale in-memory inventory kept reporting deleted
  // files/symbols in /qdrant status.
  const ui: SettingsUI = {
    async select() { return undefined; },
    async input() { return undefined; },
    async confirm() { return true; },
  };
  const d = io({ codeMemory: { state: "synced", files: 7, symbols: 33 } });
  d.store.seed([]); // an existing but empty collection
  await clearHandler(d, "all", ui);
  assert.equal(d.codeMemory?.files, 0);
  assert.equal(d.codeMemory?.symbols, 0);
  assert.ok(d.printed.join("\n").includes(`clear: collection ${PROJECT_ID} is already empty`));
  assert.deepEqual(d.store.timeline, [], "nothing to delete means nothing is deleted");
});

test("clearHandler leaves stale counters alone when the clear is refused or declined (#61)", async () => {
  // The refusal and the declined-confirm paths delete nothing, so they must not
  // claim the inventory is empty.
  const noUi = io({ codeMemory: { state: "synced", files: 3, symbols: 9 } });
  await clearHandler(noUi, "all");
  assert.equal(noUi.codeMemory?.files, 3);

  const declinedUi: SettingsUI = {
    async select() { return undefined; },
    async input() { return undefined; },
    async confirm() { return false; },
  };
  const declined = io({ codeMemory: { state: "synced", files: 3, symbols: 9 } });
  declined.store.seed([memoryPoint("m1"), memoryPoint("m2"), memoryPoint("m3")]);
  await clearHandler(declined, "all", declinedUi);
  assert.equal(declined.codeMemory?.files, 3);
  assert.equal(declined.codeMemory?.symbols, 9);
  assert.equal(declined.store.points().length, 3, "a declined confirm leaves the store untouched");
});

// ── #58: secrets and cancellation on the DIALOG form path ────────────────────
//
// The SettingsList screen masks secrets at the mapping level (settings-ui.ts),
// but this form is the fallback path and used to print the credential twice:
// once in the pick label and once as the input's placeholder.

const FORM_SECRET = "sk-form-secret-never-show-4242";

test("runSettingsForm pick labels never render a secret value (#58)", async () => {
  const d = io({ cfg: { ...cfg, qdrantApiKey: FORM_SECRET, embeddingApiKey: null } });
  let labels: string[] = [];
  const ui: SettingsUI = {
    async select(_title, options) { labels = options; return undefined; },
    async input() { return undefined; },
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.ok(labels.length === 12);
  const rendered = labels.join("\n");
  assert.ok(!rendered.includes(FORM_SECRET), `secret leaked into the picker: ${rendered}`);
  // The set-state still carries the fact the user needs.
  assert.ok(labels.some((l) => l.startsWith("qdrantApiKey = set")), rendered);
  assert.ok(labels.some((l) => l.startsWith("embeddingApiKey = not set")), rendered);
  // Non-secret fields still show their real value.
  assert.ok(labels.some((l) => l.startsWith("expectedDimension = 768")), rendered);
});

test("runSettingsForm never prefills a secret into the prompt (#58)", async () => {
  const d = io({ cfg: { ...cfg, qdrantApiKey: FORM_SECRET } });
  let placeholder: string | undefined = "unset";
  const ui: SettingsUI = {
    async select(_title, options) { return options.find((o) => o.startsWith("qdrantApiKey =")); },
    async input(_title, ph) { placeholder = ph; return undefined; },
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.equal(placeholder, undefined, "a secret must not be the placeholder");
});

test("a non-secret field is still prefilled, so the form stays usable", async () => {
  const d = io();
  let placeholder: string | undefined;
  const ui: SettingsUI = {
    async select(_title, options) { return options.find((o) => o.startsWith("expectedDimension =")); },
    async input(_title, ph) { placeholder = ph; return undefined; },
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.equal(placeholder, "768");
});

test("Esc at the input step is a visible cancellation (#58)", async () => {
  const d = io();
  let confirms = 0;
  const ui: SettingsUI = {
    async select(_title, options) { return options.find((o) => o.startsWith("scoreThreshold =")); },
    async input() { return undefined; },
    async confirm() { confirms++; return true; },
  };
  await runSettingsForm(ui, d);
  assert.equal(confirms, 0);
  assert.equal(d.globalWrites.length, 0);
  assert.deepEqual(d.emitted.map((e) => outText(e)), ["settings: scoreThreshold unchanged (cancelled)"]);
});

test("empty input on a NON-nullable field is a cancellation, not silence (#58)", async () => {
  const d = io();
  let confirms = 0;
  const ui: SettingsUI = {
    async select(_title, options) { return options.find((o) => o.startsWith("maxResults =")); },
    async input() { return ""; },
    async confirm() { confirms++; return true; },
  };
  await runSettingsForm(ui, d);
  assert.equal(confirms, 0, "an empty value on a non-nullable field never confirms");
  assert.equal(d.globalWrites.length, 0);
  assert.deepEqual(d.emitted.map((e) => outText(e)), ["settings: maxResults unchanged (cancelled)"]);
});

test("empty input on a SECRET field still clears it (not a cancellation)", async () => {
  const d = io({ cfg: { ...cfg, qdrantApiKey: FORM_SECRET } });
  const ui: SettingsUI = {
    async select(_title, options) { return options.find((o) => o.startsWith("qdrantApiKey =")); },
    async input() { return ""; },
    async confirm() { return true; },
  };
  await runSettingsForm(ui, d);
  assert.equal(d.globalWrites.length, 1);
  assert.equal(d.globalWrites[0].qdrantApiKey, null, "empty clears the key");
  // And the confirmation must not echo the old secret either.
  assert.ok(!d.emitted.map((e) => outText(e)).join("\n").includes(FORM_SECRET));
});

test("a declined confirm still names the field (#58)", async () => {
  const d = io();
  const ui: SettingsUI = {
    async select(_title, options) { return options.find((o) => o.startsWith("memoryForget =")); },
    async input() { return undefined; },
    async confirm() { return false; },
  };
  // memoryForget is a select-driven enum; drive the value step then decline.
  const ui2: SettingsUI = {
    async select(title: string, options: string[]) {
      return options.includes("on") && title.includes("memoryForget") ? "on" : "memoryForget = off (global)";
    },
    async input() { return undefined; },
    async confirm() { return false; },
  };
  await runSettingsForm(ui2, d);
  assert.equal(d.globalWrites.length, 0);
  assert.deepEqual(d.emitted.map((e) => outText(e)), ["settings: memoryForget unchanged (cancelled)"]);
  void ui;
});
