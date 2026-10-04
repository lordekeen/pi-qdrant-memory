/**
 * The one settings-write policy every surface shares: the CLI
 * (`/qdrant settings <key> <value>`), the RPC dialog form and the TUI settings
 * screen. Call sites keep their interaction (prompts, confirms, cancel rows,
 * rollback/refresh); this module owns the reserved `default` token, the
 * `setConfigField` validation call, scope routing (allowlisted key → the
 * project store, everything else → the global file from the GLOBAL reader —
 * D10), the emissions, and the empty-secret → `null` normalisation.
 *
 * Deliberately synchronous: every dependency is a plain call, and the call
 * sites need the `ok` result inline (the screen rolls a row back on rejection).
 */
import { setConfigField } from "./config.ts";
import { detectBlackhole } from "./mode.ts";
import { isProjectOverridable, maskNote } from "./project-settings.ts";
import type { ProjectOverridableField, ProjectSettings } from "./project-settings.ts";
import {
  codeMemoryReloadNotice,
  errorEntry,
  isSecretSettingField,
  message,
  modeOwnConflictNotice,
  settingsGlobalUpdatedText,
  settingsOverrideClearedText,
  settingsUpdatedText,
  settingsWriteErrorText,
} from "./out.ts";
import type { OutEntry } from "./out.ts";
import type { Config } from "./types.ts";

/**
 * The narrow slice of a runtime this policy needs. `HandlerIO` structurally
 * satisfies it (its `cfg`/`agentDir`/`env` are live getters), so call sites pass
 * their existing `io` object directly — never a spread, which would snapshot
 * `cfg` and hide the reload a write triggers.
 */
export interface SettingsWriteDeps {
  /** Emit one structured output entry per reaction (confirmation, error, notice). */
  emit(e: OutEntry): void;
  /** The LIVE effective config: read after a write, it reflects the reload. */
  cfg: Config;
  /** Environment variables; defaults to `process.env` in `maskNote`. */
  env?: NodeJS.ProcessEnv;
  agentDir: string;
  /** The global layer reader — also the D10 persist source for global writes. */
  readGlobalConfig(): Config;
  /** Persist the full global file; the runtime reloads the effective config. */
  writeGlobalConfig(c: Config): void;
  /** Persist one allowlisted override; the runtime reloads the effective config. */
  writeProjectSettings(p: ProjectSettings): void;
  /** Remove one allowlisted override; the runtime reloads the effective config. */
  clearProjectSetting(field: ProjectOverridableField): void;
}

/** A one-key typed partial for `saveProjectSettings` — no casts. */
function projectOverride(cfg: Config, field: ProjectOverridableField): ProjectSettings {
  return field === "codeKnowledge"
    ? { codeKnowledge: cfg.codeKnowledge }
    : { codeScoreThreshold: cfg.codeScoreThreshold };
}

/**
 * Apply one validated settings write and emit its reactions, in the order
 * DESIGN.md documents: confirmation (or error) first, the pi-blackhole conflict
 * warning second, the `codeKnowledge` reload notice last.
 *
 * `raw` is the user's verbatim value, trimmed by the interaction layer. An empty
 * value is only meaningful for a secret field, where it clears the key (the
 * literal `null` `setConfigField` accepts).
 */
export function applySettingWrite(deps: SettingsWriteDeps, field: string, raw: string): { ok: boolean } {
  // The live EFFECTIVE value: the reload notice fires iff a write actually
  // changed it (env-mask aware, project override included).
  const before = deps.cfg.codeKnowledge;

  if (isProjectOverridable(field) && raw === "default") {
    // Reserved token, matched BEFORE validation (D4): a no-op clear (no
    // override existed) still confirms "override cleared" — clearing is
    // idempotent by design.
    deps.clearProjectSetting(field);
    deps.emit(message(settingsOverrideClearedText(field, deps.readGlobalConfig()[field], maskNote(field, deps.env))));
    if (deps.cfg.codeKnowledge !== before) deps.emit(message(codeMemoryReloadNotice(deps.cfg.codeKnowledge)));
    return { ok: true };
  }

  // An empty secret clears the key; every other field's empty value is handled
  // by the interaction layer as a cancellation and never reaches this module.
  const value = raw === "" && isSecretSettingField(field) ? "null" : raw;
  const applied = setConfigField(deps.readGlobalConfig(), field, value);
  if (!applied.ok) {
    deps.emit(errorEntry(settingsWriteErrorText(applied.error)));
    return { ok: false };
  }

  if (isProjectOverridable(field)) {
    deps.writeProjectSettings(projectOverride(applied.next, field));
    deps.emit(message(settingsUpdatedText(field, applied.next[field], deps.readGlobalConfig()[field], maskNote(field, deps.env))));
  } else {
    // D10: persist the GLOBAL reader's copy, never the effective config — a
    // global write must not materialize (or drop) a live project override.
    deps.writeGlobalConfig(applied.next);
    deps.emit(message(settingsGlobalUpdatedText(field)));
    // #50: forcing own while pi-blackhole is operational makes both extensions
    // claim session_before_compact — pi-blackhole can cancel compaction, so no
    // mode-2 capture happens. Warn without blocking the write.
    if (field === "mode" && applied.next.mode === "own" && detectBlackhole(deps.agentDir)) {
      deps.emit(message(modeOwnConflictNotice()));
    }
  }
  // Both paths: the notice follows the live EFFECTIVE codeKnowledge change.
  if (deps.cfg.codeKnowledge !== before) deps.emit(message(codeMemoryReloadNotice(deps.cfg.codeKnowledge)));
  return { ok: true };
}
