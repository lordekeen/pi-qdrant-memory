import { resolveMode, detectBlackhole } from "./mode.ts";
import { setConfigField } from "./config.ts";
import { rememberLogic, memorySearchLogic } from "./tools-core.ts";
import { renderHits } from "./render.ts";
import type { QdrantLike } from "./qdrant.ts";
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
  print(text: string): void;
}

export interface DepsToIOOptions { print?: (text: string) => void; }

/**
 * Adapt a `RuntimeDeps` to a `HandlerIO`. Fields are exposed as live getters over
 * `deps` (not copies) so a session_start project-id refresh or a runtime config
 * reload is immediately visible to slash-command handlers.
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
    print: options.print ?? deps.print,
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
    // (fresh project or after /qdrant clear) — distinguish from a down server.
    if (/HTTP 404/.test(String(err))) { qdrantOk = true; collectionMissing = true; }
  }
  let embedOk = true;
  try { await io.embed("probe"); } catch { embedOk = false; }
  io.print(`mode: ${mode}`);
  io.print(`qdrant: ${!qdrantOk ? "NOT reachable" : collectionMissing ? `reachable, collection ${io.projectId} does not exist yet` : `reachable, collection ${io.projectId} has ${count} points`}`);
  io.print(`embeddings: ${embedOk ? `reachable (${io.cfg.embeddingModel} @ ${io.cfg.embeddingBaseURL})` : "NOT reachable"}`);
  return { exit: false };
}

export async function settingsHandler(io: HandlerIO, field?: string, value?: string): Promise<HandlerResult> {
  const cfg = io.readConfig();
  if (field && value !== undefined) {
    const applied = setConfigField(cfg, field, value);
    if (!applied.ok) { io.print(applied.error); return { exit: false }; }
    io.writeConfig(applied.next);
    io.print(`settings: ${field} updated (reloaded at runtime)`);
    return { exit: false };
  }
  io.print(`settings: usage — /qdrant-settings opens the interactive form; /qdrant-settings <key> <value> sets a field (keys: mode, embeddingBaseURL, embeddingModel, expectedDimension, scoreThreshold, maxResults, qdrantUrl, qdrantApiKey, embeddingApiKey)`);
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
  "embeddingBaseURL",
  "embeddingModel",
  "expectedDimension",
  "scoreThreshold",
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
 * Interactive settings form, driven through `ctx.ui` (select/input/confirm).
 * Esc or an empty input cancels the current step; the write only happens after
 * an explicit confirm. Validation is shared with the CLI via `setConfigField`.
 */
export async function runSettingsForm(ui: SettingsUI, io: HandlerIO): Promise<void> {
  const cfg = io.readConfig();
  const optionToKey = new Map<string, SettingField>();
  const options = SETTING_FIELDS.map((k) => {
    const label = `${k} = ${displayValue((cfg as unknown as Record<string, unknown>)[k])}`;
    optionToKey.set(label, k);
    return label;
  });
  const pick = await ui.select("Qdrant Memory — choose a setting to edit", options);
  if (!pick) return; // Esc cancels the whole form
  const key = optionToKey.get(pick);
  if (!key) return;
  const cur = (cfg as unknown as Record<string, unknown>)[key];

  let raw: string | undefined;
  if (key === "mode") {
    raw = await ui.select(`mode — currently ${displayValue(cur)}`, ["auto", "blackhole", "own"]);
  } else if (typeof cur === "number") {
    const positive = key === "expectedDimension" || key === "maxResults";
    raw = await ui.input(`${key} (${positive ? "positive " : ""}number)`, String(cur));
  } else {
    raw = await ui.input(`${key}`, cur === null ? undefined : String(cur));
  }
  const value = raw === undefined ? undefined : raw.trim();
  if (value === undefined || value === "") return; // cancelled / cleared input

  const applied = setConfigField(cfg, key, value);
  if (!applied.ok) { io.print(applied.error); return; }
  const nextValue = (applied.next as unknown as Record<string, unknown>)[key];
  const ok = await ui.confirm(
    `Save ${key}?`,
    `${key} = ${displayValue(nextValue)}  (was ${displayValue(cur)}; run /qdrant-settings again to edit another field)`,
  );
  if (!ok) { io.print(`settings: ${key} unchanged (cancelled)`); return; }
  io.writeConfig(applied.next);
  io.print(`settings: ${key} updated (reloaded at runtime)`);
}

export async function rememberHandler(io: HandlerIO, text: string, type?: MemoryType): Promise<HandlerResult> {
  const res = await rememberLogic({
    cfg: io.cfg, agentDir: io.agentDir, cwd: io.cwd, projectId: io.projectId,
    embed: io.embed, qdrant: io.qdrant, readConfig: io.readConfig, writeConfig: io.writeConfig, print: io.print,
  }, text, type);
  io.print(res.ok ? `remembered (${res.value.source_kind}): ${res.value.text}` : `remember failed: ${(res as { error: string }).error}`);
  return { exit: false };
}

export async function searchHandler(io: HandlerIO, query: string, type?: MemoryType): Promise<HandlerResult> {
  const res = await memorySearchLogic({
    cfg: io.cfg, agentDir: io.agentDir, cwd: io.cwd, projectId: io.projectId,
    embed: io.embed, qdrant: io.qdrant, readConfig: io.readConfig, writeConfig: io.writeConfig, print: io.print,
  }, query, type);
  io.print(res.ok ? renderHits(res.value) : `search failed: ${(res as { error: string }).error}`);
  return { exit: false };
}

export async function clearHandler(io: HandlerIO): Promise<HandlerResult> {
  try {
    await io.qdrant.clearCollection(io.projectId);
    io.print(`cleared: collection ${io.projectId} reset`);
  } catch (err) {
    io.print(`clear failed: ${String(err)}`);
  }
  return { exit: false };
}

export async function helpHandler(io: HandlerIO): Promise<HandlerResult> {
  io.print([
    "/qdrant-status            — connection health + active mode + collection status",
    "/qdrant-settings <key> <value> — persist a config field (e.g. scoreThreshold 0.2)",
    "/qdrant-remember <text>   — save durable knowledge now",
    "/qdrant-search <query>    — semantic search of durable knowledge",
    "/qdrant-clear             — reset the current project's collection",
    "/qdrant-help              — this list",
  ].join("\n"));
  return { exit: false };
}
