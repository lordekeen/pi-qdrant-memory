import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PROJECT_OVERRIDABLE_FIELDS,
  clearProjectField,
  isProjectOverridable,
  loadProjectSettings,
  projectSettingsPath,
  projectsDir,
  readEffectiveConfig,
  saveProjectSettings,
  takeLoadWarnings,
} from "../src/project-settings.ts";
import type { ProjectSettings } from "../src/project-settings.ts";
import { DEFAULTS, configPath, writeConfigFile } from "../src/config.ts";
import type { Config } from "../src/types.ts";

/** A literal id in the shape projectIdFrom/projectIdFromPath emit. */
const ID = "pi-mem-0123456789abcdef";

function tempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-qm-proj-"));
}

/** Simulate a hand-edited store file (bypassing the writer's validation). */
function writeStore(dir: string, value: object): void {
  writeStoreRaw(dir, JSON.stringify(value));
}

function writeStoreRaw(dir: string, raw: string): void {
  const file = projectSettingsPath(dir, ID);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, raw, "utf8");
}

/** Write a full global Config from DEFAULTS + the given overrides. */
function setGlobal(dir: string, overrides: Partial<Config>): void {
  writeConfigFile(dir, { ...DEFAULTS, ...overrides });
}

test("the allowlist is exactly codeKnowledge + codeScoreThreshold", () => {
  assert.deepEqual([...PROJECT_OVERRIDABLE_FIELDS], ["codeKnowledge", "codeScoreThreshold"]);
  assert.equal(isProjectOverridable("codeKnowledge"), true);
  assert.equal(isProjectOverridable("codeScoreThreshold"), true);
  assert.equal(isProjectOverridable("scoreThreshold"), false);
  assert.equal(isProjectOverridable("qdrantUrl"), false);
});

