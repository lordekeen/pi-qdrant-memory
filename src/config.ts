import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CodeKnowledgeMode, Config, ConfigMode } from "./types.ts";

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
};

export function configPath(agentDir: string): string {
  return join(agentDir, "pi-qdrant-memory", "pi-qdrant-memory-config.json");
}

/** Persist a full config back to the canonical JSON file (mkdir -p).
 *
 * The file stores API keys, so it is created with owner-only permissions
 * (0o600). `writeFileSync`'s `mode` only applies at creation; an existing,
 * more-open file keeps its mode — chmod is forced so a previously created
 * world-readable file is tightened on the next save.
 */
export function writeConfigFile(agentDir: string, cfg: Config): void {
  const file = configPath(agentDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best-effort: creation mode already set */ }
}

export function isConfigMode(v: string | undefined): v is ConfigMode {
  return v === "auto" || v === "blackhole" || v === "own";
}

export function isConfigKnowledge(v: string | undefined): v is CodeKnowledgeMode {
  return v === "off" || v === "on";
}

/**
 * Apply a validated `field = value` write to a config copy. Shared by the CLI
 * (`/qdrant-settings <key> <value>`) and the interactive form so both accept and
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
      if (parsed && typeof parsed === "object") fromFile = parsed;
    } catch {
      // corrupt file: fall through to defaults + env; never crash at load
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
  };
}

/** Historical name: identical function. New code calls `readGlobalConfig`. */
export const loadConfig = readGlobalConfig;
