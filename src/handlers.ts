import { resolveMode, detectBlackhole } from "./mode.ts";
import { configPath, setConfigField } from "./config.ts";
import {
  PROJECT_OVERRIDABLE_FIELDS,
  clearProjectField,
  isProjectOverridable,
  loadProjectSettings,
  projectSettingsPath,
  saveProjectSettings,
} from "./project-settings.ts";
import { rememberLogic, memorySearchLogic } from "./tools-core.ts";
import {
  EMPTY_SEARCH_TEXT,
  codeMemoryReloadNotice,
  displayValue,
  errorEntry,
  formClearMessage,
  formNumericPrompt,
  formSaveMessage,
  helpEntry,
  message,
  outText,
  resetOptionLabel,
  searchEntry,
  searchHitView,
  settingsGlobalUpdatedText,
  settingsOverrideClearedText,
  settingsScopeLabel,
  settingsUpdatedText,
  settingsUsageText,
  statusEntry,
} from "./out.ts";
import type { CodeMemoryHealth, HelpRow, OutEntry, SettingsScopeRow, StatusHealth } from "./out.ts";
import type { QdrantLike } from "./qdrant.ts";
import { QdrantError } from "./qdrant.ts";
import type { ProjectOverridableField, ProjectSettings } from "./project-settings.ts";
import type { Config, MemoryType, RuntimeDeps } from "./types.ts";

export interface HandlerIO {
  cfg: Config;
  agentDir: string;
  cwd: string;
  projectId: string;
  embed: (t: string) => Promise<number[]>;
  qdrant: QdrantLike;
  readGlobalConfig(): Config;
  writeGlobalConfig(c: Config): void;
  readProjectSettings(): ProjectSettings;
  writeProjectSettings(p: ProjectSettings): void;
  clearProjectSetting(field: ProjectOverridableField): void;
  /** Emit one structured output entry (message/error/help/status/search). */
  emit(e: OutEntry): void;
  /** Live code-memory sync state; present only when the feature is wired. */
  codeMemory?: CodeMemoryHealth;
}

export interface DepsToIOOptions { emit?: (e: OutEntry) => void; codeMemory?: CodeMemoryHealth; }

/**
 * Adapt a `RuntimeDeps` to a `HandlerIO`. Fields are exposed as live getters over
 * `deps` (not copies) so a session_start project-id refresh or a runtime config
 * reload is immediately visible to slash-command handlers. The default `emit`
 * projects the entry to plain text through the runtime's text `print` sink, so
 * non-entry runtimes (rpc/headless) keep working unchanged.
 */
export function depsToIO(deps: RuntimeDeps, options: DepsToIOOptions = {}): HandlerIO {
  return {
    get cfg() { return deps.cfg; },
    get agentDir() { return deps.agentDir; },
    get cwd() { return deps.cwd; },
    get projectId() { return deps.projectId; },
    get embed() { return deps.embed; },
    get qdrant() { return deps.qdrant; },
    readGlobalConfig: deps.readGlobalConfig,
    writeGlobalConfig: deps.writeGlobalConfig,
    readProjectSettings: () => loadProjectSettings(deps.agentDir, deps.projectId),
    writeProjectSettings: (p) => { saveProjectSettings(deps.agentDir, deps.projectId, p); deps.reloadEffectiveConfig(); },
    clearProjectSetting: (f) => { clearProjectField(deps.agentDir, deps.projectId, f); deps.reloadEffectiveConfig(); },
    emit: options.emit ?? ((e) => deps.print(outText(e))),
    codeMemory: options.codeMemory,
  };
}

export interface HandlerResult { exit: boolean; }

