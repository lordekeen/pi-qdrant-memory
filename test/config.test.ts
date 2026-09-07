import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULTS, configPath, loadConfig } from "../src/config.ts";

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
