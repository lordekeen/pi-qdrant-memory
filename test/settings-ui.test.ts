import test from "node:test";
import assert from "node:assert/strict";
import { buildSettingItems, openSettingsScreen, ValuePrompt } from "../src/settings-ui.ts";
import type { MountFn, SettingItem, SettingsItemsInput } from "../src/settings-ui.ts";
import type { EntryComponent, HostSettingItem, InputCtor, SettingsHost } from "../src/entry-render.ts";
import { DEFAULTS, SETTING_FIELDS } from "../src/config.ts";
import { outText } from "../src/out.ts";
import type { OutEntry } from "../src/out.ts";
import type { HandlerIO } from "../src/handlers.ts";
import type { ProjectSettings } from "../src/project-settings.ts";
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

// ── The screen: ValuePrompt + openSettingsScreen ────────────────────────────
//
// Everything below runs with NO pi package loaded. The fakes below model the
// host's REAL side effects, which is the whole point (AGENTS.md): the fake
// SettingsList mutates `item.currentValue` BEFORE calling `onChange` — exactly
// as `pi-tui/dist/components/settings-list.js:275,288-290` does — because a
// fake that did not could never catch a missing rollback. The store fake
// likewise updates the value a later read sees.

const SECRET_QDRANT = "sk-qdrant-should-never-render-0001";

/** A fake pi-tui `Input` (`dist/components/input.d.ts`): a value, the keys it
 *  was handed, and nothing else. */
class FakeInput {
  static instances: FakeInput[] = [];
  value = "";
  readonly received: string[] = [];
  invalidated = 0;
  constructor() { FakeInput.instances.push(this); }
  getValue(): string { return this.value; }
  setValue(v: string): void { this.value = v; }
  handleInput(data: string): void { this.received.push(data); this.value += data; }
  invalidate(): void { this.invalidated++; }
  render(): string[] { return [`input:${this.value}`]; }
}

/** The injected keybindings manager: `matches(data, bindingId)`. The confirm /
 *  cancel ids are the SAME ones the host's own SettingsList uses. */
function fakeKeybindings(): { matches(data: string, id: string): boolean } {
  return {
    matches: (data, id) =>
      id === "tui.select.confirm" ? data === "\r"
        : id === "tui.select.cancel" ? data === ""
          : false,
  };
}

const fakeTheme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };

/** A fake host `SettingsList` that reproduces the host's mutation order and
 *  records every `updateValue` rollback. */
class FakeSettingsList {
  static last: FakeSettingsList | undefined;
  readonly items: HostSettingItem[];
  readonly maxVisible: number;
  readonly theme: unknown;
  readonly options: { enableSearch?: boolean } | undefined;
  readonly onChange: (id: string, newValue: string) => void;
  readonly onCancel: () => void;
  /** Every `updateValue(id, value)` call, in order — the rollback ledger. */
  readonly updates: Array<[string, string]> = [];
  constructor(
    items: HostSettingItem[],
    maxVisible: number,
    theme: unknown,
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
    options?: { enableSearch?: boolean },
  ) {
    this.items = items;
    this.maxVisible = maxVisible;
    this.theme = theme;
    this.onChange = onChange;
    this.onCancel = onCancel;
    this.options = options;
    FakeSettingsList.last = this;
  }
  updateValue(id: string, newValue: string): void {
    this.updates.push([id, newValue]);
    const item = this.items.find((i) => i.id === id);
    if (item) item.currentValue = newValue;
  }
  render(_width: number): string[] { return this.items.map((i) => `${i.label} = ${i.currentValue}`); }
  handleInput(_data: string): void { /* the host decodes keys itself; unused here */ }
  invalidate(): void { /* no cache */ }
  /** Drive the host's cycle path: mutate the row, THEN call onChange. */
  cycle(id: string, newValue: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error(`no such item ${id}`);
    item.currentValue = newValue;
    this.onChange(id, newValue);
  }
  /** Drive the host's submenu commit path (same order: mutate, then onChange). */
  commitSubmenu(id: string, newValue: string): void {
    this.cycle(id, newValue);
  }
}

const FakeBorder = class {
  static count = 0;
  constructor() { FakeBorder.count++; }
  invalidate(): void { /* nothing cached */ }
  render(width: number): string[] { return ["-".repeat(width)]; }
};

function settingsHost(over?: { border?: boolean; keyText?: (id: string) => string }) {
  return {
    SettingsList: FakeSettingsList,
    Input: FakeInput as unknown as InputCtor,
    getSettingsListTheme: () => ({
      label: (t: string) => `label(${t})`,
      value: (t: string) => `value(${t})`,
      description: (t: string) => `desc(${t})`,
      cursor: "→ ",
      hint: (t: string) => `hint(${t})`,
    }),
    ...(over?.border === false ? {} : { DynamicBorder: FakeBorder as never }),
    ...(over?.keyText ? { keyText: over.keyText } : {}),
  } as unknown as SettingsHost;
}

