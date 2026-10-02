/**
 * Settings item mapping + the host settings screen (plan Part B.1/B.2/B.3/B.4).
 *
 * `buildSettingItems` is PURE and host-free: it maps an effective/global/project
 * config triple into `SettingItem` rows and nothing else, so the mapping is
 * fully unit-testable under plain node with no pi package loaded.
 *
 * Everything below it (`ValuePrompt`, `openSettingsScreen`) takes its host
 * components INJECTED — `SettingsHost` is a structural interface, never an
 * import — so the screen is testable with fakes and degrades to nothing at all
 * when the host bridge does not resolve.
 */
import { SETTING_FIELDS, setConfigField } from "./config.ts";
import type { SettingField } from "./config.ts";
import { isProjectOverridable, maskNote } from "./project-settings.ts";
import type { ProjectOverridableField, ProjectSettings } from "./project-settings.ts";
import { detectBlackhole } from "./mode.ts";
import {
  codeMemoryReloadNotice,
  displayValue,
  errorEntry,
  isSecretSettingField,
  message,
  modeOwnConflictNotice,
  resetOptionLabel,
  secretDisplayValue,
  settingsCancelledText,
  settingsGlobalUpdatedText,
  settingsOverrideClearedText,
  settingsScreenHintText,
  settingsUpdatedText,
  valuePromptText,
} from "./out.ts";
import type { Config } from "./types.ts";
import type { HandlerIO } from "./handlers.ts";
import type {
  EntryComponent,
  HostSettingItem,
  InputCtor,
  SettingsHost,
  SettingsListCtor,
  SettingsListInstance,
} from "./entry-render.ts";

/** Host-shaped `SettingItem` (pi-tui `settings-list.ts:7-24`) minus the
 * `submenu` factory: fields edited through the step-7 `ValuePrompt` submenu
 * carry a `prompt` marker with the prompt text instead. The ambient shim is
 * aliased to this interface in step 6. */
export interface SettingItem {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  /** Allowed values; Enter cycles through them (enum fields only). */
  values?: string[];
  /** Present only for fields whose editor is the `ValuePrompt` submenu
   * (number, URL/model and secret fields): the prompt text it shows. */
  prompt?: string;
}

/** The narrow input step 7 can satisfy straight from the runtime.
 *
 * - `cfg`: the effective config — what is *displayed* (env → project → global).
 * - `global`: the global reader's config — the fallback named in
 *   per-project descriptions and the inherited value of the clear-override
 *   entry; also the D10 write target.
 * - `project`: this project's overrides. The B.2 description text does not
 *   reference override state yet, but the field is kept so step 7 can pass
 *   the runtime triple through without reshaping, and so a future
 *   "(project override active)" annotation has a home.
 * - `env`: genuinely required by the mapping — the mask note comes from
 *   `maskNote`'s env-masking check, and an injectable env keeps the function
 *   pure and testable without mutating `process.env`. Defaults to
 *   `process.env`, mirroring `HandlerIO.env`.
 */
export interface SettingsItemsInput {
  cfg: Config;
  global: Config;
  project: Partial<Config>;
  env?: NodeJS.ProcessEnv;
}

/** One `SettingItem` per `SETTING_FIELDS` entry, in the same stable order the
 * CLI, the form and the completion all use (plan B.2 table). */
export function buildSettingItems(input: SettingsItemsInput): SettingItem[] {
  const env = input.env ?? process.env;
  return SETTING_FIELDS.map((field) => itemFor(field, input.cfg, input.global, env));
}

