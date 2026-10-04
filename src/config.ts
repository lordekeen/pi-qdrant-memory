import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CodeKnowledgeMode, Config, ConfigMode, MemoryForgetMode } from "./types.ts";

export const DEFAULTS: Config = {
  qdrantUrl: "http://localhost:6333",
  qdrantApiKey: null,
  embeddingBaseURL: "http://localhost:8080/v1",
  embeddingModel: "nomic-embed-text",
  embeddingApiKey: null,
  expectedDimension: 768,
  scoreThreshold: 0.18,
  maxResults: 10,
  mode: "auto",
  codeKnowledge: "off",
  codeScoreThreshold: 0.55,
  memoryForget: "off",
};

/** Every editable config key, in the stable order the settings surface uses.
 *  The settings form walks this list and the `/qdrant settings` grammar
 *  completes exactly these names as its bounded key token; each key's rules
 *  (env var, validation, override eligibility) live in the field table below. */
export const SETTING_FIELDS = [
  "mode",
  "codeKnowledge",
  "memoryForget",
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

export type SettingField = (typeof SETTING_FIELDS)[number];

export function configPath(agentDir: string): string {
  return join(agentDir, "pi-qdrant-memory", "pi-qdrant-memory-config.json");
}

/**
 * The one atomic-write discipline every JSON file this extension owns shares
 * (global config, per-project store, extension state — #57).
 *
 * Writes `<target>.tmp` **in the same directory** and `rename`s it over the
 * target. Same directory matters: `rename` is atomic only within a filesystem,
 * and a sibling keeps the target's directory entry in place. A crash, a full
 * disk or a concurrent reader can therefore only ever observe the old complete
 * file or the new complete file, never a truncated one.
 *
 * Owner-only permissions are kept: the config file stores API keys, the store
 * and state files keep the same discipline for consistency. The temp file is
 * chmod'ed before the rename (a stale `.tmp` from an earlier crash keeps its
 * old mode otherwise) and the target once more after, so a previously loosened
 * file is tightened on the next save.
 *
 * Throws on failure — callers decide. The temp file is removed best-effort so a
 * failed write never leaves `<target>.tmp` behind.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* best-effort: creation mode already set */ }
    renameSync(tmp, file);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best-effort: the write already failed */ }
    throw err;
  }
  try { chmodSync(file, 0o600); } catch { /* best-effort: the rename carried the temp file's mode */ }
}

/** Persist a full config back to the canonical JSON file (mkdir -p,
 * temp-then-rename). The file stores API keys, so it is owner-only (0o600).
 * See `writeJsonAtomic` for the atomicity and mode discipline. */
export function writeConfigFile(agentDir: string, cfg: Config): void {
  writeJsonAtomic(configPath(agentDir), cfg);
}

export function isConfigMode(v: string | undefined): v is ConfigMode {
  return v === "auto" || v === "blackhole" || v === "own";
}

export function isConfigKnowledge(v: string | undefined): v is CodeKnowledgeMode {
  return v === "off" || v === "on";
}

export function isConfigForget(v: string | undefined): v is MemoryForgetMode {
  return v === "off" || v === "on";
}

/** The env layer's answer for one field.
 *  - `usable: true` — the variable supplied this layer's value, parsed to
 *    `value` (`raw` keeps the string the mask note reports).
 *  - `usable: false; consumed: true` — the variable is present but unparsable:
 *    it still wins the layer slot and resolves to `DEFAULTS`, never falling
 *    through to the file. This is the pre-table `numEnv` rule, preserved. */
type EnvLayer<V> = { usable: true; raw: string; value: V } | { usable: false; consumed: boolean };

/** `setConfigField`'s answer: the typed value, or the exact error string the
 *  user sees. */
type FieldValidation<V> = { ok: true; value: V } | { ok: false; error: string };

