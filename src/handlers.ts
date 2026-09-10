import { resolveMode, detectBlackhole } from "./mode.ts";
import { setConfigField } from "./config.ts";
import { rememberLogic, memorySearchLogic } from "./tools-core.ts";
import { errorEntry, helpEntry, message, outText, searchEntry, searchHitView, statusEntry, EMPTY_SEARCH_TEXT, codeMemoryReloadNotice } from "./out.ts";
import type { CodeMemoryHealth, HelpRow, OutEntry, StatusHealth } from "./out.ts";
import type { QdrantLike } from "./qdrant.ts";
import { QdrantError } from "./qdrant.ts";
import type { Config, MemoryType, RuntimeDeps } from "./types.ts";

export interface HandlerIO {
  cfg: Config;
  agentDir: string;
  cwd: string;
  projectId: string;
  embed: (t: string) => Promise<number[]>;
  qdrant: QdrantLike;
  readConfig(): Config;
  writeConfig(c: Config): void;
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
    readConfig: deps.readConfig,
    writeConfig: deps.writeConfig,
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
  const cfg = io.readConfig();
  if (field && value !== undefined) {
    const applied = setConfigField(cfg, field, value);
    if (!applied.ok) { io.emit(errorEntry(`error: ${applied.error}`)); return { exit: false }; }
    io.writeConfig(applied.next);
    io.emit(message(`settings: ${field} updated (reloaded at runtime)`));
    // Mid-session codeKnowledge flips cannot re-register tools — tell the user
    // what needs a reload and what does not (spec §12).
    if (field === "codeKnowledge") io.emit(message(codeMemoryReloadNotice(applied.next.codeKnowledge)));
    return { exit: false };
  }
  io.emit(message(`settings: usage — /qdrant-settings opens the interactive form; /qdrant-settings <key> <value> sets a field (keys: mode, codeKnowledge, embeddingBaseURL, embeddingModel, expectedDimension, scoreThreshold, codeScoreThreshold, maxResults, qdrantUrl, qdrantApiKey, embeddingApiKey)`));
  return { exit: false };
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

function displayValue(value: unknown): string {
  return value === null ? "null" : typeof value === "string" ? value : String(value);
}

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
  const cfg = io.readConfig();
  const optionToKey = new Map<string, SettingField>();
  const options = SETTING_FIELDS.map((k) => {
    const label = `${k} = ${displayValue(cfgField(cfg, k))}`;
    optionToKey.set(label, k);
    return label;
  });
  const pick = await ui.select("Qdrant Memory — choose a setting to edit", options);
  if (!pick) return; // Esc cancels the whole form
  const key = optionToKey.get(pick);
  if (!key) return;
  const cur = cfgField(cfg, key);

  let raw: string | undefined;
  if (key === "mode") {
    raw = await ui.select(`mode — currently ${displayValue(cur)}`, ["auto", "blackhole", "own"]);
  } else if (key === "codeKnowledge") {
    raw = await ui.select(`codeKnowledge — currently ${displayValue(cur)}`, ["off", "on"]);
  } else if (typeof cur === "number") {
    const positive = key === "expectedDimension" || key === "maxResults";
    raw = await ui.input(`${key} (${positive ? "positive " : ""}number)`, String(cur));
  } else {
    raw = await ui.input(`${key}`, cur === null ? undefined : String(cur));
  }
  const value = raw === undefined ? undefined : raw.trim();
  if (value === undefined || value === "") return; // cancelled / cleared input

  const applied = setConfigField(cfg, key, value);
  if (!applied.ok) { io.emit(errorEntry(`error: ${applied.error}`)); return; }
  const nextValue = cfgField(applied.next, key);
  const ok = await ui.confirm(
    `Save ${key}?`,
    `${key} = ${displayValue(nextValue)}  (was ${displayValue(cur)}; run /qdrant-settings again to edit another field)`,
  );
  if (!ok) { io.emit(message(`settings: ${key} unchanged (cancelled)`)); return; }
  io.writeConfig(applied.next);
  io.emit(message(`settings: ${key} updated (reloaded at runtime)`));
  // Same mid-session flip notice as the CLI path (spec §12).
  if (key === "codeKnowledge") io.emit(message(codeMemoryReloadNotice(applied.next.codeKnowledge)));
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
  else io.emit(errorEntry(`error: ${res.error}`));
  return { exit: false };
}

export async function searchHandler(io: HandlerIO, query: string, type?: MemoryType): Promise<HandlerResult> {
  const res = await memorySearchLogic(io, query, type);
  if (res.ok) {
    io.emit(res.value.length === 0 ? message(EMPTY_SEARCH_TEXT) : searchEntry(res.value.map(searchHitView)));
  } else {
    // Command voice: /qdrant-search failures read "error: search failed:
    // <reason>" (plan §1.2) — not the LLM tool's "memory_search failed:" lead,
    // which stays on the memory_search tool return (DESIGN.md agent-tool-results).
    const reason = res.error.replace(/^memory_search( failed)?: /, "");
    io.emit(errorEntry(`error: search failed: ${reason}`));
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
    { cmd: "/qdrant-settings <key> <value>", desc: "persist a config field (e.g. scoreThreshold 0.2)" },
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