function itemFor(
  field: SettingField,
  cfg: Config,
  global: Config,
  env: NodeJS.ProcessEnv,
): SettingItem {
  switch (field) {
    case "mode":
      return {
        id: field,
        label: field,
        currentValue: displayValue(cfg.mode),
        values: ["auto", "blackhole", "own"],
        description: "Global. One of auto, blackhole, own.",
      };
    case "codeKnowledge": {
      // Per project (allowlisted). The third values entry is the existing
      // clear-override path; step 7 normalises it back to the reserved
      // `default` token.
      const description = `Per project. Global: ${displayValue(global.codeKnowledge)}. Takes effect at the next session start.`;
      return {
        id: field,
        label: field,
        currentValue: displayValue(cfg.codeKnowledge),
        values: ["off", "on", resetOptionLabel(global.codeKnowledge)],
        description: withMaskNote(description, maskNote(field, env)),
      };
    }
    case "memoryForget":
      return {
        id: field,
        label: field,
        currentValue: displayValue(cfg.memoryForget),
        values: ["off", "on"],
        description: "Global. One of off, on.",
      };
    case "embeddingBaseURL":
      return { id: field, label: field, currentValue: cfg.embeddingBaseURL, prompt: field, description: "Global." };
    case "embeddingModel":
      return { id: field, label: field, currentValue: cfg.embeddingModel, prompt: field, description: "Global." };
    case "expectedDimension":
      return {
        id: field,
        label: field,
        currentValue: String(cfg.expectedDimension),
        prompt: `${field} (positive integer)`,
        description: "Global. Positive integer.",
      };
    case "scoreThreshold":
      return {
        id: field,
        label: field,
        currentValue: String(cfg.scoreThreshold),
        prompt: `${field} (number between 0 and 1)`,
        description: "Global. 0–1.",
      };
    case "codeScoreThreshold": {
      // Per project (allowlisted): the same scope wording as codeKnowledge,
      // carrying its own validation rule.
      const description = `Per project. Global: ${displayValue(global.codeScoreThreshold)}. 0–1.`;
      return {
        id: field,
        label: field,
        currentValue: String(cfg.codeScoreThreshold),
        prompt: `${field} (number between 0 and 1)`,
        description: withMaskNote(description, maskNote(field, env)),
      };
    }
    case "maxResults":
      return {
        id: field,
        label: field,
        currentValue: String(cfg.maxResults),
        prompt: `${field} (positive integer)`,
        description: "Global. Positive integer.",
      };
    case "qdrantUrl":
      return { id: field, label: field, currentValue: cfg.qdrantUrl, prompt: field, description: "Global." };
    case "qdrantApiKey":
      return {
        id: field,
        label: field,
        // Secret: only the set-state is ever shown, never the value (audit M3).
        currentValue: cfg.qdrantApiKey === null ? "not set" : "set",
        prompt: `${field} (clear to remove)`,
        description: "Global. Stored in the global config file, never displayed.",
      };
    case "embeddingApiKey":
      return {
        id: field,
        label: field,
        currentValue: cfg.embeddingApiKey === null ? "not set" : "set",
        prompt: `${field} (clear to remove)`,
        description: "Global. Stored in the global config file, never displayed.",
      };
  }
}

/** Append the env-mask note to a description, mirroring the ` — ` separator
 * the existing settings confirmations use (`settingsUpdatedText`). */
function withMaskNote(description: string, note: string | undefined): string {
  return note ? `${description} — ${note}` : description;
}

// ── Host injection seam ──────────────────────────────────────────────────────

/** The host theme, narrowed to the one method the prompt line uses
 *  (`pi-coding-agent/dist/modes/interactive/theme/theme.d.ts:72`). */
export interface ThemeLike {
  fg(color: string, text: string): string;
}

/**
 * The keybinding matcher the `custom` factory injects. Only the two ids the
 * value prompt needs are named: they are BINDING IDS passed to `matches`, not
 * properties of the manager, and they are the same ids the host's own
 * `SettingsList` matches on (`pi-tui/dist/components/settings-list.js:179-184`).
 * Method-parameter bivariance keeps the host's broader `KeybindingsManager`
 * (whose `matches` takes the whole `Keybinding` union) assignable to this.
 */
export interface KeybindingsLike {
  matches(data: string, keybinding: "tui.select.confirm" | "tui.select.cancel"): boolean;
}

/** A component the host will render. Structurally `Component` from pi-tui
 *  (`render` + `invalidate` required, `handleInput` optional). */
export type SettingsComponent = EntryComponent;