/** One row of the config metadata table. */
interface FieldSpec<K extends keyof Config, V = Config[K]> {
  /** The `Config` key this row describes. */
  readonly field: K;
  /** The env variable that overrides it. */
  readonly env: string;
  /** May the project store carry an override for it (spec D1)? */
  readonly projectOverridable?: boolean;
  /** The env layer rule — usability + parse, shared by `readGlobalConfig`,
   *  `readEffectiveConfig`'s gap check and `envMask`. */
  envValue(raw: string | undefined): EnvLayer<V>;
  /** The file layer rule: `undefined` means "not usable", fall to DEFAULTS. */
  fileValue(raw: unknown): V | undefined;
  /** The CLI rule (`setConfigField`), shared with the settings form. */
  validate(raw: string): FieldValidation<V>;
}

/** Plain string field. `??` semantics: any env value (even "") is usable, and
 *  every non-nullish file value passes through. A string field set to the
 *  literal "null" is rejected — it would silently revert to DEFAULTS on the
 *  next load while the form still displays null. */
function stringSpec<K extends keyof Config>(field: K, env: string): FieldSpec<K, string> {
  return {
    field,
    env,
    envValue: (raw) => (raw === undefined ? { usable: false, consumed: false } : { usable: true, raw, value: raw }),
    // SAFETY: mirrors the unchecked `??` read this replaced — a hand-edited
    // non-string file value passes through exactly as it always did.
    fileValue: (raw) => (raw === undefined || raw === null ? undefined : (raw as string)),
    validate: (raw) => (raw === "null"
      ? { ok: false, error: `settings: ${field} cannot be null` }
      : { ok: true, value: raw }),
  };
}

/** Nullable string field (the two API keys): `"null"` is a valid CLI value
 *  that clears the key (the form's empty-input clear normalizes to it). */
function apiKeySpec<K extends keyof Config>(field: K, env: string): FieldSpec<K, string | null> {
  return {
    field,
    env,
    envValue: (raw) => (raw === undefined ? { usable: false, consumed: false } : { usable: true, raw, value: raw }),
    // SAFETY: same pass-through rule as `stringSpec` (see there).
    fileValue: (raw) => (raw === undefined || raw === null ? undefined : (raw as string)),
    validate: (raw) => ({ ok: true, value: raw === "null" ? null : raw }),
  };
}

