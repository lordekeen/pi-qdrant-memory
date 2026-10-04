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

/** The clients a runtime talks to, resolved for one `Config`. */
interface RuntimeClients {
  embed: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
  qdrant: QdrantLike;
}

/**
 * The one client-building path `makeRuntime` and `applyConfig` share: an
 * `EmbeddingClient` + `QdrantClient` pair for `cfg`, with an injected test seam
 * (`resolvedIO`) winning per slot. The per-text and the batched embed are
 * rebound together structurally — wiring only one of them is the stale-client
 * hazard a hot config reload must never reintroduce.
 */
function buildClients(cfg: Config, resolvedIO: RuntimeDeps["resolvedIO"]): RuntimeClients {
  const embeddingClient = new EmbeddingClient(
    cfg.embeddingBaseURL, cfg.embeddingModel, cfg.embeddingApiKey, cfg.expectedDimension);
  return {
    embed: resolvedIO?.embed ?? ((text: string) => embeddingClient.embed(text)),
    embedBatch: resolvedIO?.embedBatch ?? ((texts: string[]) => embeddingClient.embedBatch(texts)),
    qdrant: resolvedIO?.qdrant ?? (new QdrantClient(cfg.qdrantUrl, cfg.qdrantApiKey) as QdrantLike),
  };
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
  const resolvedIO = { embed: io.embed, embedBatch: io.embedBatch, qdrant: io.qdrant };
  const rt: RuntimeDeps = {
    cfg,
    agentDir,
    cwd,
    projectId,
    env,
    resolvedIO,
    ...buildClients(cfg, resolvedIO),
    collectionReady: new Set<string>(),
    embedProbeCache: undefined,
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
 * effect immediately instead of at the next session. Respects injected test
 * seams (resolvedIO) when present; `buildClients` rebuilds every client slice
 * together, so the batch embed can never keep talking to a stale client.
 */
export function applyConfig(rt: RuntimeDeps, cfg: Config): void {
  rt.cfg = cfg;
  rt.collectionReady?.clear();
  rt.embedProbeCache = undefined;
  const clients = buildClients(cfg, rt.resolvedIO);
  rt.embed = clients.embed;
  rt.embedBatch = clients.embedBatch;
  rt.qdrant = clients.qdrant;
}
