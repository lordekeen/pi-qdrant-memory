import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySettingWrite } from "../src/settings-write.ts";
import type { SettingsWriteDeps } from "../src/settings-write.ts";
import { DEFAULTS, configPath, readGlobalConfig, writeConfigFile } from "../src/config.ts";
import {
  PROJECT_OVERRIDABLE_FIELDS,
  clearProjectField,
  loadProjectSettings,
  projectSettingsPath,
  readEffectiveConfig,
  saveProjectSettings,
} from "../src/project-settings.ts";
import { outText } from "../src/out.ts";
import type { OutEntry } from "../src/out.ts";
import type { ProjectOverridableField, ProjectSettings } from "../src/project-settings.ts";
import type { Config } from "../src/types.ts";

/** The generated project-id shape (`src/project.ts`). */
const PROJECT_ID = "pi-mem-0123456789abcdef";

/**
 * A harness over the REAL stores: a temp-dir global config file (written and
 * re-read through `config.ts`) and the real project store (`saveProjectSettings`
 * / `clearProjectField` really add and remove). No call-shape recording — the
 * assertions read the persisted state back.
 *
 * `cfg` is a getter that re-resolves the effective config on every read,
 * modelling what `depsToIO` does (both writers call `reloadEffectiveConfig`
 * synchronously), so the before/after `codeKnowledge` comparison in the module
 * sees the reload exactly as production does.
 */
function harness(opts: {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  global?: Partial<Config>;
  store?: ProjectSettings;
} = {}) {
  const agentDir = opts.agentDir ?? mkdtempSync(join(tmpdir(), "pi-qm-sw-"));
  const env = opts.env ?? {};
  if (opts.global) writeConfigFile(agentDir, { ...DEFAULTS, ...opts.global });
  if (opts.store) saveProjectSettings(agentDir, PROJECT_ID, opts.store);
  const emitted: OutEntry[] = [];
  const deps: SettingsWriteDeps = {
    emit: (e) => { emitted.push(e); },
    get cfg() { return readEffectiveConfig(agentDir, PROJECT_ID, env); },
    env,
    agentDir,
    readGlobalConfig: () => readGlobalConfig(agentDir, env),
    writeGlobalConfig: (c) => { writeConfigFile(agentDir, c); },
    writeProjectSettings: (p) => { saveProjectSettings(agentDir, PROJECT_ID, p); },
    clearProjectSetting: (f) => { clearProjectField(agentDir, PROJECT_ID, f); },
  };
  return {
    agentDir,
    deps,
    emitted,
    cfg: (): Config => readEffectiveConfig(agentDir, PROJECT_ID, env),
    store: (): ProjectSettings => loadProjectSettings(agentDir, PROJECT_ID),
    global: (): Config => readGlobalConfig(agentDir, env),
    globalFile: (): Config => JSON.parse(readFileSync(configPath(agentDir), "utf8")) as Config,
    texts: (): string[] => emitted.map((e) => outText(e)),
    apply: (field: string, raw: string) => applySettingWrite(deps, field, raw),
    cleanup: () => { rmSync(agentDir, { recursive: true, force: true }); },
  };
}

/** Temp agent dir with an operational pi-blackhole config (#50). */
function blackholeAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-sw-bh-"));
  mkdirSync(join(dir, "pi-blackhole"), { recursive: true });
  writeFileSync(join(dir, "pi-blackhole", "pi-blackhole-config.json"), JSON.stringify({ enabled: true }));
  return dir;
}

test("project update: the allowlisted value lands in the project store, never the global file", () => {
  const h = harness();
  try {
    assert.deepEqual(h.apply("codeKnowledge", "on"), { ok: true });
    assert.deepEqual(h.store(), { codeKnowledge: "on" });
    assert.equal(h.global().codeKnowledge, "off");
    assert.equal(existsSync(configPath(h.agentDir)), false, "no global file is created");
    // Reload notice follows the effective flip off → on.
    assert.deepEqual(h.texts(), [
      "settings: codeKnowledge = on (this project; global: off)",
      "code memory: takes effect at the next session start — the code_memory tool registers on reload. Run /qdrant index code to index the current session's code right away.",
    ]);
    assert.equal(h.emitted[0].kind, "message");
  } finally { h.cleanup(); }
});

test("allowlisted numeric update stores a JSON number and names both values", () => {
  const h = harness();
  try {
    assert.deepEqual(h.apply("codeScoreThreshold", "0.6"), { ok: true });
    assert.equal(typeof h.store().codeScoreThreshold, "number");
    assert.deepEqual(h.store(), { codeScoreThreshold: 0.6 });
    // The project store file really holds a JSON number (never a string).
    const onDisk = JSON.parse(readFileSync(projectSettingsPath(h.agentDir, PROJECT_ID), "utf8")) as { codeScoreThreshold?: unknown };
    assert.equal(onDisk.codeScoreThreshold, 0.6);
    assert.deepEqual(h.texts(), ["settings: codeScoreThreshold = 0.6 (this project; global: 0.55)"]);
  } finally { h.cleanup(); }
});

