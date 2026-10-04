import { detectBlackhole, runtimeMode } from "./mode.ts";
import { COMMAND_ROWS } from "./commands.ts";
import { SETTING_FIELDS, configPath, setConfigField } from "./config.ts";
import type { SettingField } from "./config.ts";
import {
  PROJECT_OVERRIDABLE_FIELDS,
  clearProjectField,
  isProjectOverridable,
  loadProjectSettings,
  projectSettingsPath,
  saveProjectSettings,
} from "./project-settings.ts";
import { applySettingWrite } from "./settings-write.ts";
import { rememberLogic, memorySearchLogic } from "./tools-core.ts";
import {
  EMPTY_SEARCH_TEXT,
  alreadySavedText,
  clearCodeUnsupportedText,
  clearFailedText,
  clearNoCodeText,
  clearedAllText,
  clearedCodeText,
  forgetCancelledText,
  forgetFailedText,
  forgetNoMatchText,
  forgetRequiresUiText,
  forgetUnsupportedText,
  forgetUsageText,
  forgottenText,
  rememberFailedText,
  rememberedText,
  searchFailedText,
  settingsWriteErrorText,
  clearAlreadyEmptyText,
  clearAllConfirmMessage,
  clearAllConfirmTitle,
  clearCancelledText,
  clearRequiresUiText,
  clearUsageText,
  displayValue,
  errorEntry,
  forgetConfirmMessage,
  formClearMessage,
  formNumericPrompt,
  formSaveMessage,
  helpEntry,
  isSecretSettingField,
  message,
  outText,
  resetOptionLabel,
  searchEntry,
  searchHitView,
  settingsCancelledText,
  settingsScopeLabel,
  settingsUsageText,
  statusEntry,
} from "./out.ts";
import type { CodeMemoryHealth, HelpRow, OutEntry, ProjectSettingRow, SettingsScopeRow, StatusHealth } from "./out.ts";
import type { QdrantLike } from "./qdrant.ts";
import { QdrantError, redactUrl } from "./qdrant.ts";
import type { ProjectOverridableField, ProjectSettings } from "./project-settings.ts";
import type { Config, EmbedProbeCacheEntry, MemoryType, RuntimeDeps } from "./types.ts";

export const EMBED_PROBE_SUCCESS_TTL_MS = 30_000;
export const EMBED_PROBE_FAILURE_TTL_MS = 5_000;
export const EMBED_PROBE_TIMEOUT_MS = 5_000;

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
  /** Environment variables; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Memoized verified collection existence set (OI-010). */
  collectionReady?: Set<string>;
  /** Cached embedding probe result (OI-011). */
  embedProbeCache?: EmbedProbeCacheEntry;
  /** Timeout budget for the status probe (OI-011, defaults to 5000ms). */
  embedProbeTimeoutMs?: number;
  /** Injectable clock for probe TTL (tests). */
  now?: () => number;
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
    get env() { return deps.env ?? process.env; },
    get collectionReady() { return deps.collectionReady; },
    get embedProbeCache() { return deps.embedProbeCache; },
    set embedProbeCache(v) { deps.embedProbeCache = v; },
    get now() { return deps.now; },
    readGlobalConfig: deps.readGlobalConfig,
    writeGlobalConfig: deps.writeGlobalConfig,
    readProjectSettings: () => loadProjectSettings(deps.agentDir, deps.projectId),
    writeProjectSettings: (p) => { saveProjectSettings(deps.agentDir, deps.projectId, p); deps.reloadEffectiveConfig(); },
    clearProjectSetting: (f) => { clearProjectField(deps.agentDir, deps.projectId, f); deps.reloadEffectiveConfig(); },
    emit: options.emit ?? ((e) => deps.print(outText(e))),
    codeMemory: options.codeMemory,
  };
}

export async function probeEmbedding(
  io: HandlerIO,
  timeoutMs: number = io.embedProbeTimeoutMs ?? EMBED_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const now = (io.now ?? Date.now)();
  const key = `${io.cfg.embeddingBaseURL}:${io.cfg.embeddingModel}:${io.cfg.embeddingApiKey ?? ""}`;
  const cached = io.embedProbeCache;
  if (cached && cached.key === key) {
    const ttl = cached.ok ? EMBED_PROBE_SUCCESS_TTL_MS : EMBED_PROBE_FAILURE_TTL_MS;
    if (now - cached.at < ttl) {
      return cached.ok;
    }
  }

  let ok = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("embedding probe timed out")), timeoutMs);
    });
    await Promise.race([io.embed("probe"), timeoutPromise]);
    ok = true;
  } catch {
    ok = false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  io.embedProbeCache = { key, ok, at: now };
  return ok;
}

