import test from "node:test";
import assert from "node:assert/strict";
import { buildSettingItems } from "../src/settings-ui.ts";
import type { SettingItem, SettingsItemsInput } from "../src/settings-ui.ts";
import { DEFAULTS, SETTING_FIELDS } from "../src/config.ts";
import type { Config } from "../src/types.ts";

/** Distinct, recognisable secret strings that must never leak into the items. */
const QDRANT_SECRET = "sk-qdrant-secret-0001";
const EMBED_SECRET = "sk-embed-secret-9999";

/** The nine fields edited through the step-7 ValuePrompt submenu. */
const PROMPT_FIELDS = [
  "embeddingBaseURL",
  "embeddingModel",
  "expectedDimension",
  "scoreThreshold",
  "codeScoreThreshold",
  "maxResults",
  "qdrantUrl",
  "qdrantApiKey",
  "embeddingApiKey",
] as const;

/** The three Enter-cycling enum fields. */
const ENUM_FIELDS = ["mode", "codeKnowledge", "memoryForget"] as const;

/** A fake runtime triple: effective cfg, global reader config, no project
 * overrides, empty env (so the default branch never touches process.env). */
function fakeInput(
  overrides?: { cfg?: Partial<Config>; global?: Partial<Config>; env?: NodeJS.ProcessEnv },
): SettingsItemsInput {
  const cfg: Config = {
    ...DEFAULTS,
    qdrantUrl: "http://qdrant.example:6333",
    qdrantApiKey: QDRANT_SECRET,
    embeddingBaseURL: "http://embed.example/v1",
    embeddingModel: "test-embed-model",
    embeddingApiKey: null,
    expectedDimension: 1024,
    scoreThreshold: 0.2,
    maxResults: 25,
    mode: "auto",
    codeKnowledge: "on",
    codeScoreThreshold: 0.6,
    memoryForget: "off",
    ...(overrides?.cfg ?? {}),
  };
  const global: Config = { ...cfg, ...(overrides?.global ?? {}) };
  return { cfg, global, project: {}, env: overrides?.env ?? {} };
}

function items(input?: SettingsItemsInput): SettingItem[] {
  return buildSettingItems(input ?? fakeInput());
}

function byId(list: SettingItem[]): Map<string, SettingItem> {
  return new Map(list.map((i) => [i.id, i]));
}

test("all twelve SETTING_FIELDS are present, in order, with id/label = the key", () => {
  const list = items();
  assert.deepEqual(
    list.map((i) => i.id),
    [...SETTING_FIELDS],
  );
  for (const item of list) {
    assert.equal(item.label, item.id);
  }
});

test("secret values never appear in the rendered items", () => {
  const json = JSON.stringify(items());
  assert.ok(!json.includes(QDRANT_SECRET), `qdrantApiKey value leaked: ${json}`);
  assert.ok(!json.includes(EMBED_SECRET), `embeddingApiKey value leaked: ${json}`);
  const by = byId(items());
  assert.equal(by.get("qdrantApiKey")?.currentValue, "set");
  assert.equal(by.get("embeddingApiKey")?.currentValue, "not set");
});

test("both secret states are covered: a set key and a null key", () => {
  const set = byId(items());
  assert.equal(set.get("qdrantApiKey")?.currentValue, "set");
  assert.equal(set.get("embeddingApiKey")?.currentValue, "not set");

  const both = byId(items(fakeInput({ cfg: { embeddingApiKey: EMBED_SECRET } })));
  assert.equal(both.get("qdrantApiKey")?.currentValue, "set");
  assert.equal(both.get("embeddingApiKey")?.currentValue, "set");

  const none = byId(items(fakeInput({ cfg: { qdrantApiKey: null, embeddingApiKey: null } })));
  assert.equal(none.get("qdrantApiKey")?.currentValue, "not set");
  assert.equal(none.get("embeddingApiKey")?.currentValue, "not set");
});

test("codeKnowledge offers off/on plus the clear-override entry naming the inherited global value", () => {
  const by = byId(items(fakeInput({ global: { codeKnowledge: "off" } })));
  const item = by.get("codeKnowledge");
  assert.deepEqual(item?.values, ["off", "on", "default (inherit global: off)"]);
  // Effective (project/env) value differs from global: the display is effective.
  assert.equal(item?.currentValue, "on");
  assert.equal(
    by.get("codeKnowledge")?.description,
    "Per project. Global: off. Takes effect at the next session start.",
  );
});

