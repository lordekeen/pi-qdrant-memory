/**
 * Settings item mapping for the host `SettingsList` screen (plan Part B.1/B.2).
 *
 * Pure and host-free: it maps an effective/global/project config triple into
 * `SettingItem` rows and nothing else — no pi package is imported, so the
 * mapping is fully unit-testable under plain node. Step 7
 * (`openSettingsScreen`) is the only consumer: it converts the `prompt`
 * markers into `ValuePrompt` submenus and hands the items to `SettingsList`.
 */
import { SETTING_FIELDS } from "./config.ts";
import type { SettingField } from "./config.ts";
import { maskNote } from "./project-settings.ts";
import { displayValue, resetOptionLabel } from "./out.ts";
import type { Config } from "./types.ts";

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
