import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FIELD_SPECS, DEFAULTS, readGlobalConfig, recordLoadWarning, setConfigField, writeJsonAtomic } from "./config.ts";
import type { Config } from "./types.ts";

/** #57: the corrupt-file warning queue is shared with the global reader, so one
 * drain in the lifecycle layer covers both files. Re-exported here so a caller
 * holding the project store never has to know which reader module owns it. */
export { takeLoadWarnings } from "./config.ts";

/** The only Config keys a project may override (spec D1), derived from the
 * config field table's `projectOverridable` flag — never re-listed here.
 * Order follows the table's declaration order, which storage and display rely on. */
export type ProjectOverridableField = {
  [K in keyof typeof CONFIG_FIELD_SPECS]: (typeof CONFIG_FIELD_SPECS)[K] extends { readonly projectOverridable: true }
    ? K
    : never;
}[keyof typeof CONFIG_FIELD_SPECS];
export const PROJECT_OVERRIDABLE_FIELDS: readonly ProjectOverridableField[] = (
  // SAFETY: `Object.keys` of the total table yields exactly its Config keys.
  Object.keys(CONFIG_FIELD_SPECS) as Array<keyof typeof CONFIG_FIELD_SPECS>
).filter((key): key is ProjectOverridableField => CONFIG_FIELD_SPECS[key].projectOverridable === true);
/** A partial config: an absent key means "no override" (spec D2). */
export type ProjectSettings = Partial<Pick<Config, ProjectOverridableField>>;

/** projectIdFrom / projectIdFromPath emit exactly this shape (src/project.ts). */
const PROJECT_ID_RE = /^pi-mem-[0-9a-f]{16}$/;

export function isProjectOverridable(field: string): field is ProjectOverridableField {
  return (PROJECT_OVERRIDABLE_FIELDS as readonly string[]).includes(field);
}

/** Copy one allowlisted field onto a store/config view. `K` correlates the key
 *  and the value type, so neither call site needs a cast. */
function assignOverride<K extends ProjectOverridableField>(
  target: ProjectSettings,
  field: K,
  value: Config[K] | undefined,
): void {
  if (value === undefined) return;
  target[field] = value;
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
 * the number `0.6` exactly as the table's numeric env/file rule coerces the
 * global file. */
export function loadProjectSettings(agentDir: string, projectId: string): ProjectSettings {
  if (!PROJECT_ID_RE.test(projectId)) return {};
  const file = projectSettingsPath(agentDir, projectId);
  if (!existsSync(file)) return {};
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch {
    // Corrupt file: "no overrides" is the safe answer, and the path is reported
    // so the override does not vanish without a trace (#57).
    recordLoadWarning(file);
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { recordLoadWarning(file); return {}; }
  const src = raw as Record<string, unknown>;
  const out: ProjectSettings = {};
  for (const key of PROJECT_OVERRIDABLE_FIELDS) {
    if (!(key in src)) continue;
    // `String(...)` mirrors the table's numeric coercion: "0.6" becomes the number 0.6;
    // 2.0 / "abc" / null / false fail validation and are dropped per key.
    const validated = setConfigField(DEFAULTS, key, String(src[key]));
    if (!validated.ok) continue;
    assignOverride(out, key, validated.next[key]);
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
  for (const key of PROJECT_OVERRIDABLE_FIELDS) assignOverride(out, key, next[key]);
  return out;
}

function writeStoreFile(agentDir: string, projectId: string, settings: ProjectSettings): void {
  // Temp-then-rename, shared with the global config writer: a partial write
  // would leave a file that parses as *some* overrides and silently applies a
  // half-saved state (#57). Same 0o600 discipline — see `writeJsonAtomic`.
  writeJsonAtomic(projectSettingsPath(agentDir, projectId), settings);
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
  // layer fills the gap only where the env layer supplied nothing *usable*,
  // per the field's table row: an invalid env value falls through there, so it
  // must not mask the override either.
  for (const field of PROJECT_OVERRIDABLE_FIELDS) {
    const spec = CONFIG_FIELD_SPECS[field];
    if (spec.envValue(env[spec.env]).usable) continue;
    assignOverride(cfg, field, over[field]);
  }
  return cfg;
}

/**
 * Detect whether a project-overridable field is currently masked by an active
 * environment variable.
 */
export function envMask(
  field: ProjectOverridableField,
  env: NodeJS.ProcessEnv = process.env,
): { envVar: string; envVal: string } | undefined {
  const spec = CONFIG_FIELD_SPECS[field];
  const fromEnv = spec.envValue(env[spec.env]);
  // The mask is exactly the env layer's usability rule for the field's kind.
  return fromEnv.usable ? { envVar: spec.env, envVal: fromEnv.raw } : undefined;
}

export function maskNote(
  field: ProjectOverridableField,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const mask = envMask(field, env);
  return mask ? `NOTE: currently masked by ${mask.envVar}=${mask.envVal}` : undefined;
}
