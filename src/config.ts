import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config, ConfigMode } from "./types.ts";

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
};

export function configPath(agentDir: string): string {
  return join(agentDir, "pi-qdrant-memory", "pi-qdrant-memory-config.json");
}

/** Persist a full config back to the canonical JSON file (mkdir -p). */
export function writeConfigFile(agentDir: string, cfg: Config): void {
  const file = configPath(agentDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

export function isConfigMode(v: string | undefined): v is ConfigMode {
  return v === "auto" || v === "blackhole" || v === "own";
}

function numEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(agentDir: string, env: NodeJS.ProcessEnv = process.env): Config {
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
  return {
    qdrantUrl: env.PI_QDRANT_URL ?? fromFile.qdrantUrl ?? DEFAULTS.qdrantUrl,
    qdrantApiKey: env.PI_QDRANT_API_KEY ?? fromFile.qdrantApiKey ?? DEFAULTS.qdrantApiKey,
    embeddingBaseURL: env.PI_QDRANT_EMBEDDING_BASE_URL ?? fromFile.embeddingBaseURL ?? DEFAULTS.embeddingBaseURL,
    embeddingModel: env.PI_QDRANT_EMBEDDING_MODEL ?? fromFile.embeddingModel ?? DEFAULTS.embeddingModel,
    embeddingApiKey: env.PI_QDRANT_EMBEDDING_API_KEY ?? fromFile.embeddingApiKey ?? DEFAULTS.embeddingApiKey,
    expectedDimension: numEnv(env.PI_QDRANT_EXPECTED_DIMENSION, fromFile.expectedDimension ?? DEFAULTS.expectedDimension),
    scoreThreshold: numEnv(env.PI_QDRANT_SCORE_THRESHOLD, fromFile.scoreThreshold ?? DEFAULTS.scoreThreshold),
    maxResults: numEnv(env.PI_QDRANT_MAX_RESULTS, fromFile.maxResults ?? DEFAULTS.maxResults),
    mode,
  };
}
