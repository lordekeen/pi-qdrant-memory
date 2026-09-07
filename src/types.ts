import type { QdrantLike } from "./qdrant.ts";

export type MemoryType = "decision" | "fact" | "constraint" | "preference" | "session_summary";
export type SourceKind = "blackhole_observation" | "blackhole_reflection" | "remember_tool" | "own_capture";
export type ConfigMode = "auto" | "blackhole" | "own";

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
}

export interface PointPayload {
  type: MemoryType;
  text: string;
  project_id: string;
  session_id?: string;
  source_entry_id?: string;
  ts: number;
  source_kind: SourceKind;
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
