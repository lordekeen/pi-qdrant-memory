import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULTS, isConfigKnowledge, readGlobalConfig, setConfigField } from "./config.ts";
import type { Config } from "./types.ts";

/** The only Config keys a project may override (spec D1). Growing this list is
 * a one-line change: storage and precedence already handle it. */
export const PROJECT_OVERRIDABLE_FIELDS = ["codeKnowledge", "codeScoreThreshold"] as const;
export type ProjectOverridableField = (typeof PROJECT_OVERRIDABLE_FIELDS)[number];
/** A partial config: an absent key means "no override" (spec D2). */
export type ProjectSettings = Partial<Pick<Config, ProjectOverridableField>>;

/** projectIdFrom / projectIdFromPath emit exactly this shape (src/project.ts). */
const PROJECT_ID_RE = /^pi-mem-[0-9a-f]{16}$/;

export function isProjectOverridable(field: string): field is ProjectOverridableField {
  return (PROJECT_OVERRIDABLE_FIELDS as readonly string[]).includes(field);
}

export function projectsDir(agentDir: string): string {
  return join(agentDir, "pi-qdrant-memory", "projects");
}

export function projectSettingsPath(agentDir: string, projectId: string): string {
  return join(projectsDir(agentDir), `${projectId}.json`);
}

/** Tolerant reader (spec D2/D8): a missing, unreadable, corrupt or non-object
 * file is "no overrides" — never a throw. Keys are allowlist-gated and values
 * are validated through the *shared* `setConfigField` against `DEFAULTS`, so a
 * hand-edited value can never be looser than one typed at the CLI: `2.0`,
 * `"abc"`, `null` and `false` are dropped per key, while `"0.6"` is coerced to
 * the number `0.6` exactly as `numEnv` coerces the global file. */
export function loadProjectSettings(agentDir: string, projectId: string): ProjectSettings {
  if (!PROJECT_ID_RE.test(projectId)) return {};
  const file = projectSettingsPath(agentDir, projectId);
  if (!existsSync(file)) return {};
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: ProjectSettings = {};
  for (const key of PROJECT_OVERRIDABLE_FIELDS) {
    if (!(key in src)) continue;
    // `String(...)` mirrors numEnv's coercion: "0.6" becomes the number 0.6;
    // 2.0 / "abc" / null / false fail validation and are dropped per key.
    const validated = setConfigField(DEFAULTS, key, String(src[key]));
    if (!validated.ok) continue;
    if (key === "codeKnowledge") out.codeKnowledge = validated.next.codeKnowledge;
    else out.codeScoreThreshold = validated.next.codeScoreThreshold;
  }
  return out;
}

/** Persist a partial config to the project store (spec D2). Mirrors
 * `writeConfigFile`'s mode discipline: mkdir -p, create with 0o600, then a
 * forced best-effort chmod so a previously loosened file is tightened. The
 * write is a read-modify-write of the stored partial (a sibling key is never
 * clobbered). Keys are guarded at runtime: a non-allowlisted key can never be
 * persisted, so an infrastructure override cannot activate even via a buggy or
 * future call site. */
export function saveProjectSettings(agentDir: string, projectId: string, next: ProjectSettings): void {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error(`pi-qdrant-memory: refusing project id outside the generated shape: ${projectId}`);
  }
  for (const key of Object.keys(next)) {
    if (!isProjectOverridable(key)) {
      throw new Error(
        `pi-qdrant-memory: ${key} is not project-overridable (allowlist: ${PROJECT_OVERRIDABLE_FIELDS.join(", ")})`,
      );
    }
  }
  const merged: ProjectSettings = { ...loadProjectSettings(agentDir, projectId), ...defined(next) };
  writeStoreFile(agentDir, projectId, merged);
}

/** Remove one allowlisted override. Deletes the store file when the object
 * empties, so `projects/` reflects only live overrides (spec D2). An absent
 * key (or an id outside the generated shape) is a no-op. */
export function clearProjectField(
  agentDir: string,
  projectId: string,
  field: ProjectOverridableField,
): void {
  if (!PROJECT_ID_RE.test(projectId)) return;
  const current = loadProjectSettings(agentDir, projectId);
  if (!(field in current)) return;
  const merged: ProjectSettings = { ...current };
  delete merged[field];
  if (Object.keys(merged).length === 0) {
    rmSync(projectSettingsPath(agentDir, projectId), { force: true });
    return;
  }
  writeStoreFile(agentDir, projectId, merged);
}

/** Drop keys explicitly set to `undefined` so the emptiness check above and the
 * serialized JSON agree on what an override is. */
function defined(next: ProjectSettings): ProjectSettings {
  const out: ProjectSettings = {};
  for (const key of PROJECT_OVERRIDABLE_FIELDS) {
    const v = next[key];
    if (v === undefined) continue;
    if (key === "codeKnowledge") out.codeKnowledge = v as ProjectSettings["codeKnowledge"];
    else out.codeScoreThreshold = v as ProjectSettings["codeScoreThreshold"];
  }
  return out;
}

function writeStoreFile(agentDir: string, projectId: string, settings: ProjectSettings): void {
  const file = projectSettingsPath(agentDir, projectId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best-effort: creation mode already set */ }
}

/**
 * Effective config (spec D3): env → project override → global file → DEFAULTS,
 * per field, the project layer only for allowlisted keys. Local disk only,
 * never throws, never touches the network (spec D9).
 *
 * It lives here rather than in `config.ts` deliberately (plan refinement 1):
 * `loadProjectSettings` needs `setConfigField`/`DEFAULTS` from config.ts, so
 * hosting both there would create a runtime ESM import cycle. Imports run one
 * way: `config.ts` ← `project-settings.ts`.
 */
export function readEffectiveConfig(
  agentDir: string,
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): Config {
  // A fresh object every call, so mutating it never touches `DEFAULTS`.
  const cfg = readGlobalConfig(agentDir, env);
  const over = loadProjectSettings(agentDir, projectId);
  // readGlobalConfig already applied env-over-file-over-defaults. The project
  // layer fills the gap only where env supplied nothing *usable*: an invalid
  // env value falls through there, so it must not mask the override either.
  if (!isConfigKnowledge(env.PI_QDRANT_CODE_KNOWLEDGE) && over.codeKnowledge !== undefined) {
    cfg.codeKnowledge = over.codeKnowledge;
  }
  const rawThreshold = env.PI_QDRANT_CODE_SCORE_THRESHOLD;
  const envPinsThreshold = rawThreshold !== undefined && Number.isFinite(Number(rawThreshold));
  if (!envPinsThreshold && over.codeScoreThreshold !== undefined) {
    cfg.codeScoreThreshold = over.codeScoreThreshold;
  }
  return cfg;
}