export async function statusHandler(io: HandlerIO): Promise<void> {
  const mode = runtimeMode(io.cfg, io.agentDir);
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
  const embedOk = await probeEmbedding(io);

  const qdrant: StatusHealth["qdrant"] = !qdrantOk
    ? { state: "err" }
    : collectionMissing
      ? { state: "warn", collection: io.projectId }
      : { state: "ok", collection: io.projectId, points: count };
  // This project's allowlisted overrides (D5): explicit per-key branches, no
  // casts. Quiet by default — the row is passed only when non-empty.
  const overrides = io.readProjectSettings();
  const global = io.readGlobalConfig();
  const projectSettings: ProjectSettingRow[] = [];
  if (overrides.codeKnowledge !== undefined) {
    projectSettings.push({ key: "codeKnowledge", value: overrides.codeKnowledge, globalValue: global.codeKnowledge });
  }
  if (overrides.codeScoreThreshold !== undefined) {
    projectSettings.push({ key: "codeScoreThreshold", value: overrides.codeScoreThreshold, globalValue: global.codeScoreThreshold });
  }
  const health: StatusHealth = {
    mode,
    // Explicit own + operational blackhole is the contradictory config #50 warns
    // about. `runtimeMode` cannot express it: mode "own" resolves to mode2 even
    // when pi-blackhole is present, so the raw flag is checked here.
    modeConflict: io.cfg.mode === "own" && detectBlackhole(io.agentDir),
    qdrant,
    embeddings: embedOk ? { state: "ok" } : { state: "err" },
    ...(io.codeMemory ? { codeMemory: io.codeMemory } : {}),
    ...(projectSettings.length ? { projectSettings } : {}),
    detail: {
      collection: io.projectId,
      qdrantUrl: redactUrl(io.cfg.qdrantUrl),
      model: `${io.cfg.embeddingModel} @ ${redactUrl(io.cfg.embeddingBaseURL)}`,
      dimension: io.cfg.expectedDimension,
      threshold: io.cfg.scoreThreshold,
      maxResults: io.cfg.maxResults,
      ...(io.codeMemory ? { codeThreshold: io.cfg.codeScoreThreshold } : {}),
    },
  };
  io.emit(statusEntry(health));
}

export async function settingsHandler(io: HandlerIO, field?: string, value?: string): Promise<void> {
  if (field && value !== undefined) {
    // Interaction only: the write policy (reserved `default`, validation, scope
    // routing, emissions, secret normalisation) lives in settings-write.ts and
    // is shared with the RPC form and the TUI screen. `io` is passed whole — a
    // spread would snapshot the live `cfg` getter.
    applySettingWrite(io, field, value);
    return;
  }
  const overrides = io.readProjectSettings();
  const global = io.readGlobalConfig();
  io.emit(message(settingsUsageText({
    projectPath: projectSettingsPath(io.agentDir, io.projectId),
    globalPath: configPath(io.agentDir),
    rows: scopeRows(io, overrides, global),
  })));
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

/** Editable fields in a stable order — defined once in `config.ts` so the
 *  settings form, the CLI validator and the `/qdrant settings` grammar all read
 *  the same list. */

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
  // #58: every exit from the form is visible. Esc before a field was chosen has
  // no key to name, so it reports the form as a whole.
  if (!pick) { io.emit(message(settingsCancelledText())); return; }
  const key = optionToKey.get(pick);
  if (!key) { io.emit(message(settingsCancelledText())); return; }
  const cur = cfgField(effective, key);
  const globalVal = cfgField(globalForLabels, key) as string | number;
  const projectScoped = isProjectOverridable(key);

  let raw: string | undefined;
  if (key === "mode") {
    raw = await ui.select(`mode — currently ${displayValue(cur)}`, ["auto", "blackhole", "own"]);
  } else if (key === "memoryForget") {
    raw = await ui.select(`memoryForget — currently ${displayValue(cur)}`, ["off", "on"]);
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
    // #58: a secret is NEVER prefilled — the placeholder would print the
    // credential. Its pick label already carries the "currently set" fact, and
    // an empty value is the documented clear path.
    const secret = isSecretSettingField(key);
    const prompt = secret ? `${key} (clear to remove)` : key;
    raw = await ui.input(prompt, secret || cur === null ? undefined : String(cur));
  }
  const value = raw === undefined ? undefined : raw.trim();
  if (value === undefined) { io.emit(message(settingsCancelledText(key))); return; } // Esc
  if (value === "") {
    // Empty input clears a secret; on every other field it is a cancellation
    // ("leave unchanged"), which must be visible like every other cancel (#58).
    if (!isSecretSettingField(key)) { io.emit(message(settingsCancelledText(key))); return; }
  }

  if (projectScoped && value === "default") {
    // Reserved token, matched before validation — the same clear path a CLI
    // `default` takes (the shared writer owns the clear + its reactions).
    const ok = await ui.confirm("Clear the project override?", formClearMessage(key, globalVal));
    if (!ok) { io.emit(message(settingsCancelledText(key))); return; }
    applySettingWrite(io, key, "default");
    return;
  }

  // Preview through the shared validator so an invalid value never reaches the
  // confirm dialog; the write module re-validates the actual write. An empty
  // value here is a secret clear, so the dialog names the `null` it persists.
  const preview = value === "" ? "null" : value;
  const applied = setConfigField(io.readGlobalConfig(), key, preview); // re-read: never validate against a stale/effective Config
  if (!applied.ok) { io.emit(errorEntry(settingsWriteErrorText(applied.error))); return; }
  const nextValue = cfgField(applied.next, key);
  const ok = await ui.confirm(
    `Save ${key}?`,
    formSaveMessage(key, nextValue, cur, projectScoped ? "project" : "global", globalVal),
  );
  if (!ok) { io.emit(message(settingsCancelledText(key))); return; }
  // The shared writer persists, routes and emits — the raw value, because the
  // empty-secret → `null` normalisation is its policy (never duplicated here).
  applySettingWrite(io, key, value);
}