test("`default` clears the project override and confirms the global value", () => {
  const h = harness({ store: { codeKnowledge: "on" } });
  try {
    assert.deepEqual(h.apply("codeKnowledge", "default"), { ok: true });
    assert.deepEqual(h.store(), {}, "the override is really gone");
    assert.equal(existsSync(projectSettingsPath(h.agentDir, PROJECT_ID)), false, "an emptied store file is removed");
    assert.deepEqual(h.texts(), [
      "settings: codeKnowledge override cleared (now using global: off)",
      "code memory: turns off at the next session start — the code_memory tool unregisters on reload.",
    ]);
  } finally { h.cleanup(); }
});

test("`default` is idempotent: a no-op clear still confirms and emits no notice", () => {
  const h = harness(); // no override at all
  try {
    assert.deepEqual(h.apply("codeKnowledge", "default"), { ok: true });
    assert.deepEqual(h.store(), {});
    assert.deepEqual(h.texts(), ["settings: codeKnowledge override cleared (now using global: off)"]);
  } finally { h.cleanup(); }
});

test("`default` is matched before validation, even for a numeric allowlisted field", () => {
  const h = harness({ store: { codeScoreThreshold: 0.6 } });
  try {
    assert.deepEqual(h.apply("codeScoreThreshold", "default"), { ok: true });
    assert.deepEqual(h.store(), {});
    assert.deepEqual(h.texts(), ["settings: codeScoreThreshold override cleared (now using global: 0.55)"]);
  } finally { h.cleanup(); }
});

test("non-allowlisted update persists to the global file and leaves the store alone", () => {
  const h = harness();
  try {
    assert.deepEqual(h.apply("mode", "blackhole"), { ok: true });
    assert.equal(h.global().mode, "blackhole");
    assert.equal(h.globalFile().mode, "blackhole");
    assert.deepEqual(h.store(), {});
    assert.deepEqual(h.texts(), ["settings: mode updated (global config; reloaded at runtime)"]);
  } finally { h.cleanup(); }
});

test("`default` stays an ordinary value for a non-allowlisted field", () => {
  const h = harness();
  try {
    assert.deepEqual(h.apply("embeddingApiKey", "default"), { ok: true });
    assert.equal(h.global().embeddingApiKey, "default", "only allowlisted fields reserve the token");
    assert.deepEqual(h.texts(), ["settings: embeddingApiKey updated (global config; reloaded at runtime)"]);
  } finally { h.cleanup(); }
});

test("mode=own with an operational pi-blackhole emits the conflict warning; without one it does not", () => {
  const dir = blackholeAgentDir();
  const h = harness({ agentDir: dir });
  try {
    assert.deepEqual(h.apply("mode", "own"), { ok: true });
    assert.equal(h.global().mode, "own");
    assert.equal(h.texts().length, 2);
    assert.equal(h.texts()[0], "settings: mode updated (global config; reloaded at runtime)");
    assert.match(h.texts()[1]!, /^warning: mode = own while pi-blackhole is installed/);
  } finally { h.cleanup(); }

  const plain = harness();
  try {
    plain.apply("mode", "own");
    assert.deepEqual(plain.texts(), ["settings: mode updated (global config; reloaded at runtime)"]);
  } finally { plain.cleanup(); }
});

test("an invalid value emits the shared error row, writes nothing and reports ok: false", () => {
  const h = harness();
  try {
    assert.deepEqual(h.apply("mode", "bogus"), { ok: false });
    assert.deepEqual(h.texts(), ["error: settings: mode must be one of auto | blackhole | own"]);
    assert.equal(existsSync(configPath(h.agentDir)), false, "a rejected write never creates the file");
  } finally { h.cleanup(); }

  const overridable = harness({ store: { codeKnowledge: "on" } });
  try {
    assert.deepEqual(overridable.apply("codeKnowledge", "maybe"), { ok: false });
    assert.deepEqual(overridable.store(), { codeKnowledge: "on" }, "the store is untouched");
    assert.deepEqual(overridable.texts(), ["error: settings: codeKnowledge must be one of off | on"]);
  } finally { overridable.cleanup(); }

  const unknown = harness();
  try {
    assert.deepEqual(unknown.apply("zzz", "1"), { ok: false });
    assert.deepEqual(unknown.texts(), ["error: settings: unknown key zzz"]);
  } finally { unknown.cleanup(); }
});

test("an empty secret is normalised to null and persisted", () => {
  const h = harness({ global: { qdrantApiKey: "old-key" } });
  try {
    assert.deepEqual(h.apply("qdrantApiKey", ""), { ok: true });
    assert.equal(h.global().qdrantApiKey, null);
    assert.equal(h.globalFile().qdrantApiKey, null, "the file holds null, never an empty string");
    assert.deepEqual(h.texts(), ["settings: qdrantApiKey updated (global config; reloaded at runtime)"]);
  } finally { h.cleanup(); }
});

