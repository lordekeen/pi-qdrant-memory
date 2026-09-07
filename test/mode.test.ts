import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blackholeConfigPath, detectBlackhole, isBlackholeOperational, resolveMode, agentDirFromEnv } from "../src/mode.ts";
import type { Config } from "../src/types.ts";

const base: Config = {
  qdrantUrl: "http://localhost:6333", qdrantApiKey: null,
  embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text",
  embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10,
  mode: "auto",
};

test("blackholeConfigPath nests under pi-blackhole", () => {
  assert.equal(blackholeConfigPath("/a/b"), "/a/b/pi-blackhole/pi-blackhole-config.json");
});

test("detectBlackhole false when file missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-mode-"));
  try { assert.equal(detectBlackhole(dir), false); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectBlackhole true when operational config present", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-mode-"));
  try {
    const p = blackholeConfigPath(dir);
    mkdirSync(join(dir, "pi-blackhole"), { recursive: true });
    writeFileSync(p, JSON.stringify({ compactionEngine: "blackhole" }), "utf8");
    assert.equal(detectBlackhole(dir), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectBlackhole false on corrupt JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-mode-"));
  try {
    const p = blackholeConfigPath(dir);
    mkdirSync(join(dir, "pi-blackhole"), { recursive: true });
    writeFileSync(p, "{not json", "utf8");
    assert.equal(detectBlackhole(dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resolveMode honors explicit blackhole and own overrides", () => {
  assert.equal(resolveMode({ ...base, mode: "blackhole" }, false), "mode1");
  assert.equal(resolveMode({ ...base, mode: "own" }, true), "mode2");
});

test("resolveMode auto follows detection", () => {
  assert.equal(resolveMode({ ...base, mode: "auto" }, true), "mode1");
  assert.equal(resolveMode({ ...base, mode: "auto" }, false), "mode2");
});

test("agentDirFromEnv honors override and defaults to home", () => {
  assert.equal(agentDirFromEnv({ PI_CODING_AGENT_DIR: "/custom/agent" }), "/custom/agent");
  assert.equal(agentDirFromEnv({}).startsWith(process.env.HOME ?? process.env.USERPROFILE ?? ""), true);
});