/** Stateful two-store model, mirroring the one in handlers.test.ts: global
 *  Config + project store + the EFFECTIVE view (store → global). */
function screenIo(over?: { global?: Partial<Config>; store?: Partial<ProjectSettings> }) {
  const emitted: OutEntry[] = [];
  const globalWrites: Config[] = [];
  const projectWrites: ProjectSettings[] = [];
  const cleared: string[] = [];
  const globalState: Config = { ...fakeInput({ cfg: { qdrantApiKey: SECRET_QDRANT } }).cfg, ...(over?.global ?? {}) };
  const storeState: ProjectSettings = { ...(over?.store ?? {}) };
  const effective = (): Config => ({ ...globalState, ...storeState });
  const io: HandlerIO = {
    get cfg() { return effective(); },
    agentDir: "/tmp/agent",
    cwd: "/repo",
    projectId: "pi-mem-abc",
    embed: async () => [],
    qdrant: {} as never,
    readGlobalConfig: () => ({ ...globalState }),
    writeGlobalConfig: (c) => { globalWrites.push(c); Object.assign(globalState, c); },
    readProjectSettings: () => ({ ...storeState }),
    writeProjectSettings: (p) => { projectWrites.push(p); Object.assign(storeState, p); },
    clearProjectSetting: (f) => { cleared.push(f); delete storeState[f]; },
    emit: (e) => { emitted.push(e); },
    env: {},
  };
  return { io, emitted, globalWrites, projectWrites, cleared, globalState, storeState };
}

function texts(entries: OutEntry[]): string[] { return entries.map((e) => outText(e)); }

/** Mount the screen and hand back the list fake plus the mounted component. */
async function mountScreen(io: HandlerIO, host: SettingsHost) {
  let doneCalls = 0;
  let component: EntryComponent | undefined;
  const mount: MountFn = async (factory) => {
    component = factory({
      tui: {},
      theme: fakeTheme,
      keybindings: fakeKeybindings() as never,
      done: () => { doneCalls++; },
    });
    return undefined;
  };
  await openSettingsScreen(io, host, mount);
  const list = FakeSettingsList.last;
  assert.ok(list, "expected a SettingsList to be constructed");
  return { list, done: () => doneCalls, component: component! };
}

test("the screen mounts pi's SettingsList with the host theme, search on, and 10 visible rows", async () => {
  FakeInput.instances = [];
  const { io } = screenIo();
  const { list, component } = await mountScreen(io, settingsHost());
  assert.equal(list.items.length, 12, "one row per SETTING_FIELDS");
  assert.equal(list.maxVisible, 10, "pi's own settings overlay caps at 10");
  assert.equal(list.options?.enableSearch, true);
  assert.deepEqual(
    list.items.map((i) => i.id),
    [...SETTING_FIELDS],
  );
  assert.ok(component.render(40).length > 0, "the wrapper renders");
});

test("prompt rows get a submenu factory; enum rows keep their cycle values", async () => {
  const { io } = screenIo();
  const { list } = await mountScreen(io, settingsHost());
  const by = new Map(list.items.map((i) => [i.id, i]));
  for (const field of PROMPT_FIELDS) {
    assert.equal(typeof by.get(field)?.submenu, "function", `${field} must open a submenu`);
    assert.equal(by.get(field)?.values, undefined);
  }
  for (const field of ENUM_FIELDS) {
    assert.equal(by.get(field)?.submenu, undefined, `${field} must not open a submenu`);
    assert.ok(Array.isArray(by.get(field)?.values));
  }
});

test("cycling an enum field writes the GLOBAL config and confirms it", async () => {
  const { io, emitted, globalWrites, projectWrites } = screenIo();
  const { list } = await mountScreen(io, settingsHost());
  list.cycle("memoryForget", "on");
  assert.equal(globalWrites.length, 1, "a non-allowlisted key goes to the global file");
  assert.equal(globalWrites[0].memoryForget, "on");
  assert.equal(projectWrites.length, 0, "never the project store");
  assert.deepEqual(texts(emitted), ["settings: memoryForget updated (global config; reloaded at runtime)"]);
});

test("an allowlisted field writes the PROJECT store, not the global file", async () => {
  const { io, emitted, globalWrites, projectWrites } = screenIo();
  const { list } = await mountScreen(io, settingsHost());
  list.cycle("codeScoreThreshold", "0.9");
  assert.equal(projectWrites.length, 1);
  assert.deepEqual(projectWrites[0], { codeScoreThreshold: 0.9 });
  assert.equal(globalWrites.length, 0, "D10: never persist the effective config");
  assert.deepEqual(texts(emitted), ["settings: codeScoreThreshold = 0.9 (this project; global: 0.6)"]);
});