export async function rememberHandler(io: HandlerIO, text: string, type?: MemoryType): Promise<void> {
  // io is structurally a ToolDeps (cfg/projectId/embed/qdrant); tools-core takes
  // that narrow type and needs no output channel.
  const res = await rememberLogic(io, text, type);
  // Command voice: plain "remembered: <text>" (DESIGN.md message). The stored
  // point's source_kind ("remember_tool") is provenance data that drives the
  // deterministic point id — it is never echoed to the human; only the
  // LLM-facing memory_save return names it (DESIGN.md agent-tool-results).
  if (res.ok) {
    if (res.value.skipped) io.emit(message(alreadySavedText(res.value.text)));
    else io.emit(message(rememberedText(res.value.text)));
  } else {
    io.emit(errorEntry(rememberFailedText(res.error)));
  }
}

export async function searchHandler(io: HandlerIO, query: string, type?: MemoryType): Promise<void> {
  const res = await memorySearchLogic(io, query, type);
  if (res.ok) {
    io.emit(res.value.length === 0 ? message(EMPTY_SEARCH_TEXT) : searchEntry(res.value.map(searchHitView)));
  } else {
    // Command voice: /qdrant search failures read "error: search failed:
    // <reason>" (plan §1.2). `res.error` is now a bare reason (tools-core no
    // longer prefixes a tool name), so no prefix-stripping is needed here — the
    // LLM tool's "memory_search failed:" lead lives only on the memory_search
    // tool return (DESIGN.md agent-tool-results).
    io.emit(errorEntry(searchFailedText(res.error)));
  }
}

/**
 * Drop the in-memory caches a clear invalidates (#44): the memoized
 * collection-existence set and the code-memory inventory counts that
 * `/qdrant status` reports. Called on **every** successful clear path — the
 * empty collection included, where the stored side is already empty but the
 * counters may be stale (#61).
 */
function resetCodeMemoryCaches(io: HandlerIO): void {
  io.collectionReady?.delete(io.projectId);
  if (io.codeMemory) {
    io.codeMemory.files = 0;
    io.codeMemory.symbols = 0;
  }
}