/** The arguments pi hands a `ctx.ui.custom` factory
 *  (`dist/core/extensions/types.d.ts:121-129`). `tui` is carried but unused —
 *  the screen draws nothing itself, so it never needs the terminal. */
export interface CustomFactoryArgs {
  tui: unknown;
  theme: ThemeLike;
  keybindings: KeybindingsLike;
  done: (result?: unknown) => void;
}

/** The mounting seam: exactly `ctx.ui.custom`, narrowed to what the screen
 *  uses, so the dispatch can pass the host's own `custom` and the tests a fake. */
export type MountFn = (factory: (args: CustomFactoryArgs) => SettingsComponent) => Promise<unknown>;

/** A one-key typed partial for the project store — mirrors `settingsHandler`
 *  in handlers.ts so both writers produce the same shape. */
function projectOverride(cfg: Config, field: ProjectOverridableField): ProjectSettings {
  return field === "codeKnowledge"
    ? { codeKnowledge: cfg.codeKnowledge }
    : { codeScoreThreshold: cfg.codeScoreThreshold };
}

function isSettingField(id: string): id is SettingField {
  return (SETTING_FIELDS as readonly string[]).includes(id);
}

/** The config value a row may safely DISPLAY for this field. For a secret that
 *  is its set-state and nothing else — the one place that guarantee is enforced
 *  after a write, because the host copies the typed value into
 *  `item.currentValue` before it calls `onChange` (#58). */
function displayOf(field: SettingField, cfg: Config): string {
  // SAFETY: `field` is a `SettingField`, i.e. exactly a `Config` key, whose
  // values are all `string | number | null` — the projection cannot read out of
  // bounds (mirrors `cfgField` in handlers.ts).
  const value = (cfg as unknown as Record<string, string | number | null>)[field];
  return isSecretSettingField(field) ? secretDisplayValue(value) : displayValue(value);
}

// ── ValuePrompt (plan B.3) ──────────────────────────────────────────────────

export interface ValuePromptDeps {
  /** The host `Input` (injected: no pi import in this module). */
  Input: InputCtor;
  theme: ThemeLike;
  keybindings: KeybindingsLike;
  /** The prompt text the mapping attached to this row. */
  promptText: string;
  /** The value in effect, for the prompt line. For a secret this is
   *  `set`/`not set`, so nothing sensitive can reach the screen. */
  currentValue: string;
  /** The host submenu contract: `done(value)` commits, `done()` cancels. */
  done: (selectedValue?: string) => void;
}

/**
 * The submenu editor: one prompt line plus pi-tui's own single-line `Input`.
 *
 * Deliberately minimal — no timers, no subscriptions, nothing to dispose, and
 * no prefill: the current value is shown on the prompt line, never handed to
 * the `Input` as its initial text, because for a secret field that text would
 * BE the credential (#58). Key matching uses the injected `keybindings` object
 * (the extension rule) and both ids the host's own list uses, so confirm/cancel
 * behave identically inside and outside a submenu.
 */
export class ValuePrompt implements SettingsComponent {
  private readonly deps: ValuePromptDeps;
  private readonly input: { getValue(): string; handleInput(data: string): void; render(width: number): string[]; invalidate(): void };
  private readonly promptLine: string;
  private settled = false;

  constructor(deps: ValuePromptDeps) {
    this.deps = deps;
    // No `placeholder`/`prompt` and no initial value: the input starts empty.
    this.input = new deps.Input();
    this.promptLine = valuePromptText(deps.promptText, deps.currentValue);
  }

  render(width: number): string[] {
    return [this.deps.theme.fg("dim", this.promptLine), ...this.input.render(width)];
  }

  handleInput(data: string): void {
    if (this.settled) return;
    const kb = this.deps.keybindings;
    if (kb.matches(data, "tui.select.confirm")) {
      // Commit the trimmed value. An EMPTY string is meaningful: for a secret
      // field it is the clear path (the write path turns it into `null`,
      // exactly as the dialog form does).
      this.settled = true;
      this.deps.done(this.input.getValue().trim());
      return;
    }
    if (kb.matches(data, "tui.select.cancel")) {
      this.settled = true;
      this.deps.done(); // no value → the host skips onChange entirely
      return;
    }
    this.input.handleInput(data);
  }

