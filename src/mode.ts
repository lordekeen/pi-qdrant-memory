import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./types.ts";

export function blackholeConfigPath(agentDir: string): string {
  return join(agentDir, "pi-blackhole", "pi-blackhole-config.json");
}

export function isBlackholeOperational(cfg: unknown): boolean {
  if (typeof cfg !== "object" || cfg === null) return false;
  const c = cfg as Record<string, unknown>;
  if (c.compactionEngine === "blackhole") return true;
  if (c.enabled === false) return false;
  if (typeof c.enabled === "boolean") return c.enabled;
  return false;
}

export function detectBlackhole(agentDir: string): boolean {
  const p = blackholeConfigPath(agentDir);
  if (!existsSync(p)) return false;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return isBlackholeOperational(parsed);
  } catch {
    return false;
  }
}

export function resolveMode(cfg: Config, blackholePresent: boolean): "mode1" | "mode2" {
  if (cfg.mode === "blackhole") return "mode1";
  if (cfg.mode === "own") return "mode2";
  return blackholePresent ? "mode1" : "mode2";
}

export function agentDirFromEnv(env: NodeJS.ProcessEnv): string {
  if (env.PI_CODING_AGENT_DIR) return env.PI_CODING_AGENT_DIR;
  return join(homedir(), ".pi", "agent");
}
