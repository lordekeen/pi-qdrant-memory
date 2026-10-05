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

/** The connection a built client belongs to: `${url}\n${apiKey}`. Keyed on the
 *  client itself, so the record dies with the client it describes. */
const clientConnections = new WeakMap<QdrantLike, string>();

function qdrantConnection(cfg: Config): string {
  return `${cfg.qdrantUrl}\n${cfg.qdrantApiKey ?? ""}`;
}

/**
 * Resolve the Qdrant client for `cfg`, keeping `previous` when the connection
 * fields did not change.
 *
 * Keeping it is not cosmetic: the client owns `ensureCollection`'s readiness
 * memo (and its in-flight ensure map), and `reloadEffectiveConfig()` runs on
 * every `session_start` and after every settings write. Rebuilding
 * unconditionally discarded the memo each time, so the first operation of every
 * session re-verified a collection the store had already confirmed — a `GET`
 * plus the two payload-index `PUT`s. A changed url/apiKey still rebuilds,
 * because the old client would talk to the wrong store.
 */
function resolveQdrant(previous: QdrantLike, cfg: Config): QdrantLike {
  if (clientConnections.get(previous) === qdrantConnection(cfg)) return previous;
  const client = new QdrantClient(cfg.qdrantUrl, cfg.qdrantApiKey) as QdrantLike;
  clientConnections.set(client, qdrantConnection(cfg));
  return client;
}

/**
 * The one client-building path `makeRuntime` and `applyConfig` share: an
 * `EmbeddingClient` + `QdrantClient` pair for `cfg`, with an injected test seam
 * (`resolvedIO`) winning per slot. The per-text and the batched embed are
 * rebound together structurally — wiring only one of them is the stale-client
 * hazard a hot config reload must never reintroduce.
 */
function buildClients(rt: RuntimeDeps, cfg: Config, resolvedIO: RuntimeDeps["resolvedIO"]): RuntimeClients {
  const embeddingClient = new EmbeddingClient(
    cfg.embeddingBaseURL, cfg.embeddingModel, cfg.embeddingApiKey, cfg.expectedDimension);
  return {
    embed: resolvedIO?.embed ?? ((text: string) => embeddingClient.embed(text)),
    embedBatch: resolvedIO?.embedBatch ?? ((texts: string[]) => embeddingClient.embedBatch(texts)),
    qdrant: resolvedIO?.qdrant ?? resolveQdrant(rt.qdrant, cfg),
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
  const rt: RuntimeDeps = {
    cfg: readEffectiveConfig(agentDir, projectId, env),
    agentDir,
    cwd,
    projectId,
    env,
    resolvedIO: { embed: io.embed, embedBatch: io.embedBatch, qdrant: io.qdrant },
    // First attachment: no previous client, so this one is always built. The
    // throwaway embed below is replaced from `clients` before the runtime is
    // returned, and assignments to `rt` cannot pre-empt the closure that reads
    // it (`reloadEffectiveConfig` is only called after assembly).
    embed: async () => [],
    // SAFETY: not a value any caller can observe — `resolveQdrant` reads it
    // before anything else and the placeholder is overwritten with the built
    // client below, still inside this function. It exists only because the
    // runtime must exist to own the client-identity WeakMap entry.
    qdrant: undefined as unknown as QdrantLike,
    embedProbeCache: undefined,
    readGlobalConfig: io.readGlobalConfig,
    writeGlobalConfig: io.writeGlobalConfig,
    print: io.print,
    reloadEffectiveConfig: () => applyConfig(rt, readEffectiveConfig(agentDir, rt.projectId, env)),
  };
  const clients = buildClients(rt, rt.cfg, rt.resolvedIO);
  rt.embed = clients.embed;
  rt.embedBatch = clients.embedBatch;
  rt.qdrant = clients.qdrant;
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
 * together, so the batch embed can never keep talking to a stale client — and
 * `resolveQdrant` keeps the Qdrant client when the connection is unchanged, so
 * a reload does not throw away the readiness memo.
 */
export function applyConfig(rt: RuntimeDeps, cfg: Config): void {
  rt.cfg = cfg;
  rt.embedProbeCache = undefined;
  const clients = buildClients(rt, cfg, rt.resolvedIO);
  rt.embed = clients.embed;
  rt.embedBatch = clients.embedBatch;
  rt.qdrant = clients.qdrant;
}