/** Numeric field; `rule` carries the exact range/integrality check and error. */
function numberSpec<K extends keyof Config>(
  field: K,
  env: string,
  rule: "positive-integer" | "unit-interval",
): FieldSpec<K, number> {
  const coerce = (raw: unknown): number | undefined => {
    // Coerce string/number env or file values; non-finite values are unusable
    // so a corrupt file never leaks a string into a numeric config field.
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const valid = (n: number): boolean => (rule === "positive-integer" ? Number.isInteger(n) && n > 0 : n >= 0 && n <= 1);
  const rangeError = rule === "positive-integer"
    ? `settings: ${field} expects a positive integer`
    : `settings: ${field} expects a number between 0 and 1`;
  return {
    field,
    env,
    envValue: (raw) => {
      if (raw === undefined) return { usable: false, consumed: false };
      const n = coerce(raw);
      // Pre-table `numEnv` rule: a present-but-unparsable env var still wins
      // the layer slot and resolves to DEFAULTS — the file is never consulted.
      return n === undefined ? { usable: false, consumed: true } : { usable: true, raw, value: n };
    },
    fileValue: (raw) => (raw === undefined ? undefined : coerce(raw)),
    validate: (raw) => {
      const n = coerce(raw);
      if (n === undefined) return { ok: false, error: `settings: ${field} expects a number` };
      return valid(n) ? { ok: true, value: n } : { ok: false, error: rangeError };
    },
  };
}

/** Enum field: a value is usable only when the guard accepts it; an unusable
 *  value falls through the layer (env → file → DEFAULTS). `options` is the
 *  message's option list, so the error text stays exact. */
function enumSpec<K extends keyof Config, V extends string>(
  field: K,
  env: string,
  options: readonly string[],
  is: (v: string | undefined) => v is V,
): FieldSpec<K, V> {
  return {
    field,
    env,
    envValue: (raw) => (is(raw) ? { usable: true, raw, value: raw } : { usable: false, consumed: false }),
    fileValue: (raw) => (typeof raw === "string" && is(raw) ? raw : undefined),
    validate: (raw) => (is(raw)
      ? { ok: true, value: raw }
      : { ok: false, error: `settings: ${field} must be one of ${options.join(" | ")}` }),
  };
}

/** Mark a row project-overridable (spec D1). The literal `true` survives in the
 *  row's type, so `ProjectOverridableField` and `PROJECT_OVERRIDABLE_FIELDS`
 *  derive from the table instead of being re-listed. */
function overridable<K extends keyof Config, V>(
  spec: FieldSpec<K, V>,
): FieldSpec<K, V> & { readonly projectOverridable: true } {
  return { ...spec, projectOverridable: true };
}

/**
 * The one config metadata table: every `Config` key → its env var, env-value
 * usability/parse rule, CLI validation rule and project-override eligibility.
 * `readGlobalConfig`, `readEffectiveConfig`, `envMask` and `setConfigField` all
 * read their per-field rules from here — the three hand-maintained copies this
 * table replaced can no longer drift apart.
 *
 * Declaration order is meaningful: it drives the derived
 * `PROJECT_OVERRIDABLE_FIELDS` (project-settings.ts, spec D1).
 */
export const CONFIG_FIELD_SPECS = {
  qdrantUrl: stringSpec("qdrantUrl", "PI_QDRANT_URL"),
  qdrantApiKey: apiKeySpec("qdrantApiKey", "PI_QDRANT_API_KEY"),
  embeddingBaseURL: stringSpec("embeddingBaseURL", "PI_QDRANT_EMBEDDING_BASE_URL"),
  embeddingModel: stringSpec("embeddingModel", "PI_QDRANT_EMBEDDING_MODEL"),
  embeddingApiKey: apiKeySpec("embeddingApiKey", "PI_QDRANT_EMBEDDING_API_KEY"),
  expectedDimension: numberSpec("expectedDimension", "PI_QDRANT_EXPECTED_DIMENSION", "positive-integer"),
  scoreThreshold: numberSpec("scoreThreshold", "PI_QDRANT_SCORE_THRESHOLD", "unit-interval"),
  maxResults: numberSpec("maxResults", "PI_QDRANT_MAX_RESULTS", "positive-integer"),
  mode: enumSpec("mode", "PI_QDRANT_MODE", ["auto", "blackhole", "own"], isConfigMode),
  codeKnowledge: overridable(enumSpec("codeKnowledge", "PI_QDRANT_CODE_KNOWLEDGE", ["off", "on"], isConfigKnowledge)),
  codeScoreThreshold: overridable(numberSpec("codeScoreThreshold", "PI_QDRANT_CODE_SCORE_THRESHOLD", "unit-interval")),
  memoryForget: enumSpec("memoryForget", "PI_QDRANT_MEMORY_FORGET", ["off", "on"], isConfigForget),
} satisfies { [K in keyof Config]: FieldSpec<K, Config[K]> };

/**
 * Apply a validated `field = value` write to a config copy. Shared by the CLI
 * (`/qdrant settings <key> <value>`) and the interactive form so both accept and
 * reject exactly the same values. `value` is always a raw string from the user;
 * the field's rule comes from `CONFIG_FIELD_SPECS`.
 */
export function setConfigField(
  cfg: Config,
  field: string,
  value: string,
): { ok: true; next: Config } | { ok: false; error: string } {
  if (!Object.hasOwn(CONFIG_FIELD_SPECS, field)) return { ok: false, error: `settings: unknown key ${field}` };
  // SAFETY: `Object.hasOwn` was just verified and the table is a total map over
  // Config's keys, so this lookup is the field's own row.
  const spec = CONFIG_FIELD_SPECS[field as keyof Config];
  const validated = spec.validate(value);
  if (!validated.ok) return { ok: false, error: validated.error };
  // SAFETY: the row validates the key it was found under and returns exactly
  // that key's declared Config type.
  return { ok: true, next: { ...cfg, [field]: validated.value } as Config };
}

/**
 * #57: a *missing* config file is the normal first-run state and stays silent,
 * but a file that EXISTS and does not parse is a fault the user cannot see —
 * every setting silently reverts to `DEFAULTS`. The reader keeps the safe
 * default either way and records the path here; `takeLoadWarnings` drains the
 * queue so the lifecycle layer can surface it once as a message entry.
 *
 * Deduped by path, so a corrupt file is reported at most once per process even
 * though the effective reader runs on every settings write and session start.
 */
let loadWarnings: string[] = [];
const warnedPaths = new Set<string>();

export function recordLoadWarning(file: string): void {
  if (warnedPaths.has(file)) return;
  warnedPaths.add(file);
  loadWarnings.push(file);
}

/** Drain the pending corrupt-file paths and hand ownership to the caller.
 * Deliberately a drain rather than a subscription: the reader modules stay
 * free of output channels, and the single consumer (session_start) decides both
 * when and whether the warning is shown. */
export function takeLoadWarnings(): string[] {
  if (loadWarnings.length === 0) return [];
  const drained = loadWarnings;
  loadWarnings = [];
  return drained;
}

/** Parse the global config file. A missing file is the normal first-run state
 * (silent); a file that exists but does not parse as a settings object is a
 * fault the user cannot see, so its path is recorded in the warning queue. */
function readConfigObject(agentDir: string): Partial<Config> {
  const file = configPath(agentDir);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Config>;
    // An array is `typeof "object"`, so it needs its own rejection — it is a
    // valid JSON document that is simply not a settings object.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    recordLoadWarning(file); // present but not a settings object (e.g. a JSON array)
  } catch {
    // Corrupt file: fall through to defaults + env, never crash at load —
    // but say so, so the silent revert is visible (#57).
    recordLoadWarning(file);
  }
  return {};
}

