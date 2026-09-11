import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULTS, configPath, loadConfig, readGlobalConfig, setConfigField } from "../src/config.ts";
import { saveProjectSettings } from "../src/project-settings.ts";
import type { Config } from "../src/types.ts";

function tempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-qm-cfg-"));
}

function writeConfigFile(agentDir: string, partial: object): void {
  const file = configPath(agentDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(partial), "utf8");
}

test("loadConfig returns DEFAULTS when no file and no env", () => {
  const dir = tempAgentDir();
  try {
    const cfg = loadConfig(dir, {});
    assert.deepEqual(cfg, DEFAULTS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("configPath nests under agent dir", () => {
  assert.equal(configPath("/tmp/agent"), "/tmp/agent/pi-qdrant-memory/pi-qdrant-memory-config.json");
});

test("loadConfig reads JSON file values", () => {
  const dir = tempAgentDir();
  try {
    writeConfigFile(dir, { scoreThreshold: 0.2, maxResults: 25 });
    const cfg = loadConfig(dir, {});
    assert.equal(cfg.scoreThreshold, 0.2);
    assert.equal(cfg.maxResults, 25);
    assert.equal(cfg.qdrantUrl, DEFAULTS.qdrantUrl); // untouched key keeps default
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("env overrides win over file and defaults", () => {
  const dir = tempAgentDir();
  try {
    writeConfigFile(dir, { scoreThreshold: 0.2 });
    const cfg = loadConfig(dir, { PI_QDRANT_URL: "http://qdrant.example:6333", PI_QDRANT_MODE: "own" });
    assert.equal(cfg.qdrantUrl, "http://qdrant.example:6333");
    assert.equal(cfg.mode, "own");
    assert.equal(cfg.scoreThreshold, 0.2); // file value preserved where no env
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid mode value in env falls back to auto", () => {
  const dir = tempAgentDir();
  try {
    const cfg = loadConfig(dir, { PI_QDRANT_MODE: "bogus" });
    assert.equal(cfg.mode, "auto");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("numeric env overrides parse to numbers", () => {
  const dir = tempAgentDir();
  try {
    const cfg = loadConfig(dir, { PI_QDRANT_EXPECTED_DIMENSION: "384", PI_QDRANT_SCORE_THRESHOLD: "0.1", PI_QDRANT_MAX_RESULTS: "5" });
    assert.equal(cfg.expectedDimension, 384);
    assert.equal(cfg.scoreThreshold, 0.1);
    assert.equal(cfg.maxResults, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("numeric file values are coerced and corrupt values fall back to defaults", () => {
  const dir = tempAgentDir();
  try {
    // String-typed numerics in the JSON file (hand-edited or from another client)
    // must be coerced, and junk must fall back to defaults rather than leak through.
    writeConfigFile(dir, { expectedDimension: "768", scoreThreshold: "bogus", maxResults: 25 });
    const cfg = loadConfig(dir, {});
    assert.equal(cfg.expectedDimension, 768);
    assert.equal(cfg.scoreThreshold, DEFAULTS.scoreThreshold);
    assert.equal(cfg.maxResults, 25);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("setConfigField rejects null for non-nullable string fields", () => {
  const cfg: Config = { ...DEFAULTS };
  const applied = setConfigField(cfg, "qdrantUrl", "null");
  assert.equal(applied.ok, false);
  if (!applied.ok) assert.match(applied.error, /cannot be null/);
  const key = setConfigField(cfg, "qdrantApiKey", "null");
  assert.equal(key.ok, true); // the API-key fields are the nullable ones
  const model = setConfigField(cfg, "embeddingModel", "null");
  assert.equal(model.ok, false);
});

test("setConfigField enforces numeric ranges and integrality", () => {
  const cfg: Config = { ...DEFAULTS };
  assert.equal(setConfigField(cfg, "scoreThreshold", "-0.1").ok, false);
  assert.equal(setConfigField(cfg, "scoreThreshold", "1.5").ok, false);
  assert.equal(setConfigField(cfg, "scoreThreshold", "0.25").ok, true);
  assert.equal(setConfigField(cfg, "expectedDimension", "768.5").ok, false);
  assert.equal(setConfigField(cfg, "expectedDimension", "0").ok, false);
  assert.equal(setConfigField(cfg, "maxResults", "3.5").ok, false);
  assert.equal(setConfigField(cfg, "maxResults", "3").ok, true);
});

test("codeKnowledge and codeScoreThreshold: defaults, env, and validation", () => {
  const dir = tempAgentDir();
  try {
    const cfg = loadConfig(dir, {});
    assert.equal(cfg.codeKnowledge, "off");
    assert.equal(cfg.codeScoreThreshold, 0.55);

    const env = loadConfig(dir, { PI_QDRANT_CODE_KNOWLEDGE: "on", PI_QDRANT_CODE_SCORE_THRESHOLD: "0.55" });
    assert.equal(env.codeKnowledge, "on");
    assert.equal(env.codeScoreThreshold, 0.55);

    const file = loadConfig(dir, {});
    assert.equal(file.codeKnowledge, "off"); // env absent → default, not file bleed

    const base: Config = { ...DEFAULTS };
    assert.equal(setConfigField(base, "codeKnowledge", "maybe").ok, false);
    const on = setConfigField(base, "codeKnowledge", "on");
    assert.equal(on.ok, true);
    if (on.ok) assert.equal(on.next.codeKnowledge, "on");
    assert.equal(setConfigField(base, "codeScoreThreshold", "-0.1").ok, false);
    assert.equal(setConfigField(base, "codeScoreThreshold", "1.5").ok, false);
    const thr = setConfigField(base, "codeScoreThreshold", "0.3");
    assert.equal(thr.ok, true);
    if (thr.ok) assert.equal(thr.next.codeScoreThreshold, 0.3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadConfig is the historical alias of readGlobalConfig", () => {
  assert.equal(loadConfig, readGlobalConfig);
});

test("readGlobalConfig never consults the project store (global-layer purity)", () => {
  const dir = tempAgentDir();
  try {
    // A store holding an override must be invisible to the global reader: it is
    // the D10 persist side (the global file must never be written from an
    // effective config), so it may not read the project layer either.
    saveProjectSettings(dir, "pi-mem-0123456789abcdef", { codeKnowledge: "on", codeScoreThreshold: 0.6 });
    const cfg = readGlobalConfig(dir, {});
    assert.equal(cfg.codeKnowledge, DEFAULTS.codeKnowledge);
    assert.equal(cfg.codeScoreThreshold, DEFAULTS.codeScoreThreshold);
    assert.deepEqual(cfg, DEFAULTS);
    assert.equal(loadConfig(dir, {}).codeKnowledge, "off");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Shipped template drift guard (plan §7.6 / D11) ───────────────────────────

test("shipped template is a full Config deep-equal to DEFAULTS", () => {
  const parsed = JSON.parse(
    readFileSync(new URL("../pi-qdrant-memory-config.example.json", import.meta.url), "utf8"),
  ) as Config;
  assert.deepEqual(parsed, DEFAULTS);
  assert.equal(parsed.codeKnowledge, "off");
  assert.equal(typeof parsed.codeScoreThreshold, "number");
});

test("the shipped template is listed in package.json files", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { files: string[] };
  assert.ok(pkg.files.includes("pi-qdrant-memory-config.example.json"));
});

test("no runtime path reads the shipped template", () => {
  // The spec's fs-read counter is not implementable without an fs injection
  // seam, so this source sweep is the honest equivalent: no src/ module may
  // name the template, so it cannot be read at runtime — it is documentation.
  const srcDir = new URL("../src/", import.meta.url);
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith(".ts")) continue;
    const text = readFileSync(new URL(name, srcDir), "utf8");
    assert.ok(!text.includes("config.example.json"), `${name} must not reference the shipped template`);
  }
});
