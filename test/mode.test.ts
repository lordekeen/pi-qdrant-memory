import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { blackholeConfigPath, detectBlackhole, resolveMode, runtimeModeState, agentDirFromEnv, expandAgentDir, loadHostAgentDir } from "../src/mode.ts";
import type { Config } from "../src/types.ts";

const base: Config = {
  qdrantUrl: "http://localhost:6333", qdrantApiKey: null,
  embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text",
  embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10,
  mode: "auto",
  codeKnowledge: "off",
  codeScoreThreshold: 0.4,
  memoryForget: "off",
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

test("runtimeModeState without a blackhole file: auto → mode2, a forced side still wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-mode-"));
  try {
    assert.deepEqual(runtimeModeState(base, dir), { mode: "mode2", blackholePresent: false });
    assert.equal(runtimeModeState({ ...base, mode: "auto" }, dir).mode, "mode2");
    assert.equal(runtimeModeState({ ...base, mode: "blackhole" }, dir).mode, "mode1");
    assert.equal(runtimeModeState({ ...base, mode: "own" }, dir).mode, "mode2");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runtimeModeState follows an operational blackhole file unless the config forces a side", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-mode-"));
  try {
    mkdirSync(join(dir, "pi-blackhole"), { recursive: true });
    writeFileSync(blackholeConfigPath(dir), JSON.stringify({ enabled: true }), "utf8");
    assert.deepEqual(runtimeModeState(base, dir), { mode: "mode1", blackholePresent: true });
    assert.equal(runtimeModeState({ ...base, mode: "auto" }, dir).mode, "mode1");
    assert.equal(runtimeModeState({ ...base, mode: "own" }, dir).mode, "mode2");
    assert.equal(runtimeModeState({ ...base, mode: "blackhole" }, dir).mode, "mode1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runtimeModeState ignores disabled and unparsable blackhole configs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-mode-"));
  try {
    mkdirSync(join(dir, "pi-blackhole"), { recursive: true });
    writeFileSync(blackholeConfigPath(dir), JSON.stringify({ enabled: false }), "utf8");
    assert.deepEqual(runtimeModeState(base, dir), { mode: "mode2", blackholePresent: false });
    writeFileSync(blackholeConfigPath(dir), "{not json", "utf8");
    assert.deepEqual(runtimeModeState(base, dir), { mode: "mode2", blackholePresent: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runtimeModeState pairs the mode with the one detection it came from (#69)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-mode-"));
  try {
    mkdirSync(join(dir, "pi-blackhole"), { recursive: true });
    writeFileSync(blackholeConfigPath(dir), JSON.stringify({ enabled: true }), "utf8");
    // The #50 contradictory pair: an explicit `own` still resolves to mode2,
    // but the raw flag says pi-blackhole is present. Both facts come from the
    // same detection (one API call), so the conflict check cannot be starved
    // by a second, differently-timed read.
    assert.deepEqual(runtimeModeState({ ...base, mode: "own" }, dir), {
      mode: "mode2",
      blackholePresent: true,
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("agentDirFromEnv honors override and defaults to home", () => {
  assert.equal(agentDirFromEnv({ PI_CODING_AGENT_DIR: "/custom/agent" }), "/custom/agent");
  assert.equal(agentDirFromEnv({}), join(homedir(), ".pi", "agent"));
});

test("agentDirFromEnv expands a leading ~ like the host's getAgentDir (#60)", () => {
  // The host runs PI_CODING_AGENT_DIR through expandTildePath (dist/config.js:450-456).
  // Before this fix the extension kept the literal "~", so pi and the extension
  // read and wrote two different trees.
  assert.equal(agentDirFromEnv({ PI_CODING_AGENT_DIR: "~/.pi/agent-test" }), join(homedir(), ".pi", "agent-test"));
  assert.equal(agentDirFromEnv({ PI_CODING_AGENT_DIR: "~" }), homedir());
  // The value pi actually resolves to, asserted against the same expansion —
  // pin the two together so they cannot drift again.
  assert.equal(agentDirFromEnv({ PI_CODING_AGENT_DIR: "~/.pi/agent-test" }), expandAgentDir("~/.pi/agent-test"));
});

test("agentDirFromEnv leaves a plain absolute path verbatim (#60)", () => {
  for (const p of ["/abs/agent", "/abs/with spaces/agent", "/abs/~tilde-ish/agent", "relative/dir"]) {
    assert.equal(agentDirFromEnv({ PI_CODING_AGENT_DIR: p }), p, `path ${p} must pass through unchanged`);
  }
});

test("tilde expansion never touches the filesystem (#60)", () => {
  // The bug this fixes was an extension mkdirSync creating a literal "~"
  // directory in the cwd. Expansion is pure string work, so asking for a path
  // that does not exist must not create it — nor anything beside it.
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-mode-tilde-"));
  const cwdBefore = readdirSync(process.cwd()).length;
  try {
    const resolved = agentDirFromEnv({ PI_CODING_AGENT_DIR: join("~", "pi-qm-should-never-exist") });
    assert.equal(resolved, join(homedir(), "pi-qm-should-never-exist"));
    assert.equal(existsSync(join(process.cwd(), "~")), false, "no literal ~ directory may be created in cwd");
    assert.equal(readdirSync(process.cwd()).length, cwdBefore, "the working directory must be untouched");
    assert.equal(existsSync(join(homedir(), "pi-qm-should-never-exist")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadHostAgentDir resolves to undefined without the host package, and never throws", async () => {
  // Under plain node the optional peer dependency does not resolve, so the
  // factory must fall back to agentDirFromEnv rather than fail to load.
  assert.equal(await loadHostAgentDir(), undefined);
  // Cached: a second call must not re-attempt the import.
  assert.equal(await loadHostAgentDir(), undefined);
});
