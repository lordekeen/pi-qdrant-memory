import { readGlobalConfig, writeConfigFile } from "./config.ts";
import { readEffectiveConfig } from "./project-settings.ts";
import { EmbeddingClient } from "./embeddings.ts";
import { QdrantClient } from "./qdrant.ts";
import { projectIdFrom } from "./project.ts";
import type { QdrantLike } from "./qdrant.ts";
import type { Config, RuntimeDeps } from "./types.ts";

export interface MakeRuntimeIO {
  /** Today's `readConfig`: the global file reader (D10). */
  readGlobalConfig(): Config;
  /** Today's `writeConfig`: persists the full global file (D10 persist side). */
  writeGlobalConfig(c: Config): void;
  print(text: string): void;
  embed?: (t: string) => Promise<number[]>;
  embedBatch?: (texts: string[]) => Promise<number[][]>;
  qdrant?: QdrantLike;
}

export async function makeRuntime(
  agentDir: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  io: MakeRuntimeIO,
): Promise<RuntimeDeps> {
  // Project id FIRST: the project layer is part of the effective config (D7).
  const projectId = await projectIdFrom(cwd);
  const cfg = readEffectiveConfig(agentDir, projectId, env);
  const embeddingClient = new EmbeddingClient(
    cfg.embeddingBaseURL, cfg.embeddingModel, cfg.embeddingApiKey, cfg.expectedDimension);
  const embedder = io.embed ?? ((text: string) => embeddingClient.embed(text));
  const qdrant = io.qdrant ?? (new QdrantClient(cfg.qdrantUrl, cfg.qdrantApiKey) as QdrantLike);
  const rt: RuntimeDeps = {
    cfg,
    agentDir,
    cwd,
    projectId,
    embed: embedder,
    embedBatch: io.embedBatch ?? ((texts: string[]) => embeddingClient.embedBatch(texts)),
    qdrant,
    readGlobalConfig: io.readGlobalConfig,
    writeGlobalConfig: io.writeGlobalConfig,
    print: io.print,
    reloadEffectiveConfig: () => applyConfig(rt, readEffectiveConfig(agentDir, rt.projectId, env)),
  };
  return rt;
}

/**
 * D10 write discipline: persist the full Config to the GLOBAL file through the
 * global reader's value, then re-apply the EFFECTIVE reader to the live
 * runtime. Two readers, two halves — wiring either half to the wrong one is
 * the D10 bug (a global write must never drop a live project override).
 */
export function writeGlobalConfigAndReload(rt: RuntimeDeps, agentDir: string, next: Config): void {
  writeConfigFile(agentDir, next);
  rt.reloadEffectiveConfig();
}

/**
 * Swap a runtime onto a new config at runtime (reload-on-save): replaces `cfg`
 * and rebuilds the embedding/Qdrant clients so a `/qdrant settings` write takes
 * effect immediately instead of at the next session.
 */
export function applyConfig(rt: RuntimeDeps, cfg: Config): void {
  rt.cfg = cfg;
  const embeddingClient = new EmbeddingClient(
    cfg.embeddingBaseURL, cfg.embeddingModel, cfg.embeddingApiKey, cfg.expectedDimension);
  rt.embed = (text: string) => embeddingClient.embed(text);
  // Rebind the batch variant too, or a hot config reload would leave it
  // submitting to the previous (stale) embedding client.
  rt.embedBatch = (texts: string[]) => embeddingClient.embedBatch(texts);
  rt.qdrant = new QdrantClient(cfg.qdrantUrl, cfg.qdrantApiKey);
}