export async function clearHandler(io: HandlerIO, target?: string, ui?: SettingsUI): Promise<void> {
  const normalized = target?.trim().toLowerCase();
  if (normalized === "all") {
    // Headless refusal (plan Part C): a destructive wipe is never attempted
    // when there is no dialog to ask — mirrors the forget refusal.
    if (!ui) {
      io.emit(errorEntry(clearRequiresUiText()));
      return;
    }
    // Count first so an empty (or absent) collection never opens a dialog.
    // A 404 count means the collection does not exist — that is empty, not an
    // error. Any other failure deletes nothing.
    let count: number;
    try {
      count = await io.qdrant.count(io.projectId);
    } catch (err) {
      if (err instanceof QdrantError && err.status === 404) {
        count = 0;
      } else {
        io.emit(errorEntry(clearFailedText(String(err))));
        return;
      }
    }
    if (count === 0) {
      // Nothing is stored, but the in-memory inventory can still be stale (the
      // collection may have been emptied elsewhere) — reset it here too, so
      // /qdrant status never keeps reporting deleted files/symbols (#61).
      resetCodeMemoryCaches(io);
      io.emit(message(clearAlreadyEmptyText(io.projectId)));
      return;
    }
    const ok = await ui.confirm(clearAllConfirmTitle(io.projectId, count), clearAllConfirmMessage());
    if (!ok) {
      io.emit(message(clearCancelledText()));
      return;
    }
    try {
      await io.qdrant.clearCollection(io.projectId);
      resetCodeMemoryCaches(io);
      io.emit(message(clearedAllText(io.projectId)));
    } catch (err) {
      io.emit(errorEntry(clearFailedText(String(err))));
    }
    return;
  }
  if (normalized === "code") {
    try {
      const count = await io.qdrant.countBySourceKind(io.projectId, "code_summary");
      if (count === 0) {
        io.emit(message(clearNoCodeText()));
        return;
      }
      if (!io.qdrant.deletePointsBySourceKind) {
        io.emit(errorEntry(clearCodeUnsupportedText()));
        return;
      }
      await io.qdrant.deletePointsBySourceKind(io.projectId, "code_summary");
      resetCodeMemoryCaches(io);
      io.emit(message(clearedCodeText(count)));
    } catch (err) {
      io.emit(errorEntry(clearFailedText(String(err))));
    }
    return;
  }
  io.emit(message(clearUsageText()));
}

export const FORGET_MAX_HITS = 5;

export async function forgetHandler(io: HandlerIO, query: string, ui?: SettingsUI): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) {
    io.emit(message(forgetUsageText()));
    return;
  }
  // Probe one hit beyond the cap: a hit at index FORGET_MAX_HITS proves more
  // matches exist above the threshold, so the dialog can say they are left
  // untouched. Only `targets` are ever shown or deleted (#48).
  const res = await memorySearchLogic(io, trimmed, undefined, FORGET_MAX_HITS + 1);
  if (!res.ok) {
    io.emit(errorEntry(forgetFailedText(res.error)));
    return;
  }
  if (res.value.length === 0) {
    io.emit(message(forgetNoMatchText(trimmed)));
    return;
  }
  if (!ui) {
    io.emit(errorEntry(forgetRequiresUiText()));
    return;
  }
  const capped = res.value.length > FORGET_MAX_HITS;
  const targets = res.value.slice(0, FORGET_MAX_HITS);
  const views = targets.map(searchHitView);
  io.emit(searchEntry(views));
  const confirmed = await ui.confirm("Remove memories?", forgetConfirmMessage(views, capped));
  if (!confirmed) {
    io.emit(message(forgetCancelledText()));
    return;
  }
  const hitIds = targets.map((h) => h.id);
  if (!io.qdrant.deletePointsByIds) {
    io.emit(errorEntry(forgetUnsupportedText()));
    return;
  }
  try {
    const count = await io.qdrant.deletePointsByIds(io.projectId, hitIds);
    io.emit(message(forgottenText(count)));
  } catch (err) {
    io.emit(errorEntry(forgetFailedText(err instanceof Error ? err.message : String(err))));
  }
}

export async function helpHandler(io: HandlerIO): Promise<void> {
  // Brand the help block with the same header the footer statusline carries
  // (DESIGN.md footer-status) so the active mode + collection are visible here too.
  const mode = runtimeMode(io.cfg, io.agentDir);
  // The rows come from the ONE command registry (commands.ts), in declaration
  // order — the same table the argument completion reads its summaries from.
  const rows: HelpRow[] = Object.values(COMMAND_ROWS)
    .filter((r) => !r.gated || (r.gated === "codeKnowledge" && io.cfg.codeKnowledge === "on"))
    .map(({ cmd, desc }) => ({ cmd, desc }));
  io.emit(helpEntry(rows, { mode, collection: io.projectId }));
}