  invalidate(): void {
    this.input.invalidate();
  }
}

// ── The settings screen (plan B.1/B.4/B.5) ─────────────────────────────────

/** Rows visible at once — pi's own settings overlay uses the same bound. */
const MAX_VISIBLE = 10;

/**
 * Mount pi's own `SettingsList` as a modal for this extension's twelve fields.
 *
 * Mounting is the caller's decision (plan B.5): this function is only reached
 * on `ctx.mode === "tui"` with the host bridge resolved. Everything it writes
 * goes through the SAME `setConfigField` validator and the SAME routing rule as
 * `/qdrant settings <key> <value>` (handlers.ts `settingsHandler`), so the two
 * surfaces cannot diverge.
 */
export async function openSettingsScreen(io: HandlerIO, host: SettingsHost, mount: MountFn): Promise<void> {
  await mount(({ theme, keybindings, done }) => {
    const items = hostItems(io, host, theme, keybindings);
    // Last value we know is DISPLAYED per row, and therefore the value a
    // rejected write must be rolled back to (the host has already replaced the
    // row's `currentValue` by the time onChange runs).
    const displayed = new Map(items.map((i) => [i.id, i.currentValue]));
    let list: SettingsListInstance | undefined;

    /** Normalise the clear-override entry back to the reserved `default` token,
     *  exactly as the select-based form does. Computed per call from the live
     *  global value so the label can never disagree with what it clears. */
    const normalize = (id: string, newValue: string): string =>
      id === "codeKnowledge" && newValue === resetOptionLabel(io.readGlobalConfig().codeKnowledge)
        ? "default"
        : newValue;

    const onChange = (id: string, rawValue: string): void => {
      const previous = displayed.get(id) ?? "";
      const value = normalize(id, rawValue);
      // A cleared secret is an empty string; the validator only accepts the
      // literal `null` for the nullable keys (config.ts).
      const writeValue = value === "" && isSecretSettingField(id) ? "null" : value;

      // Reserved token: clear the project override (matched BEFORE validation,
      // mirroring settingsHandler — clearing is idempotent by design).
      if (isProjectOverridable(id) && writeValue === "default") {
        const before = io.cfg.codeKnowledge;
        io.clearProjectSetting(id);
        io.emit(message(settingsOverrideClearedText(id, io.readGlobalConfig()[id], maskNote(id, io.env))));
        if (io.cfg.codeKnowledge !== before) io.emit(message(codeMemoryReloadNotice(io.cfg.codeKnowledge)));
        refresh(id);
        return;
      }

      if (!isSettingField(id)) {
        // Unreachable from the list (ids come from SETTING_FIELDS); guarded
        // anyway so an unknown id can never write or corrupt the display.
        io.emit(errorEntry(`error: ${id}`));
        rollback(id, previous);
        return;
      }

      // The ONE validator, shared with the CLI path — never re-implemented.
      const applied = setConfigField(io.readGlobalConfig(), id, writeValue);
      if (!applied.ok) {
        io.emit(errorEntry(`error: ${applied.error}`));
        // MANDATORY: the host mutated `item.currentValue` before calling us, so
        // without this the list would display a value that was never persisted.
        rollback(id, previous);
        return;
      }

      const before = io.cfg.codeKnowledge;
      if (isProjectOverridable(id)) {
        io.writeProjectSettings(projectOverride(applied.next, id));
        io.emit(message(settingsUpdatedText(id, displayOf(id, applied.next), io.readGlobalConfig()[id], maskNote(id, io.env))));
      } else {
        // D10: persist the GLOBAL reader's copy, never the effective config.
        io.writeGlobalConfig(applied.next);
        io.emit(message(settingsGlobalUpdatedText(id)));
        if (id === "mode" && applied.next.mode === "own" && detectBlackhole(io.agentDir)) {
          io.emit(message(modeOwnConflictNotice()));
        }
      }
      if (io.cfg.codeKnowledge !== before) io.emit(message(codeMemoryReloadNotice(io.cfg.codeKnowledge)));
      refresh(id);
    };

    /** Put the row's post-write value back, from the freshly written config. */
    const refresh = (id: string): void => {
      if (!isSettingField(id)) return;
      const next = displayOf(id, io.cfg);
      displayed.set(id, next);
      // Also the row the host just filled with the typed value — for a secret
      // that is the credential itself, so this call is what keeps it off screen.
      list?.updateValue(id, next);
    };

    const rollback = (id: string, previous: string): void => {
      displayed.set(id, previous);
      list?.updateValue(id, previous);
    };

    list = new host.SettingsList(
      items,
      Math.min(items.length, MAX_VISIBLE),
      host.getSettingsListTheme(),
      onChange,
      () => {
        // Esc: close the modal and say so (#58 — no silent exit).
        io.emit(message(settingsCancelledText()));
        done();
      },
      { enableSearch: true },
    );

    return new SettingsScreen(list, host, theme);
  });
}

