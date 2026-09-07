import { loadConfig } from "./config.ts";
import { EmbeddingClient } from "./embeddings.ts";
import { QdrantClient } from "./qdrant.ts";
import { projectIdFrom } from "./project.ts";
import type { QdrantLike } from "./qdrant.ts";
import type { Config, RuntimeDeps } from "./types.ts";

export interface MakeRuntimeIO {
  readConfig(): Config;
  writeConfig(c: Config): void;
  print(text: string): void;
  embed?: (t: string) => Promise<number[]>;
  qdrant?: QdrantLike;
}

export async function makeRuntime(
  agentDir: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  io: MakeRuntimeIO,
): Promise<RuntimeDeps> {
  const cfg = loadConfig(agentDir, env);
  const projectId = await projectIdFrom(cwd);
  const embeddingClient = new EmbeddingClient(
    cfg.embeddingBaseURL, cfg.embeddingModel, cfg.embeddingApiKey, cfg.expectedDimension);
  const embedder = io.embed ?? ((text: string) => embeddingClient.embed(text));
  const qdrant = io.qdrant ?? (new QdrantClient(cfg.qdrantUrl, cfg.qdrantApiKey) as QdrantLike);
  return {
    cfg,
    agentDir,
    cwd,
    projectId,
    embed: embedder,
    qdrant,
    readConfig: io.readConfig,
    writeConfig: io.writeConfig,
    print: io.print,
  };
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
  rt.qdrant = new QdrantClient(cfg.qdrantUrl, cfg.qdrantApiKey);
}