/** The global-layer read for one field (env → file → DEFAULTS), driven by the
 *  field's table row. `consumed` keeps the pre-table `numEnv` rule: an env
 *  value that is present but unparsable resolves to DEFAULTS, not the file. */
function resolveGlobalField<K extends keyof Config>(
  key: K,
  env: NodeJS.ProcessEnv,
  file: Partial<Config>,
): Config[K] {
  // SAFETY: the table is a total map over Config's keys, so the row at `key`
  // describes exactly this field.
  const spec = CONFIG_FIELD_SPECS[key] as FieldSpec<K, Config[K]>;
  const fromEnv = spec.envValue(env[spec.env]);
  if (fromEnv.usable) return fromEnv.value;
  if (fromEnv.consumed) return DEFAULTS[spec.field];
  const fromFile = spec.fileValue(file[spec.field]);
  return fromFile === undefined ? DEFAULTS[spec.field] : fromFile;
}

/** The **global** layer reader: `DEFAULTS` → global config file → env, per field
 * (the field table supplies each field's env var and parse/usability rule).
 * It knows nothing about projects — the project layer is applied by
 * `readEffectiveConfig` in `src/project-settings.ts` (one-directional imports:
 * `config.ts` ← `project-settings.ts`, no ESM cycle). */
export function readGlobalConfig(agentDir: string, env: NodeJS.ProcessEnv = process.env): Config {
  const file = readConfigObject(agentDir);
  return {
    qdrantUrl: resolveGlobalField("qdrantUrl", env, file),
    qdrantApiKey: resolveGlobalField("qdrantApiKey", env, file),
    embeddingBaseURL: resolveGlobalField("embeddingBaseURL", env, file),
    embeddingModel: resolveGlobalField("embeddingModel", env, file),
    embeddingApiKey: resolveGlobalField("embeddingApiKey", env, file),
    expectedDimension: resolveGlobalField("expectedDimension", env, file),
    scoreThreshold: resolveGlobalField("scoreThreshold", env, file),
    maxResults: resolveGlobalField("maxResults", env, file),
    mode: resolveGlobalField("mode", env, file),
    codeKnowledge: resolveGlobalField("codeKnowledge", env, file),
    codeScoreThreshold: resolveGlobalField("codeScoreThreshold", env, file),
    memoryForget: resolveGlobalField("memoryForget", env, file),
  };
}

/** Historical name: identical function. New code calls `readGlobalConfig`. */
export const loadConfig = readGlobalConfig;
