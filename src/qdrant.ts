import type { MemoryType, PointPayload, SearchHit } from "./types.ts";

export class QdrantError extends Error {
  constructor(message: string) { super(message); this.name = "QdrantError"; }
}

export interface QdrantPoint { id: string; vector: number[]; payload: PointPayload; }

export interface QdrantLike {
  ensureCollection(name: string, dim: number): Promise<"created" | "exists" | "recreated">;
  upsert(name: string, points: QdrantPoint[]): Promise<void>;
  search(name: string, vector: number[], opts: {
    projectId: string; type?: MemoryType; limit: number; threshold: number;
  }): Promise<SearchHit[]>;
  count(name: string): Promise<number>;
  clearCollection(name: string): Promise<void>;
}

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface RequestOpts { notFound?: boolean; }

// NOTE: no TypeScript parameter properties here — they are non-erasable syntax and
// would not run under Node's native type stripping. Fields are declared plainly and
// assigned in the constructor body.
export class QdrantClient implements QdrantLike {
  private readonly base: string;
  private readonly apiKey: string | null;
  private readonly fetchFn: FetchLike;

  constructor(baseURL: string, apiKey: string | null, fetchFn: FetchLike = globalThis.fetch as FetchLike) {
    this.base = baseURL.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
  }

  /**
   * Issue a REST request against the Qdrant base URL.
   * Throws `QdrantError` on any non-OK response and on network failure (never
   * rethrows raw errors). With `opts.notFound`, an HTTP 404 resolves to `null`
   * instead of throwing — used by `ensureCollection` to detect a missing
   * collection (Qdrant answers 404 for an unknown collection).
   */
  private async request(method: string, path: string, body?: unknown, opts: RequestOpts = {}): Promise<unknown> {
    const url = `${this.base}${path}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["api-key"] = this.apiKey;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new QdrantError(`Qdrant unreachable at ${this.base}: ${String(err)}`);
    }
    if (!res.ok) {
      if (opts.notFound && res.status === 404) return null;
      throw new QdrantError(`Qdrant request ${method} ${url} failed: HTTP ${res.status}`);
    }
    return res.json();
  }

  private async createCollection(encName: string, dim: number): Promise<void> {
    await this.request("PUT", `/collections/${encName}`, {
      vectors: { size: dim, distance: "Cosine", on_disk: true },
      hnsw_config: { m: 16, ef_construct: 100 },
    });
  }

  async ensureCollection(name: string, dim: number): Promise<"created" | "exists" | "recreated"> {
    const enc = encodeURIComponent(name);
    const getRes = await this.request("GET", `/collections/${enc}`, undefined, { notFound: true });
    const notExists = getRes === null || (getRes as { status?: string } | null)?.status === "error";
    if (notExists) {
      await this.createCollection(enc, dim);
      return "created";
    }
    const vectors = (getRes as { result: { config: { params: { vectors: { size?: number } } } } })
      .result.config.params.vectors;
    // Defensive: named-vector configs have no top-level `size` — treat as a mismatch.
    const size = typeof vectors?.size === "number" ? vectors.size : undefined;
    if (size !== dim) {
      await this.request("DELETE", `/collections/${enc}`);
      await this.createCollection(enc, dim);
      return "recreated";
    }
    return "exists";
  }

  async upsert(name: string, points: QdrantPoint[]): Promise<void> {
    await this.request("PUT", `/collections/${encodeURIComponent(name)}/points?wait=true`, { points });
  }

  async search(name: string, vector: number[], opts: {
    projectId: string; type?: MemoryType; limit: number; threshold: number;
  }): Promise<SearchHit[]> {
    const must: unknown[] = [{ key: "project_id", match: { value: opts.projectId } }];
    if (opts.type) must.push({ key: "type", match: { value: opts.type } });
    // The query API takes the vector under `query` (score_threshold is rejected for
    // a top-level `vector` in current Qdrant versions).
    const json = await this.request("POST", `/collections/${encodeURIComponent(name)}/points/query`, {
      query: vector,
      limit: opts.limit,
      score_threshold: opts.threshold,
      with_payload: true,
      filter: { must },
    }) as { result: { points: Array<{ id: string; score: number; payload: PointPayload }> } };
    return json.result.points.map((p) => ({ id: p.id, score: p.score, payload: p.payload }));
  }

  async count(name: string): Promise<number> {
    const json = await this.request("POST", `/collections/${encodeURIComponent(name)}/points/count`, { exact: true }) as { result: { count: number } };
    return json.result.count;
  }

  async clearCollection(name: string): Promise<void> {
    await this.request("DELETE", `/collections/${encodeURIComponent(name)}`);
  }
}