export async function statusHandler(io: HandlerIO): Promise<HandlerResult> {
  const mode = resolveMode(io.cfg, detectBlackhole(io.agentDir));
  let count = -1;
  let qdrantOk = true;
  let collectionMissing = false;
  try { count = await io.qdrant.count(io.projectId); } catch (err) {
    qdrantOk = false;
    // Qdrant is reachable but the project collection does not exist yet
    // (fresh project or after /qdrant clear) — distinguish from a down server
    // via the error's HTTP status, never by matching message text.
    if (err instanceof QdrantError && err.status === 404) { qdrantOk = true; collectionMissing = true; }
  }
  let embedOk = true;
  try { await io.embed("probe"); } catch { embedOk = false; }

  const qdrant: StatusHealth["qdrant"] = !qdrantOk
    ? { state: "err" }
    : collectionMissing
      ? { state: "warn", collection: io.projectId }
      : { state: "ok", collection: io.projectId, points: count };
  const health: StatusHealth = {
    mode,
    qdrant,
    embeddings: embedOk ? { state: "ok" } : { state: "err" },
    ...(io.codeMemory ? { codeMemory: io.codeMemory } : {}),
    detail: {
      collection: io.projectId,
      qdrantUrl: io.cfg.qdrantUrl,
      model: `${io.cfg.embeddingModel} @ ${io.cfg.embeddingBaseURL}`,
      dimension: io.cfg.expectedDimension,
      threshold: io.cfg.scoreThreshold,
      maxResults: io.cfg.maxResults,
    },
  };
  io.emit(statusEntry(health));
  return { exit: false };
}

export async function settingsHandler(io: HandlerIO, field?: string, value?: string): Promise<HandlerResult> {
  if (field && value !== undefined) {
    if (isProjectOverridable(field)) {
      // Allowlisted key: the project store owns this value. `before` is the live
      // EFFECTIVE codeKnowledge (env-mask aware) — the reload notice is emitted
      // iff the write actually changed it.
      const before = io.cfg.codeKnowledge;
      if (value === "default") {
        // Reserved token, matched BEFORE validation (D4): a no-op clear (no
        // override existed) still confirms "override cleared" — clearing is
        // idempotent by design.
        io.clearProjectSetting(field);
        io.emit(message(settingsOverrideClearedText(field, io.readGlobalConfig()[field])));
        if (io.cfg.codeKnowledge !== before) io.emit(message(codeMemoryReloadNotice(io.cfg.codeKnowledge)));
        return { exit: false };
      }
      const applied = setConfigField(io.readGlobalConfig(), field, value); // same errors as a global write
      if (!applied.ok) { io.emit(errorEntry(`error: ${applied.error}`)); return { exit: false }; }
      io.writeProjectSettings(projectOverride(applied.next, field));       // typed partial, JSON number
      io.emit(message(settingsUpdatedText(field, applied.next[field], io.readGlobalConfig()[field])));
      if (io.cfg.codeKnowledge !== before) io.emit(message(codeMemoryReloadNotice(io.cfg.codeKnowledge)));
      return { exit: false };
    }
    // Non-allowlisted key: today's global path, persisted from the GLOBAL reader
    // (D10) — never the effective config.
    const applied = setConfigField(io.readGlobalConfig(), field, value);
    if (!applied.ok) { io.emit(errorEntry(`error: ${applied.error}`)); return { exit: false }; }
    io.writeGlobalConfig(applied.next);
    io.emit(message(settingsGlobalUpdatedText(field)));
    return { exit: false };
  }
  const overrides = io.readProjectSettings();
  const global = io.readGlobalConfig();
  io.emit(message(settingsUsageText({
    projectPath: projectSettingsPath(io.agentDir, io.projectId),
    globalPath: configPath(io.agentDir),
    rows: scopeRows(io, overrides, global),
  })));
  return { exit: false };
}

/** A one-key typed partial for `saveProjectSettings` — no casts. */
function projectOverride(cfg: Config, field: ProjectOverridableField): ProjectSettings {
  return field === "codeKnowledge"
    ? { codeKnowledge: cfg.codeKnowledge }
    : { codeScoreThreshold: cfg.codeScoreThreshold };
}

/** One scope row per allowlisted field: effective value, global value, and
 * whether this project actually holds an override. */
function scopeRows(io: HandlerIO, overrides: ProjectSettings, global: Config): SettingsScopeRow[] {
  return PROJECT_OVERRIDABLE_FIELDS.map((key) => ({
    key,
    value: cfgField(io.cfg, key),
    globalValue: cfgField(global, key),
    overridden: overrides[key] !== undefined,
  }));
}