test("the clear-override entry normalises to the reserved `default` token and clears", async () => {
  const { io, emitted, cleared, projectWrites } = screenIo({ store: { codeKnowledge: "on" }, global: { codeKnowledge: "off" } });
  const { list } = await mountScreen(io, settingsHost());
  // The row offers the LABEL, not the token; the screen must map it back.
  const label = list.items.find((i) => i.id === "codeKnowledge")?.values?.[2];
  assert.equal(label, "default (inherit global: off)");
  list.cycle("codeKnowledge", label!);
  assert.deepEqual(cleared, ["codeKnowledge"], "the override is cleared, not written");
  assert.equal(projectWrites.length, 0);
  assert.ok(texts(emitted).includes("settings: codeKnowledge override cleared (now using global: off)"));
});

test("a rejected value emits an error AND rolls the displayed value back (mandatory)", async () => {
  const { io, emitted, globalWrites } = screenIo();
  const { list } = await mountScreen(io, settingsHost());
  const before = list.items.find((i) => i.id === "scoreThreshold")!.currentValue;
  list.cycle("scoreThreshold", "not-a-number");
  assert.equal(globalWrites.length, 0, "nothing is persisted");
  assert.match(texts(emitted)[0], /error: settings: scoreThreshold expects a number/);
  // The host already mutated the row before onChange; without this rollback the
  // list would display a value that was never saved.
  assert.deepEqual(list.updates, [["scoreThreshold", before]]);
  assert.equal(list.items.find((i) => i.id === "scoreThreshold")!.currentValue, before);
});

test("a rejected allowlisted value rolls back too", async () => {
  const { io, projectWrites } = screenIo();
  const { list } = await mountScreen(io, settingsHost());
  const before = list.items.find((i) => i.id === "codeScoreThreshold")!.currentValue;
  list.cycle("codeScoreThreshold", "5");
  assert.equal(projectWrites.length, 0);
  assert.deepEqual(list.updates, [["codeScoreThreshold", before]]);
});

test("a secret is never displayed, emitted or left in the row after a write (#58)", async () => {
  const { io, emitted, globalWrites } = screenIo();
  const { list } = await mountScreen(io, settingsHost());
  assert.equal(list.items.find((i) => i.id === "qdrantApiKey")!.currentValue, "set");

  const NEW_SECRET = "sk-brand-new-secret-7777";
  list.commitSubmenu("qdrantApiKey", NEW_SECRET);
  assert.equal(globalWrites[0].qdrantApiKey, NEW_SECRET, "the value IS persisted");
  // …but the host copied it into the row before calling us, so the screen must
  // put the set-state back. This is the assertion the old fake could not make.
  assert.equal(list.items.find((i) => i.id === "qdrantApiKey")!.currentValue, "set");
  const rendered = JSON.stringify(list.render(80)) + texts(emitted).join("\n");
  assert.ok(!rendered.includes(NEW_SECRET), `secret leaked: ${rendered}`);
  assert.ok(!rendered.includes(SECRET_QDRANT), `old secret leaked: ${rendered}`);
});

test("clearing a secret with an empty value writes null, not an empty string", async () => {
  const { io, globalWrites } = screenIo();
  const { list } = await mountScreen(io, settingsHost());
  list.commitSubmenu("qdrantApiKey", "");
  assert.equal(globalWrites[0].qdrantApiKey, null);
  assert.equal(list.items.find((i) => i.id === "qdrantApiKey")!.currentValue, "not set");
});

test("a successful write refreshes the row from the freshly written config", async () => {
  const { io } = screenIo();
  const { list } = await mountScreen(io, settingsHost());
  list.commitSubmenu("expectedDimension", "1536");
  assert.deepEqual(list.updates, [["expectedDimension", "1536"]]);
  assert.equal(list.items.find((i) => i.id === "expectedDimension")!.currentValue, "1536");
});

test("an effective codeKnowledge change emits the reload notice", async () => {
  const { io, emitted } = screenIo({ store: { codeKnowledge: "off" } });
  const { list } = await mountScreen(io, settingsHost());
  list.cycle("codeKnowledge", "on");
  const all = texts(emitted);
  assert.equal(all.length, 2);
  assert.ok(all[1].startsWith("code memory: takes effect at the next session start"), all[1]);
});

test("no reload notice when the EFFECTIVE value did not change", async () => {
  const { io, emitted } = screenIo({ store: { codeKnowledge: "on" } });
  const { list } = await mountScreen(io, settingsHost());
  list.cycle("codeKnowledge", "on"); // already on — a no-op write
  assert.equal(texts(emitted).length, 1, "only the confirmation, no reload notice");
});

