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
 *  The single definition: `setConfigField` validates against the `Config` keys,
 *  the settings form walks this list, and the `/qdrant settings` grammar
 *  completes exactly these names as its bounded key token. */
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

/**
 * Apply a validated `field = value` write to a config copy. Shared by the CLI
 * (`/qdrant settings <key> <value>`) and the interactive form so both accept and
 * reject exactly the same values. `value` is always a raw string from the user.
 */
export function setConfigField(
  cfg: Config,
  field: string,
  value: string,
): { ok: true; next: Config } | { ok: false; error: string } {
  if (!(field in cfg)) return { ok: false, error: `settings: unknown key ${field}` };
  // SAFETY: `field in cfg` was just verified, so the key exists on Config and its
  // value is string | number | null — the Record projection cannot read out of bounds.
  const cur = (cfg as unknown as Record<string, unknown>)[field];
  // SAFETY: same key-verified invariant as above; the copy keeps Config's value types.
  const next = { ...cfg } as unknown as Record<string, unknown>;
  if (field === "mode") {
    if (!isConfigMode(value)) return { ok: false, error: "settings: mode must be one of auto | blackhole | own" };
    next[field] = value;
  } else if (field === "codeKnowledge") {
    if (!isConfigKnowledge(value)) return { ok: false, error: "settings: codeKnowledge must be one of off | on" };
    next[field] = value;
  } else if (field === "memoryForget") {
    if (!isConfigForget(value)) return { ok: false, error: "settings: memoryForget must be one of off | on" };
    next[field] = value;
  } else if (typeof cur === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: `settings: ${field} expects a number` };
    if ((field === "expectedDimension" || field === "maxResults") && !(Number.isInteger(n) && n > 0)) {
      return { ok: false, error: `settings: ${field} expects a positive integer` };
    }
    if ((field === "scoreThreshold" || field === "codeScoreThreshold") && !(n >= 0 && n <= 1)) {
      return { ok: false, error: `settings: ${field} expects a number between 0 and 1` };
    }
    next[field] = n;
  } else {
    // Only the two API-key fields are nullable; a URL/model field set to the
    // literal "null" would silently revert to the default on the next load
    // while the form still displays null — reject it instead.
    const nullable = field === "qdrantApiKey" || field === "embeddingApiKey";
    if (value === "null" && !nullable) {
      return { ok: false, error: `settings: ${field} cannot be null` };
    }
    next[field] = value === "null" ? null : value;
  }
  // SAFETY: every field was validated above (mode via isConfigMode, numbers via
  // the numeric branch, strings via the nullable branch) and matches Config's
  // declared type for that key.
  return { ok: true, next: next as unknown as Config };
}

function numEnv(raw: string | undefined, fileValue: unknown, def: number): number {
  // Coerce string/number file or env values; non-finite values fall back to `def`
  // so a corrupt file never leaks a string into a numeric config field.
  const src = raw !== undefined ? raw : fileValue !== undefined ? fileValue : def;
  const n = typeof src === "number" ? src : Number(src);
  return Number.isFinite(n) ? n : def;
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

/** The **global** layer reader: `DEFAULTS` → global config file → env, per field.
 * It knows nothing about projects — the project layer is applied by
 * `readEffectiveConfig` in `src/project-settings.ts` (one-directional imports:
 * `config.ts` ← `project-settings.ts`, no ESM cycle). */
export function readGlobalConfig(agentDir: string, env: NodeJS.ProcessEnv = process.env): Config {
  const file = configPath(agentDir);
  let fromFile: Partial<Config> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Config>;
      // An array is `typeof "object"`, so it needs its own rejection — it is a
      // valid JSON document that is simply not a settings object.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fromFile = parsed;
      else recordLoadWarning(file); // present but not a settings object (e.g. a JSON array)
    } catch {
      // Corrupt file: fall through to defaults + env, never crash at load —
      // but say so, so the silent revert is visible (#57).
      recordLoadWarning(file);
    }
  }
  const mode: ConfigMode = isConfigMode(env.PI_QDRANT_MODE)
    ? (env.PI_QDRANT_MODE as ConfigMode)
    : isConfigMode(fromFile.mode) ? (fromFile.mode as ConfigMode) : DEFAULTS.mode;
  const codeKnowledge: CodeKnowledgeMode = isConfigKnowledge(env.PI_QDRANT_CODE_KNOWLEDGE)
    ? (env.PI_QDRANT_CODE_KNOWLEDGE as CodeKnowledgeMode)
    : isConfigKnowledge(fromFile.codeKnowledge)
      ? (fromFile.codeKnowledge as CodeKnowledgeMode)
      : DEFAULTS.codeKnowledge;
  const memoryForget: MemoryForgetMode = isConfigForget(env.PI_QDRANT_MEMORY_FORGET)
    ? (env.PI_QDRANT_MEMORY_FORGET as MemoryForgetMode)
    : isConfigForget(fromFile.memoryForget)
      ? (fromFile.memoryForget as MemoryForgetMode)
      : DEFAULTS.memoryForget;
  return {
    qdrantUrl: env.PI_QDRANT_URL ?? fromFile.qdrantUrl ?? DEFAULTS.qdrantUrl,
    qdrantApiKey: env.PI_QDRANT_API_KEY ?? fromFile.qdrantApiKey ?? DEFAULTS.qdrantApiKey,
    embeddingBaseURL: env.PI_QDRANT_EMBEDDING_BASE_URL ?? fromFile.embeddingBaseURL ?? DEFAULTS.embeddingBaseURL,
    embeddingModel: env.PI_QDRANT_EMBEDDING_MODEL ?? fromFile.embeddingModel ?? DEFAULTS.embeddingModel,
    embeddingApiKey: env.PI_QDRANT_EMBEDDING_API_KEY ?? fromFile.embeddingApiKey ?? DEFAULTS.embeddingApiKey,
    expectedDimension: numEnv(env.PI_QDRANT_EXPECTED_DIMENSION, fromFile.expectedDimension, DEFAULTS.expectedDimension),
    scoreThreshold: numEnv(env.PI_QDRANT_SCORE_THRESHOLD, fromFile.scoreThreshold, DEFAULTS.scoreThreshold),
    maxResults: numEnv(env.PI_QDRANT_MAX_RESULTS, fromFile.maxResults, DEFAULTS.maxResults),
    mode,
    codeKnowledge,
    codeScoreThreshold: numEnv(env.PI_QDRANT_CODE_SCORE_THRESHOLD, fromFile.codeScoreThreshold, DEFAULTS.codeScoreThreshold),
    memoryForget,
  };
}

/** Historical name: identical function. New code calls `readGlobalConfig`. */
export const loadConfig = readGlobalConfig;
