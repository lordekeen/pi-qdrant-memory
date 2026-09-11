import type { QdrantLike } from "./qdrant.ts";

export type MemoryType = "decision" | "fact" | "constraint" | "preference" | "session_summary" | "code";
export type SourceKind = "blackhole_observation" | "blackhole_reflection" | "remember_tool" | "own_capture" | "code_summary";
export type ConfigMode = "auto" | "blackhole" | "own";
export type CodeKnowledgeMode = "off" | "on";

export interface Config {
  qdrantUrl: string;
  qdrantApiKey: string | null;
  embeddingBaseURL: string;
  embeddingModel: string;
  embeddingApiKey: string | null;
  expectedDimension: number;
  scoreThreshold: number;
  maxResults: number;
  mode: ConfigMode;
  codeKnowledge: CodeKnowledgeMode;
  codeScoreThreshold: number;
}

export interface PointPayload {
  type: MemoryType;
  text: string;
  project_id: string;
  session_id?: string;
  source_entry_id?: string;
  ts: number;
  source_kind: SourceKind;
  /** Code-summary points only (source_kind "code_summary"): provenance for
   * delete-by-file invalidation and rich source pointers. */
  file_path?: string;
  file_sha?: string;
  symbol?: string;
  start_line?: number;
  end_line?: number;
}

export interface SearchHit {
  id: string;
  score: number;
  payload: PointPayload;
}

export interface RuntimeDeps {
  cfg: Config;
  agentDir: string;
  cwd: string;
  projectId: string;
  embed: (text: string) => Promise<number[]>;
  /** Batched variant for the code-memory sync; falls back to per-text embed
   * when the runtime was assembled without a batching client (tests). */
  embedBatch?: (texts: string[]) => Promise<number[][]>;
  qdrant: QdrantLike;
  /** The global file reader (env → file → DEFAULTS); the persist side of a
   * non-allowlisted settings write (D10). */
  readGlobalConfig(): Config;
  /** Persist the full global file (D10); never materialize a project override. */
  writeGlobalConfig(c: Config): void;
  print(text: string): void;
  /** Re-resolve env → project → global → DEFAULTS for the current `projectId`
   * and swap it into the live runtime (swap clients, never re-register). */
  reloadEffectiveConfig(): void;
}

/** The runtime slice remember/search tool logic needs — no output channel. */
export interface ToolDeps {
  cfg: Config;
  projectId: string;
  embed(text: string): Promise<number[]>;
  qdrant: QdrantLike;
}