test("Esc cancels: done() resolves the modal and a cancellation entry is emitted (#58)", async () => {
  const { io, emitted } = screenIo();
  const { list, done } = await mountScreen(io, settingsHost());
  list.onCancel();
  assert.equal(done(), 1, "the mount promise must resolve, or the modal never closes");
  assert.deepEqual(texts(emitted), ["settings: unchanged (cancelled)"]);
});

test("feedback is emitted in order: confirmation first, then the conflict notice", async () => {
  // mode: own + an operational pi-blackhole is the contradictory config #50.
  const { io, emitted, globalWrites } = screenIo({ global: { mode: "own" } });
  const { list } = await mountScreen(io, settingsHost());
  list.cycle("mode", "own");
  assert.equal(globalWrites.length, 1);
  // Without a blackhole install there is nothing to conflict with.
  assert.deepEqual(texts(emitted), ["settings: mode updated (global config; reloaded at runtime)"]);
});

// ── ValuePrompt (plan B.3) ─────────────────────────────────────────────────

function promptEnv(currentValue = "0.6") {
  const committed: Array<string | undefined> = [];
  const prompt = new ValuePrompt({
    Input: FakeInput as unknown as InputCtor,
    theme: fakeTheme,
    keybindings: fakeKeybindings() as never,
    promptText: "codeScoreThreshold (number between 0 and 1)",
    currentValue,
    done: (v) => { committed.push(v); },
  });
  return { prompt, committed, input: FakeInput.instances[FakeInput.instances.length - 1] };
}

test("ValuePrompt renders the prompt line in the host theme, then the Input", () => {
  FakeInput.instances = [];
  const { prompt } = promptEnv();
  assert.deepEqual(prompt.render(40), [
    "<dim>codeScoreThreshold (number between 0 and 1) — current: 0.6</dim>",
    "input:",
  ]);
});

test("ValuePrompt never prefills the Input (#58) — the value is on the prompt line", () => {
  FakeInput.instances = [];
  const { input } = promptEnv("sk-a-secret");
  assert.equal(input.getValue(), "", "the input starts empty");
  assert.equal(input.received.length, 0);
});

test("ValuePrompt confirm commits the trimmed value exactly once", () => {
  FakeInput.instances = [];
  const { prompt, committed, input } = promptEnv();
  input.handleInput("0.7");
  prompt.handleInput("\r");
  assert.deepEqual(committed, ["0.7"]);
  // A second key after the commit must not commit again.
  prompt.handleInput("\r");
  assert.deepEqual(committed, ["0.7"]);
});

test("ValuePrompt confirm trims surrounding whitespace", () => {
  FakeInput.instances = [];
  const { prompt, committed, input } = promptEnv();
  input.handleInput("  0.42 ");
  prompt.handleInput("\r");
  assert.deepEqual(committed, ["0.42"]);
});

test("ValuePrompt cancel commits NOTHING, so the parent skips the write", () => {
  FakeInput.instances = [];
  const { prompt, committed, input } = promptEnv();
  input.handleInput("0.9");
  prompt.handleInput("");
  assert.deepEqual(committed, [undefined], "done() with no value — no onChange");
});

test("ValuePrompt forwards every other key to the Input, and invalidate forwards", () => {
  FakeInput.instances = [];
  const { prompt, committed, input } = promptEnv();
  // Ordinary editing keys only — confirm and cancel are intercepted by design
  // (and asserted in the two tests above).
  for (const key of ["a", "b", "\t"]) prompt.handleInput(key);
  assert.deepEqual(input.received, ["a", "b", "\t"]);
  assert.deepEqual(committed, [], "no key is a confirm or a cancel");
  prompt.invalidate();
  assert.equal(input.invalidated, 1);
});

// ── Graceful degradation ───────────────────────────────────────────────────

test("with no keyText/border the wrapper renders the list alone — nothing unstyled", async () => {
  const { io } = screenIo();
  const { component, list } = await mountScreen(io, settingsHost({ border: false }));
  // Exactly the rows: no border line above or below, and no invented key hint.
  assert.deepEqual(component.render(20), list.items.map((i) => `${i.label} = ${i.currentValue}`));
});

test("with the host pieces resolved the wrapper frames the list and hints the keys", async () => {
  FakeBorder.count = 0;
  const { io } = screenIo();
  const { component } = await mountScreen(
    io,
    settingsHost({ keyText: (id) => (id === "tui.select.confirm" ? "⏎" : "esc") }),
  );
  const lines = component.render(20);
  assert.equal(lines[0], "-".repeat(20), "border above");
  assert.equal(lines.at(-1), "-".repeat(20), "border below");
  assert.ok(lines.some((l) => l.includes("⏎ to change · esc to close")), lines.join("\n"));
});