/** The interactive pieces of `ctx.ui` that the settings form needs. */
export interface SettingsUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
}

/** Editable fields in a stable order, all config keys minus nothing. */
const SETTING_FIELDS = [
  "mode",
  "codeKnowledge",
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

type SettingField = (typeof SETTING_FIELDS)[number];

/**
 * Dynamic access by a `SettingField` key — the `SETTING_FIELDS` names are
 * exactly the `Config` keys, whose values are string | number | null.
 */
function cfgField(cfg: Config, key: SettingField): string | number | null {
  // SAFETY: SettingField ⊆ Config keys; no Config value is boolean/undefined.
  return (cfg as unknown as Record<string, unknown>)[key] as string | number | null;
}

/**
 * Interactive settings form, driven through `ctx.ui` (select/input/confirm).
 * Esc or an empty input cancels the current step; the write only happens after
 * an explicit confirm. Validation is shared with the CLI via `setConfigField`.
 */
export async function runSettingsForm(ui: SettingsUI, io: HandlerIO): Promise<void> {
  // Display the EFFECTIVE view (io.cfg, live) but persist the GLOBAL reader for
  // global writes (D10 — the single highest-value trap).
  const effective = io.cfg;
  const globalForLabels = io.readGlobalConfig();
  const overrides = io.readProjectSettings();
  const optionToKey = new Map<string, SettingField>();
  const options = SETTING_FIELDS.map((k) => {
    const label = settingsScopeLabel({
      key: k,
      value: cfgField(effective, k),
      globalValue: cfgField(globalForLabels, k),
      overridden: isProjectOverridable(k) && overrides[k] !== undefined,
    });
    optionToKey.set(label, k);
    return label;
  });
  const pick = await ui.select("Qdrant Memory — choose a setting to edit", options);
  if (!pick) return; // Esc cancels the whole form
  const key = optionToKey.get(pick);
  if (!key) return;
  const cur = cfgField(effective, key);
  const globalVal = cfgField(globalForLabels, key) as string | number;
  const projectScoped = isProjectOverridable(key);

  let raw: string | undefined;
  if (key === "mode") {
    raw = await ui.select(`mode — currently ${displayValue(cur)}`, ["auto", "blackhole", "own"]);
  } else if (key === "codeKnowledge") {
    // The select offers a reset option labelled e.g. `default (inherit global:
    // off)`; normalize it back to the reserved token `default` so the clear
    // path below matches exactly as if the user had typed `default`.
    const reset = resetOptionLabel(globalVal);
    raw = await ui.select(`codeKnowledge — currently ${displayValue(cur)}`, ["off", "on", reset]);
    if (raw === reset) raw = "default";
  } else if (typeof cur === "number") {
    if (projectScoped) {
      raw = await ui.input(formNumericPrompt(key, globalVal), String(cur));
    } else {
      const positive = key === "expectedDimension" || key === "maxResults";
      raw = await ui.input(`${key} (${positive ? "positive " : ""}number)`, String(cur));
    }
  } else {
    raw = await ui.input(`${key}`, cur === null ? undefined : String(cur));
  }
  const value = raw === undefined ? undefined : raw.trim();
  if (value === undefined || value === "") return; // cancelled / cleared input

  if (projectScoped && value === "default") {
    // Reserved token, matched before validation — mirrors the CLI clear path.
    const before = io.cfg.codeKnowledge;
    const ok = await ui.confirm("Clear the project override?", formClearMessage(key, globalVal));
    if (!ok) { io.emit(message(`settings: ${key} unchanged (cancelled)`)); return; }
    io.clearProjectSetting(key);
    io.emit(message(settingsOverrideClearedText(key, io.readGlobalConfig()[key])));
    if (io.cfg.codeKnowledge !== before) io.emit(message(codeMemoryReloadNotice(io.cfg.codeKnowledge)));
    return;
  }

  const globalNow = io.readGlobalConfig(); // re-read: never persist a stale/effective Config
  const applied = setConfigField(globalNow, key, value);
  if (!applied.ok) { io.emit(errorEntry(`error: ${applied.error}`)); return; }
  const nextValue = cfgField(applied.next, key);
  const ok = await ui.confirm(
    `Save ${key}?`,
    formSaveMessage(key, nextValue, cur, projectScoped ? "project" : "global", globalVal),
  );
  if (!ok) { io.emit(message(`settings: ${key} unchanged (cancelled)`)); return; }
  const before = io.cfg.codeKnowledge;
  if (projectScoped) {
    io.writeProjectSettings(projectOverride(applied.next, key));
    io.emit(message(settingsUpdatedText(key, nextValue as string | number, globalVal)));
  } else {
    io.writeGlobalConfig(applied.next);
    io.emit(message(settingsGlobalUpdatedText(key)));
  }
  // Both paths: the notice follows the live EFFECTIVE codeKnowledge change.
  if (io.cfg.codeKnowledge !== before) io.emit(message(codeMemoryReloadNotice(io.cfg.codeKnowledge)));
}

export async function rememberHandler(io: HandlerIO, text: string, type?: MemoryType): Promise<HandlerResult> {
  // io is structurally a ToolDeps (cfg/projectId/embed/qdrant); tools-core takes
  // that narrow type and needs no output channel.
  const res = await rememberLogic(io, text, type);
  // Command voice: plain "remembered: <text>" (DESIGN.md message). The stored
  // point's source_kind ("remember_tool") is provenance data that drives the
  // deterministic point id — it is never echoed to the human; only the
  // LLM-facing memory_save return names it (DESIGN.md agent-tool-results).
  if (res.ok) io.emit(message(`remembered: ${res.value.text}`));
  else io.emit(errorEntry(`error: remember failed: ${res.error}`));
  return { exit: false };
}

export async function searchHandler(io: HandlerIO, query: string, type?: MemoryType): Promise<HandlerResult> {
  const res = await memorySearchLogic(io, query, type);
  if (res.ok) {
    io.emit(res.value.length === 0 ? message(EMPTY_SEARCH_TEXT) : searchEntry(res.value.map(searchHitView)));
  } else {
    // Command voice: /qdrant-search failures read "error: search failed:
    // <reason>" (plan §1.2). `res.error` is now a bare reason (tools-core no
    // longer prefixes a tool name), so no prefix-stripping is needed here — the
    // LLM tool's "memory_search failed:" lead lives only on the memory_search
    // tool return (DESIGN.md agent-tool-results).
    io.emit(errorEntry(`error: search failed: ${res.error}`));
  }
  return { exit: false };
}

export async function clearHandler(io: HandlerIO): Promise<HandlerResult> {
  try {
    await io.qdrant.clearCollection(io.projectId);
    io.emit(message(`cleared: collection ${io.projectId} reset`));
  } catch (err) {
    io.emit(errorEntry(`error: clear failed: ${String(err)}`));
  }
  return { exit: false };
}

export async function helpHandler(io: HandlerIO): Promise<HandlerResult> {
  // Brand the help block with the same header the footer statusline carries
  // (DESIGN.md footer-status) so the active mode + collection are visible here too.
  const mode = resolveMode(io.cfg, detectBlackhole(io.agentDir));
  const rows: HelpRow[] = [
    { cmd: "/qdrant-status", desc: "connection health + active mode + collection status" },
    { cmd: "/qdrant-settings <key> <value>", desc: "persist a config field — codeKnowledge/codeScoreThreshold apply to this project, other keys are global" },
    { cmd: "/qdrant-remember <text>", desc: "save durable knowledge now" },
    { cmd: "/qdrant-search <query>", desc: "semantic search of durable knowledge" },
    { cmd: "/qdrant-clear", desc: "reset the current project's collection" },
    { cmd: "/qdrant-help", desc: "this list" },
  ];
  if (io.cfg.codeKnowledge === "on") {
    rows.splice(5, 0, { cmd: "/qdrant-index-code", desc: "re-index code summaries now" });
  }
  io.emit(helpEntry(rows, { mode, collection: io.projectId }));
  return { exit: false };
}