test("the reload notice follows the EFFECTIVE codeKnowledge change, not the write", () => {
  const h = harness();
  try {
    h.apply("codeKnowledge", "on");
    assert.deepEqual(h.texts()[1], "code memory: takes effect at the next session start — the code_memory tool registers on reload. Run /qdrant index code to index the current session's code right away.");
    // Repeating the same write leaves the effective value on: confirmation only.
    h.apply("codeKnowledge", "on");
    assert.deepEqual(h.texts().slice(2), ["settings: codeKnowledge = on (this project; global: off)"]);
  } finally { h.cleanup(); }

  // Direction-aware: an on → off effective flip says "unregisters".
  const off = harness({ global: { codeKnowledge: "on" } });
  try {
    off.apply("codeKnowledge", "off");
    assert.deepEqual(off.texts(), [
      "settings: codeKnowledge = off (this project; global: on)",
      "code memory: turns off at the next session start — the code_memory tool unregisters on reload.",
    ]);
  } finally { off.cleanup(); }

  // An unrelated write never touches codeKnowledge: no notice at all.
  const other = harness();
  try {
    other.apply("scoreThreshold", "0.2");
    assert.deepEqual(other.texts(), ["settings: scoreThreshold updated (global config; reloaded at runtime)"]);
  } finally { other.cleanup(); }
});

test("a masked project write confirms with the mask note and emits no notice", () => {
  const h = harness({ env: { PI_QDRANT_CODE_KNOWLEDGE: "off" } });
  try {
    assert.deepEqual(h.apply("codeKnowledge", "on"), { ok: true });
    assert.deepEqual(h.store(), { codeKnowledge: "on" }, "the override IS stored…");
    assert.equal(h.cfg().codeKnowledge, "off", "…but the env pin keeps the effective value unchanged");
    assert.deepEqual(h.texts(), [
      "settings: codeKnowledge = on (this project; global: off) — NOTE: currently masked by PI_QDRANT_CODE_KNOWLEDGE=off",
    ]);
  } finally { h.cleanup(); }

  // The clear path carries the same mask note — and no notice, because the env
  // pin keeps the effective value unchanged.
  const clear = harness({ env: { PI_QDRANT_CODE_KNOWLEDGE: "on" }, store: { codeKnowledge: "off" } });
  try {
    assert.deepEqual(clear.apply("codeKnowledge", "default"), { ok: true });
    assert.deepEqual(clear.store(), {});
    assert.deepEqual(clear.texts(), [
      "settings: codeKnowledge override cleared (now using global: on) — NOTE: currently masked by PI_QDRANT_CODE_KNOWLEDGE=on",
    ]);
  } finally { clear.cleanup(); }
});

test("#64: every allowlisted field round-trips under its own key, with its own value", () => {
  // Compile-time guard for the allowlist: a third `overridable(...)` row makes
  // this table fail to build until its write case is added. The pre-#64 builder
  // hardcoded `codeKnowledge` vs `codeScoreThreshold`, so a third field would
  // have persisted its value under `codeScoreThreshold` while still
  // type-checking — corrupting the store and the effective config.
  const writeCase: Record<ProjectOverridableField, { raw: string; stored: string | number }> = {
    codeKnowledge: { raw: "on", stored: "on" },
    codeScoreThreshold: { raw: "0.6", stored: 0.6 },
  };
  assert.deepEqual(
    [...PROJECT_OVERRIDABLE_FIELDS].sort(),
    (Object.keys(writeCase) as ProjectOverridableField[]).sort(),
    "the write cases cover exactly the live allowlist",
  );

  for (const field of PROJECT_OVERRIDABLE_FIELDS) {
    const h = harness();
    try {
      const { raw, stored } = writeCase[field];
      assert.deepEqual(h.apply(field, raw), { ok: true });
      // Exactly one key — the field's own — carrying the field's own value.
      assert.deepEqual(h.store(), { [field]: stored });
      // Output stability (#65): the confirmation still prints both values
      // through the identity display path for every non-secret allowlisted
      // field, byte-identical to the pre-consolidation wording.
      assert.equal(
        h.texts()[0],
        `settings: ${field} = ${String(stored)} (this project; global: ${String(DEFAULTS[field])})`,
      );
    } finally { h.cleanup(); }
  }
});

test("D10: a global write persists the global layer and never touches the project override", () => {
  // Global says on, the project override says off → the effective value is off.
  const h = harness({ global: { codeKnowledge: "on" }, store: { codeKnowledge: "off" } });
  try {
    assert.deepEqual(h.apply("scoreThreshold", "0.2"), { ok: true });
    assert.equal(h.globalFile().scoreThreshold, 0.2);
    assert.equal(h.globalFile().codeKnowledge, "on", "the GLOBAL reader's value is persisted, never the override");
    assert.deepEqual(h.store(), { codeKnowledge: "off" }, "the project override is neither materialized nor dropped");
    assert.equal(h.cfg().codeKnowledge, "off", "the effective view still applies the override");
    assert.deepEqual(h.texts(), ["settings: scoreThreshold updated (global config; reloaded at runtime)"]);
  } finally { h.cleanup(); }
});
