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

/**
 * Expand a leading `~` the way the host does — `host`'s `expandTildePath` is
 * `normalizePath(path)` with default options, whose only path-shaping step for
 * an env var is tilde expansion (`dist/config.js:437`, `dist/utils/paths.js`).
 * Kept identical here for the three cases that matter:
 *   `~`          → homedir()
 *   `~/x` (or `~\x` on win32) → join(homedir(), "x")
 *   anything else → the value verbatim
 * Pure string work: no fs call, so it never creates a directory named `~`.
 */
export function expandAgentDir(value: string, home: string = homedir()): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return join(home, value.slice(2));
  }
  return value;
}

/**
 * The pure, injectable agent-dir seam: no host package, no I/O, unit-testable
 * under plain node. `factory` prefers the host's own accessor (below) and falls
 * back to this when the package does not resolve.
 */
export function agentDirFromEnv(env: NodeJS.ProcessEnv): string {
  if (env.PI_CODING_AGENT_DIR) return expandAgentDir(env.PI_CODING_AGENT_DIR);
  return join(homedir(), ".pi", "agent");
}

/**
 * The host's `getAgentDir()`, imported lazily and cached (#60).
 *
 * Why lazily: pi's loader aliases `@earendil-works/pi-coding-agent` for
 * extensions, but a plain-node test run never resolves it, and a top-level
 * import would make every unit test in this repo depend on the host being
 * installed. Same guarded pattern as `entry-render.ts`'s `keyHint`.
 *
 * Returns `undefined` when the host package is unavailable or does not expose
 * the accessor — the caller then uses `agentDirFromEnv(process.env)`, which
 * agrees with the host on every case except a non-default `piConfig.configDir`
 * (the host reads `ENV_AGENT_DIR` from its own resolved `APP_NAME`). Never
 * throws: a broken host install must not take the extension down with it.
 */
let hostAgentDir: string | undefined;
let hostAgentDirTried = false;

export async function loadHostAgentDir(): Promise<string | undefined> {
  if (hostAgentDirTried) return hostAgentDir;
  hostAgentDirTried = true;
  try {
    // SAFETY: the import is ambient (src/pi-coding-agent.d.ts declares keyHint
    // only) — read getAgentDir through a structural cast, like entry-render.ts.
    const agent = (await import("@earendil-works/pi-coding-agent")) as unknown as {
      getAgentDir?: () => string;
    };
    const dir = agent.getAgentDir?.();
    if (typeof dir === "string" && dir !== "") hostAgentDir = dir;
  } catch {
    // No host package under plain node: the pure seam's fallback stands.
  }
  return hostAgentDir;
}

/** Test-only reset of the module-level cache (the lazy import is process-wide). */
export function resetHostAgentDirCache(): void {
  hostAgentDirTried = false;
  hostAgentDir = undefined;
}
