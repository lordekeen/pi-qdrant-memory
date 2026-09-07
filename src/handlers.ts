import { resolveMode, detectBlackhole } from "./mode.ts";
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

export function depsToIO(deps: RuntimeDeps): HandlerIO {
  return {
    cfg: deps.cfg, agentDir: deps.agentDir, cwd: deps.cwd, projectId: deps.projectId,
    embed: deps.embed, qdrant: deps.qdrant,
    readConfig: deps.readConfig, writeConfig: deps.writeConfig, print: deps.print,
  };
}

export interface HandlerResult { exit: boolean; }

export async function statusHandler(io: HandlerIO): Promise<HandlerResult> {
  const mode = resolveMode(io.cfg, detectBlackhole(io.agentDir));
  let count = -1;
  let qdrantOk = true;
  try { count = await io.qdrant.count(io.projectId); } catch { qdrantOk = false; }
  let embedOk = true;
  try { await io.embed("probe"); } catch { embedOk = false; }
  io.print(`mode: ${mode}`);
  io.print(`qdrant: ${qdrantOk ? `reachable, collection ${io.projectId} has ${count} points` : "NOT reachable"}`);
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
        (next as Record<string, unknown>)[key] = n;
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
