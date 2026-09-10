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
  qdrant: QdrantLike;
  readConfig(): Config;
  writeConfig(c: Config): void;
  print(text: string): void;
}

/** The runtime slice remember/search tool logic needs — no output channel. */
export interface ToolDeps {
  cfg: Config;
  projectId: string;
  embed(text: string): Promise<number[]>;
  qdrant: QdrantLike;
}
