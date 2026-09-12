import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRuntime, writeGlobalConfigAndReload } from "../src/deps.ts";
import { depsToIO } from "../src/handlers.ts";
import { DEFAULTS, configPath, readGlobalConfig, writeConfigFile } from "../src/config.ts";
import { loadProjectSettings, projectSettingsPath, saveProjectSettings } from "../src/project-settings.ts";
import { projectIdFrom } from "../src/project.ts";
import type { QdrantLike } from "../src/qdrant.ts";

const fakeQdrant: QdrantLike = {
  async ensureCollection() { return "exists"; },
  async upsert() {},
  async search() { return []; },
  async count() { return 0; },
  async clearCollection() {},
  async deletePointsByFiles() {},
  async codeIndexSnapshot() { return new Map(); },
  async countBySourceKind() { return 0; },
};

/** Fake clients only: assert on `rt.cfg`, never on the swapped embed/qdrant
 * clients (a reload detaches them). */
function fakeIO(agentDir: string) {
  return {
    readGlobalConfig: () => readGlobalConfig(agentDir, {}),
    writeGlobalConfig: () => {},
    print: () => {},
    qdrant: fakeQdrant,
  };
}

function gitRepo(dir: string, name: string): string {
  const repo = join(dir, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

test("makeRuntime resolves mode2 and project id when no blackhole", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-deps-"));
  mkdirSync(join(dir, "repo"), { recursive: true });
  mkdirSync(join(dir, "repo", ".git"));
  try {
    const rt = await makeRuntime(dir, join(dir, "repo"), {}, {
      readGlobalConfig: () => ({ qdrantUrl: "http://localhost:6333", qdrantApiKey: null, embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text", embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10, mode: "auto", codeKnowledge: "off", codeScoreThreshold: 0.4 }),
      writeGlobalConfig: () => {},
      print: () => {},
      qdrant: fakeQdrant,
    });
    assert.ok(rt.projectId.startsWith("pi-mem-"));
    assert.equal(rt.cfg.qdrantUrl, "http://localhost:6333");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("configPath helper used by makeRuntime", () => {
  assert.match(configPath("/a"), /pi-qdrant-memory\/pi-qdrant-memory-config\.json$/);
});

test("makeRuntime resolves the project before the effective config (assembly order)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-deps-"));
  try {
    const repo = gitRepo(dir, "repo");
    const id = await projectIdFrom(repo);
    writeConfigFile(dir, { ...DEFAULTS, codeKnowledge: "on" }); // global says on
    saveProjectSettings(dir, id, { codeKnowledge: "off" });      // store says off
    const rt = await makeRuntime(dir, repo, {}, fakeIO(dir));
    // The store was consulted for the *resolved* project id.
    assert.equal(rt.cfg.codeKnowledge, "off");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("makeRuntime with no project store matches readGlobalConfig (no regression)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-deps-"));
  try {
    const repo = gitRepo(dir, "repo");
    writeConfigFile(dir, { ...DEFAULTS, scoreThreshold: 0.22, codeKnowledge: "on" });
    const rt = await makeRuntime(dir, repo, {}, fakeIO(dir));
    assert.deepEqual(rt.cfg, readGlobalConfig(dir, {}));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("D10: a global write persists the global value and the reload keeps the project override", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-deps-"));
  try {
    const repo = gitRepo(dir, "repo");
    const id = await projectIdFrom(repo);
    writeConfigFile(dir, { ...DEFAULTS, codeKnowledge: "on" });
    saveProjectSettings(dir, id, { codeKnowledge: "off" });
    const rt = await makeRuntime(dir, repo, {}, fakeIO(dir));
    writeGlobalConfigAndReload(rt, dir, { ...readGlobalConfig(dir, {}), scoreThreshold: 0.2 });
    assert.equal(JSON.parse(readFileSync(configPath(dir), "utf8")).codeKnowledge, "on"); // global value persisted
    assert.equal(rt.cfg.codeKnowledge, "off");   // override survived the reload (effective reader)
    assert.equal(rt.cfg.scoreThreshold, 0.2);    // the write did take effect
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reloadEffectiveConfig follows the live projectId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-deps-"));
  try {
    const repoA = gitRepo(dir, "repoA");
    const repoB = gitRepo(dir, "repoB");
    const idA = await projectIdFrom(repoA);
    const idB = await projectIdFrom(repoB);
    writeConfigFile(dir, { ...DEFAULTS, codeKnowledge: "on" });
    saveProjectSettings(dir, idA, { codeKnowledge: "off" });
    saveProjectSettings(dir, idB, { codeScoreThreshold: 0.7 });
    const rt = await makeRuntime(dir, repoA, {}, fakeIO(dir));
    assert.equal(rt.cfg.codeKnowledge, "off");
    rt.projectId = idB;
    rt.reloadEffectiveConfig();
    assert.equal(rt.cfg.codeKnowledge, "on"); // global value for project B
    assert.equal(rt.cfg.codeScoreThreshold, 0.7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("depsToIO project writes persist the store and reload the effective config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-deps-"));
  try {
    const repo = gitRepo(dir, "repo");
    writeConfigFile(dir, { ...DEFAULTS, codeKnowledge: "on" });
    const rt = await makeRuntime(dir, repo, {}, fakeIO(dir));
    const io = depsToIO(rt);
    io.writeProjectSettings({ codeKnowledge: "off" });
    assert.equal(loadProjectSettings(dir, rt.projectId).codeKnowledge, "off"); // file on disk
    assert.equal(rt.cfg.codeKnowledge, "off");                                 // live runtime reloaded

    io.clearProjectSetting("codeKnowledge");
    assert.equal(existsSync(projectSettingsPath(dir, rt.projectId)), false);   // file gone
    assert.equal(rt.cfg.codeKnowledge, "on");                                  // back to the global value
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
