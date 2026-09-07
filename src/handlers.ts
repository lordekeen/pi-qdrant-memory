import { resolveMode, detectBlackhole } from "./mode.ts";
import { isConfigMode } from "./config.ts";
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
    const key = field as keyof Config;
    if (key in cfg) {
      const next = { ...cfg };
      if (typeof cfg[key] === "number") {
        const n = Number(value);
        if (!Number.isFinite(n)) { io.print(`settings: ${field} expects a number`); return { exit: false }; }
        if (key === "expectedDimension" || key === "maxResults") {
          if (!(n > 0)) { io.print(`settings: ${field} expects a positive number`); return { exit: false }; }
        }
        (next as Record<string, unknown>)[key] = n;
      } else if (key === "mode") {
        if (!isConfigMode(value)) { io.print(`settings: mode must be one of auto | blackhole | own`); return { exit: false }; }
        (next as Record<string, unknown>)[key] = value;
      } else {
        (next as Record<string, unknown>)[key] = value === "null" ? null : value;
      }
      io.writeConfig(next);
      io.print(`settings: ${field} updated (reloaded at runtime)`);
      return { exit: false };
    }
    io.print(`settings: unknown key ${field}`);
    return { exit: false };
  }
  io.print(`settings: open the TUI form (/qdrant settings) to edit; or use /qdrant settings <key> <value>`);
  return { exit: false };
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
    "/qdrant status   — connection health + active mode + collection status",
    "/qdrant settings — open settings form, or /qdrant settings <key> <value>",
    "/qdrant remember <text> — save durable knowledge now",
    "/qdrant search <query>  — semantic search of durable knowledge",
    "/qdrant clear   — reset the current project's collection",
    "/qdrant help    — this list",
  ].join("\n"));
  return { exit: false };
}