/** Build the host rows: the pure mapping plus a `submenu` factory for every
 *  field whose editor is the `ValuePrompt`. */
function hostItems(
  io: HandlerIO,
  host: SettingsHost,
  theme: ThemeLike,
  keybindings: KeybindingsLike,
): HostSettingItem[] {
  const mapped = buildSettingItems({
    cfg: io.cfg,
    global: io.readGlobalConfig(),
    project: io.readProjectSettings(),
    env: io.env,
  });
  return mapped.map((item): HostSettingItem => {
    const promptText = item.prompt;
    const row: HostSettingItem = {
      id: item.id,
      label: item.label,
      ...(item.description === undefined ? {} : { description: item.description }),
      currentValue: item.currentValue,
      ...(item.values === undefined ? {} : { values: item.values }),
    };
    if (promptText === undefined) return row;
    return {
      ...row,
      submenu: (currentValue: string, done: (selectedValue?: string) => void) =>
        new ValuePrompt({
          Input: host.Input,
          theme,
          keybindings,
          promptText,
          currentValue,
          done,
        }),
    };
  });
}

/**
 * The mounted component: the list, framed by the same `DynamicBorder` pi's own
 * settings overlay uses, plus a one-line key hint.
 *
 * It holds no key logic of its own — `SettingsList` decodes its own keys and
 * `ValuePrompt` decodes its submenu's — and `dispose` is deliberately absent:
 * nothing here was allocated beyond the two host components, both of which the
 * host owns.
 */
class SettingsScreen implements SettingsComponent {
  private readonly list: SettingsListInstance;
  private readonly host: SettingsHost;
  private readonly theme: ThemeLike;
  private readonly border: EntryComponent | undefined;

  constructor(list: SettingsListInstance, host: SettingsHost, theme: ThemeLike) {
    this.list = list;
    this.host = host;
    this.theme = theme;
    this.border = host.DynamicBorder ? new host.DynamicBorder() : undefined;
  }

  render(width: number): string[] {
    const lines = this.list.render(width);
    const hint = this.hintLine();
    if (!this.border) return hint === undefined ? lines : [...lines, hint];
    return [
      ...this.border.render(width),
      ...lines,
      ...(hint === undefined ? [] : [hint]),
      ...this.border.render(width),
    ];
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
    this.border?.invalidate();
  }

  /**
   * The one hint line, worded by out.ts and labelled by the host's own
   * `keyText`. Omitted entirely when `keyText` has not resolved: an invented
   * key name would be worse than no hint.
   */
  private hintLine(): string | undefined {
    const keyText = this.host.keyText;
    if (!keyText) return undefined;
    try {
      return this.theme.fg("dim", settingsScreenHintText({
        confirm: keyText("tui.select.confirm"),
        cancel: keyText("tui.select.cancel"),
      }));
    } catch {
      return undefined;
    }
  }
}

export type { SettingsHost, SettingsListCtor };