test("prompt markers sit exactly on the ValuePrompt fields; values exactly on the enum fields", () => {
  const by = byId(items());
  for (const field of PROMPT_FIELDS) {
    assert.equal(typeof by.get(field)?.prompt, "string", `${field} must carry a prompt`);
    assert.equal(by.get(field)?.values, undefined, `${field} must not carry values`);
  }
  for (const field of ENUM_FIELDS) {
    assert.equal(by.get(field)?.prompt, undefined, `${field} must not carry a prompt`);
    assert.ok(Array.isArray(by.get(field)?.values), `${field} must carry values`);
  }
  assert.deepEqual(
    byId(items()).get("mode")?.values,
    ["auto", "blackhole", "own"],
  );
  assert.deepEqual(
    byId(items()).get("memoryForget")?.values,
    ["off", "on"],
  );
  // The secret prompts mark the clear path.
  assert.equal(by.get("qdrantApiKey")?.prompt, "qdrantApiKey (clear to remove)");
  assert.equal(by.get("embeddingApiKey")?.prompt, "embeddingApiKey (clear to remove)");
});

test("descriptions state the scope and the per-kind rule", () => {
  const by = byId(items());
  assert.equal(by.get("mode")?.description, "Global. One of auto, blackhole, own.");
  assert.equal(by.get("memoryForget")?.description, "Global. One of off, on.");
  assert.equal(by.get("codeScoreThreshold")?.description, "Per project. Global: 0.6. 0–1.");
  assert.equal(by.get("expectedDimension")?.description, "Global. Positive integer.");
  assert.equal(by.get("scoreThreshold")?.description, "Global. 0–1.");
  assert.equal(by.get("maxResults")?.description, "Global. Positive integer.");
  assert.equal(by.get("embeddingBaseURL")?.description, "Global.");
  assert.equal(by.get("embeddingModel")?.description, "Global.");
  assert.equal(by.get("qdrantUrl")?.description, "Global.");
  assert.equal(
    by.get("qdrantApiKey")?.description,
    "Global. Stored in the global config file, never displayed.",
  );
  assert.equal(
    by.get("embeddingApiKey")?.description,
    "Global. Stored in the global config file, never displayed.",
  );
});

test("effective values are displayed: effective cfg wins over the global reader", () => {
  const by = byId(
    items(fakeInput({ global: { scoreThreshold: 0.1, mode: "blackhole" }, cfg: { scoreThreshold: 0.2, mode: "auto" } })),
  );
  assert.equal(by.get("scoreThreshold")?.currentValue, "0.2");
  assert.equal(by.get("mode")?.currentValue, "auto");
  assert.equal(by.get("expectedDimension")?.currentValue, "1024");
  assert.equal(by.get("maxResults")?.currentValue, "25");
});

test("the env-mask note is appended to masked per-project fields, and absent otherwise", () => {
  const masked = byId(items(fakeInput({ env: { PI_QDRANT_CODE_KNOWLEDGE: "on", PI_QDRANT_CODE_SCORE_THRESHOLD: "0.5" } })));
  assert.equal(
    masked.get("codeKnowledge")?.description,
    "Per project. Global: on. Takes effect at the next session start. — NOTE: currently masked by PI_QDRANT_CODE_KNOWLEDGE=on",
  );
  assert.equal(
    masked.get("codeScoreThreshold")?.description,
    "Per project. Global: 0.6. 0–1. — NOTE: currently masked by PI_QDRANT_CODE_SCORE_THRESHOLD=0.5",
  );

  const unmasked = byId(items(fakeInput({ env: {} })));
  assert.ok(!unmasked.get("codeKnowledge")?.description?.includes("NOTE:"));
  assert.ok(!unmasked.get("codeScoreThreshold")?.description?.includes("NOTE:"));
  // Non-overridable fields never carry a mask note.
  assert.ok(!unmasked.get("scoreThreshold")?.description?.includes("NOTE:"));
});