test("round-trip: one key, then a sibling is a read-modify-write, not a clobber", () => {
  const dir = tempAgentDir();
  try {
    saveProjectSettings(dir, ID, { codeKnowledge: "on" });
    assert.deepEqual(loadProjectSettings(dir, ID), { codeKnowledge: "on" });

    saveProjectSettings(dir, ID, { codeScoreThreshold: 0.6 });
    const both = loadProjectSettings(dir, ID);
    assert.deepEqual(both, { codeKnowledge: "on", codeScoreThreshold: 0.6 });
    assert.equal(typeof both.codeScoreThreshold, "number");
    assert.equal(typeof both.codeKnowledge, "string");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the store file is 0600 on creation and tightened after a loosened rewrite", () => {
  const dir = tempAgentDir();
  try {
    saveProjectSettings(dir, ID, { codeKnowledge: "on" });
    const file = projectSettingsPath(dir, ID);
    assert.equal(statSync(file).mode & 0o777, 0o600);

    chmodSync(file, 0o644);
    saveProjectSettings(dir, ID, { codeScoreThreshold: 0.6 });
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a bare agent dir accepts a write and creates the nested projects/ path", () => {
  const dir = tempAgentDir();
  try {
    assert.equal(existsSync(projectsDir(dir)), false);
    saveProjectSettings(dir, ID, { codeKnowledge: "on" });
    assert.equal(existsSync(projectSettingsPath(dir, ID)), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("clear removes one key and keeps the sibling; clearing the last deletes the file", () => {
  const dir = tempAgentDir();
  try {
    saveProjectSettings(dir, ID, { codeKnowledge: "on", codeScoreThreshold: 0.6 });
    clearProjectField(dir, ID, "codeKnowledge");
    assert.deepEqual(loadProjectSettings(dir, ID), { codeScoreThreshold: 0.6 });
    assert.equal(existsSync(projectSettingsPath(dir, ID)), true);

    clearProjectField(dir, ID, "codeScoreThreshold");
    assert.deepEqual(loadProjectSettings(dir, ID), {});
    assert.equal(existsSync(projectSettingsPath(dir, ID)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("clearing an absent key is a no-op and never creates a file", () => {
  const dir = tempAgentDir();
  try {
    clearProjectField(dir, ID, "codeKnowledge");
    assert.equal(existsSync(projectSettingsPath(dir, ID)), false);

    saveProjectSettings(dir, ID, { codeKnowledge: "on" });
    clearProjectField(dir, ID, "codeScoreThreshold");
    assert.deepEqual(loadProjectSettings(dir, ID), { codeKnowledge: "on" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("corrupt or non-object store content reads as an empty override set", () => {
  const dir = tempAgentDir();
  try {
    const file = projectSettingsPath(dir, ID);
    mkdirSync(dirname(file), { recursive: true });
    for (const raw of ["{ not json", "[]", '"x"', "null", "42", '"on"']) {
      writeFileSync(file, raw, "utf8");
      assert.deepEqual(loadProjectSettings(dir, ID), {});
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unknown and non-allowlisted keys are ignored on read", () => {
  const dir = tempAgentDir();
  try {
    writeStore(dir, { qdrantUrl: "http://evil", mode: "own", mystery: 1, codeKnowledge: "on" });
    assert.deepEqual(loadProjectSettings(dir, ID), { codeKnowledge: "on" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid numeric overrides are dropped per key while a valid sibling survives", () => {
  const dir = tempAgentDir();
  try {
    for (const bad of [2.0, "abc", null, false]) {
      writeStore(dir, { codeKnowledge: "on", codeScoreThreshold: bad });
      assert.deepEqual(loadProjectSettings(dir, ID), { codeKnowledge: "on" });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid enum overrides are dropped per key while a valid sibling survives", () => {
  const dir = tempAgentDir();
  try {
    for (const bad of ["maybe", null, false, 1]) {
      writeStore(dir, { codeKnowledge: bad, codeScoreThreshold: 0.6 });
      assert.deepEqual(loadProjectSettings(dir, ID), { codeScoreThreshold: 0.6 });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a string-encoded numeric override normalizes to a JS number", () => {
  const dir = tempAgentDir();
  try {
    writeStore(dir, { codeScoreThreshold: "0.6" });
    const loaded = loadProjectSettings(dir, ID);
    assert.equal(loaded.codeScoreThreshold, 0.6);
    assert.equal(typeof loaded.codeScoreThreshold, "number");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the filename-shape guard rejects ids outside pi-mem-<16hex>", () => {
  const dir = tempAgentDir();
  try {
    assert.deepEqual(loadProjectSettings(dir, "nope"), {});
    assert.deepEqual(loadProjectSettings(dir, "pi-mem-abc"), {});
    assert.deepEqual(loadProjectSettings(dir, "pi-mem-0123456789ABCDEF"), {});
    assert.throws(
      () => saveProjectSettings(dir, "nope", { codeKnowledge: "on" }),
      /outside the generated shape/,
    );
    assert.equal(existsSync(projectsDir(dir)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the writer refuses non-allowlisted keys", () => {
  const dir = tempAgentDir();
  try {
    assert.throws(
      () => saveProjectSettings(dir, ID, { qdrantUrl: "http://evil" } as unknown as ProjectSettings),
      /not project-overridable/,
    );
    assert.throws(
      () => saveProjectSettings(dir, ID, { mode: "own" } as unknown as ProjectSettings),
      /allowlist: codeKnowledge, codeScoreThreshold/,
    );
    assert.equal(existsSync(projectSettingsPath(dir, ID)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a directory sitting where the store file should be reads as an empty override set", () => {
  const dir = tempAgentDir();
  try {
    mkdirSync(projectSettingsPath(dir, ID), { recursive: true });
    assert.deepEqual(loadProjectSettings(dir, ID), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("precedence §7.1: codeKnowledge across global file, project store and env (rows 1-9)", () => {
  interface Row {
    n: number;
    global?: Partial<Config>;
    storeRaw?: string;
    env?: NodeJS.ProcessEnv;
    expect: "on" | "off";
    storeLoaded?: ProjectSettings;
    qdrantUrlDefault?: boolean;
  }
  const rows: Row[] = [
    { n: 1, expect: "off", storeLoaded: {} },
    { n: 2, global: { codeKnowledge: "on" }, expect: "on" },
    { n: 3, global: { codeKnowledge: "on" }, storeRaw: JSON.stringify({ codeKnowledge: "off" }), expect: "off", storeLoaded: { codeKnowledge: "off" } },
    { n: 4, global: { codeKnowledge: "off" }, storeRaw: JSON.stringify({ codeKnowledge: "on" }), expect: "on", storeLoaded: { codeKnowledge: "on" } },
    { n: 5, global: { codeKnowledge: "off" }, storeRaw: JSON.stringify({ codeKnowledge: "on" }), env: { PI_QDRANT_CODE_KNOWLEDGE: "off" }, expect: "off" },
    { n: 6, global: { codeKnowledge: "on" }, storeRaw: JSON.stringify({ codeKnowledge: "off" }), env: { PI_QDRANT_CODE_KNOWLEDGE: "on" }, expect: "on" },
    { n: 7, global: { codeKnowledge: "on" }, storeRaw: JSON.stringify({ qdrantUrl: "http://evil" }), expect: "on", storeLoaded: {}, qdrantUrlDefault: true },
    { n: 8, global: { codeKnowledge: "on" }, storeRaw: "{ not json", expect: "on", storeLoaded: {} },
    { n: 9, global: { codeKnowledge: "on" }, storeRaw: JSON.stringify({ codeKnowledge: "maybe" }), expect: "on", storeLoaded: {} },
  ];
  for (const row of rows) {
    const dir = tempAgentDir();
    const label = `codeKnowledge row ${row.n}`;
    try {
      if (row.global) setGlobal(dir, row.global);
      if (row.storeRaw !== undefined) writeStoreRaw(dir, row.storeRaw);
      const cfg = readEffectiveConfig(dir, ID, row.env ?? {});
      assert.equal(cfg.codeKnowledge, row.expect, label);
      if (row.qdrantUrlDefault) assert.equal(cfg.qdrantUrl, DEFAULTS.qdrantUrl, `${label}: non-allowlisted key ignored`);
      if (row.storeLoaded) assert.deepEqual(loadProjectSettings(dir, ID), row.storeLoaded, `${label}: store view`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("precedence §7.1: codeScoreThreshold across global file, project store and env (rows 1-12)", () => {
  interface Row {
    n: number;
    global?: Partial<Config>;
    store?: ProjectSettings;
    storeRaw?: string;
    env?: NodeJS.ProcessEnv;
    expect: number;
    storeLoaded?: ProjectSettings;
    qdrantUrlDefault?: boolean;
  }
  const rows: Row[] = [
    { n: 1, expect: 0.55 },
    { n: 2, global: { codeScoreThreshold: 0.5 }, expect: 0.5 },
    { n: 3, global: { codeScoreThreshold: 0.55 }, store: { codeScoreThreshold: 0.6 }, expect: 0.6 },
    { n: 4, global: { codeScoreThreshold: 0.9 }, store: { codeScoreThreshold: 0.3 }, expect: 0.3 },
    { n: 5, global: { codeScoreThreshold: 0.55 }, store: { codeScoreThreshold: 0.6 }, env: { PI_QDRANT_CODE_SCORE_THRESHOLD: "0.4" }, expect: 0.4 },
    { n: 6, store: { codeScoreThreshold: 0.3 }, expect: 0.3 },
    { n: 7, global: { codeScoreThreshold: 0.55 }, storeRaw: JSON.stringify({ codeScoreThreshold: 2.0 }), expect: 0.55, storeLoaded: {} },
    { n: 8, global: { codeScoreThreshold: 0.55 }, storeRaw: JSON.stringify({ codeScoreThreshold: "abc" }), expect: 0.55, storeLoaded: {} },
    { n: 9, global: { codeScoreThreshold: 0.55 }, storeRaw: JSON.stringify({ codeScoreThreshold: null }), expect: 0.55, storeLoaded: {} },
    { n: 10, global: { codeScoreThreshold: 0.55 }, storeRaw: JSON.stringify({ codeScoreThreshold: "0.6" }), expect: 0.6, storeLoaded: { codeScoreThreshold: 0.6 } },
    { n: 11, global: { codeScoreThreshold: 0.55 }, storeRaw: JSON.stringify({ codeScoreThreshold: 0.6, qdrantUrl: "http://evil" }), expect: 0.6, storeLoaded: { codeScoreThreshold: 0.6 }, qdrantUrlDefault: true },
    // The matrix implies this row but does not list it: an invalid env value
    // falls through in `readGlobalConfig`, so it must not mask the override.
    { n: 12, global: { codeScoreThreshold: 0.55 }, storeRaw: JSON.stringify({ codeScoreThreshold: 0.3 }), env: { PI_QDRANT_CODE_SCORE_THRESHOLD: "abc" }, expect: 0.3 },
  ];
  for (const row of rows) {
    const dir = tempAgentDir();
    const label = `codeScoreThreshold row ${row.n}`;
    try {
      if (row.global) setGlobal(dir, row.global);
      if (row.store) saveProjectSettings(dir, ID, row.store);
      if (row.storeRaw !== undefined) writeStoreRaw(dir, row.storeRaw);
      const cfg = readEffectiveConfig(dir, ID, row.env ?? {});
      assert.equal(cfg.codeScoreThreshold, row.expect, label);
      assert.equal(typeof cfg.codeScoreThreshold, "number", `${label}: JS number`);
      if (row.qdrantUrlDefault) assert.equal(cfg.qdrantUrl, DEFAULTS.qdrantUrl, `${label}: non-allowlisted key ignored`);
      if (row.storeLoaded) assert.deepEqual(loadProjectSettings(dir, ID), row.storeLoaded, `${label}: store view`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

// ── Atomic writes + corrupt-file reporting (#57) ────────────────────────────

test("the project store is written temp-then-rename, leaving no .tmp (#57)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-store-"));
  try {
    // A stale temp from an earlier crash must not survive the next write.
    const file = projectSettingsPath(dir, ID);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, "{ half-written", "utf8");

    saveProjectSettings(dir, ID, { codeKnowledge: "on", codeScoreThreshold: 0.42 });

    const onDisk = JSON.parse(readFileSync(file, "utf8")) as ProjectSettings;
    assert.deepEqual(onDisk, { codeKnowledge: "on", codeScoreThreshold: 0.42 });
    assert.deepEqual(loadProjectSettings(dir, ID), { codeKnowledge: "on", codeScoreThreshold: 0.42 });
    assert.deepEqual(readdirSync(dirname(file)).filter((f) => f.endsWith(".tmp")), []);
    assert.equal(existsSync(`${file}.tmp`), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a corrupt project store warns with its path, exactly once (#57)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-store-"));
  try {
    const file = projectSettingsPath(dir, ID);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{not json", "utf8");
    takeLoadWarnings(); // drain anything earlier queued

    // Safe default preserved...
    assert.deepEqual(loadProjectSettings(dir, ID), {});
    assert.equal(readEffectiveConfig(dir, ID, {}).codeKnowledge, DEFAULTS.codeKnowledge);
    // ...and the path reported, once.
    assert.deepEqual(takeLoadWarnings(), [file]);
    assert.deepEqual(loadProjectSettings(dir, ID), {});
    assert.deepEqual(takeLoadWarnings(), [], "reported once per process");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an absent project store produces no warning (#57)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-store-"));
  try {
    takeLoadWarnings(); // drain
    assert.deepEqual(loadProjectSettings(dir, ID), {});
    assert.deepEqual(takeLoadWarnings(), [], "first run in a project must be silent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
