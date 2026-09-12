import type { MemoryType, PointPayload, SearchHit } from "./types.ts";

/** Default per-request timeout (ms) — a hanging Qdrant must never stall a
 * session_start ingest or a slash command indefinitely. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Strip any userinfo credentials from a URL before it lands in an error
 * message that will be echoed to the TUI. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "***";
    }
    return u.toString();
  } catch {
    return url;
  }
}

export class QdrantError extends Error {
  /** HTTP status when the failure was a non-OK response; undefined on network
   * errors. Callers branch on this (e.g. 404 = collection missing) instead of
   * regex-matching the message text. */
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "QdrantError";
    this.status = status;
  }
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
  /** Delete all code-summary points for the given file paths (non-fatal). */
  deletePointsByFiles(name: string, filePaths: string[]): Promise<void>;
  /** Previously indexed code files: file_path → file_sha. */
  codeIndexSnapshot(name: string): Promise<Map<string, string>>;
  /** Count points matching a source_kind filter. */
  countBySourceKind(name: string, kind: string): Promise<number>;
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
  private readonly timeoutMs: number;

  constructor(baseURL: string, apiKey: string | null, fetchFn: FetchLike = globalThis.fetch as FetchLike, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.base = baseURL.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
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
        // Bounded request: a hanging server must not stall session startup.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new QdrantError(`Qdrant unreachable at ${redactUrl(this.base)}: ${String(err)}`);
    }
    if (!res.ok) {
      if (opts.notFound && res.status === 404) return null;
      throw new QdrantError(`Qdrant request ${method} ${redactUrl(url)} failed: HTTP ${res.status}`, res.status);
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
    let outcome: "created" | "exists" | "recreated";
    if (notExists) {
      await this.createCollection(enc, dim);
      outcome = "created";
    } else {
      const vectors = (getRes as { result: { config: { params: { vectors: { size?: number } } } } })
        .result.config.params.vectors;
      // Defensive: named-vector configs have no top-level `size` — treat as a mismatch.
      const size = typeof vectors?.size === "number" ? vectors.size : undefined;
      if (size !== dim) {
        // Loud, deliberate data-loss guard: a dimension mismatch means the stored
        // vectors are incompatible with the configured embedding model — deleting
        // the collection wipes every memory for this project. Never silent.
        console.error(
          `pi-qdrant-memory: WARNING recreating collection ${name} — vector size ${String(size)} does not match expected ${String(dim)}; all stored memories for this project are deleted`);
        await this.request("DELETE", `/collections/${enc}`);
        await this.createCollection(enc, dim);
        outcome = "recreated";
      } else {
        outcome = "exists";
      }
    }
    await this.createPayloadIndexes(enc, name);
    return outcome;
  }

  /** Payload keyword indexes accelerate the filtered deletes and scroll used by
   * code-memory sync (Zoo-Code's pathSegments-index lesson). Idempotent on the
   * Qdrant side; failures are logged and never fatal — search and upsert work
   * unindexed, just slower.
   *
   * Request shape verified against live Qdrant 1.19.1: `PUT /collections/{name}/index`
   * with `{field_name, field_schema}`. The previously-shipped path-style route
   * (`/index/{field}`) returns 404 on current Qdrant and never created anything
   * (review finding 2 — a plan-level bug faithfully implemented). */
  private async createPayloadIndexes(enc: string, name: string): Promise<void> {
    for (const field of ["source_kind", "file_path"]) {
      try {
        await this.request("PUT", `/collections/${enc}/index`, {
          field_name: field,
          field_schema: "keyword",
        });
      } catch (err) {
        console.error(`pi-qdrant-memory: payload index ${field} on ${name} failed (non-fatal): ${String(err)}`);
      }
    }
  }

  async upsert(name: string, points: QdrantPoint[]): Promise<void> {
    await this.request("PUT", `/collections/${encodeURIComponent(name)}/points?wait=true`, { points });
  }

  async search(name: string, vector: number[], opts: {
    projectId: string; type?: MemoryType; limit: number; threshold: number;
  }): Promise<SearchHit[]> {
    const must: unknown[] = [{ key: "project_id", match: { value: opts.projectId } }];
    const mustNot: unknown[] = [];
    if (opts.type) {
      must.push({ key: "type", match: { value: opts.type } });
    }
    if (opts.type !== "code") {
      // Code-summary points belong to the code_memory surface — every non-code
      // query (typed or untyped) excludes them (spec §13 / D8).
      mustNot.push({ key: "type", match: { value: "code" } });
    }
    // The query API takes the vector under `query` (score_threshold is rejected for
    // a top-level `vector` in current Qdrant versions).
    const json = await this.request("POST", `/collections/${encodeURIComponent(name)}/points/query`, {
      query: vector,
      limit: opts.limit,
      score_threshold: opts.threshold,
      with_payload: true,
      filter: { must, must_not: mustNot },
    }) as { result: { points: Array<{ id: string; score: number; payload: PointPayload }> } };
    return json.result.points.map((p) => ({ id: p.id, score: p.score, payload: p.payload }));
  }

  async count(name: string): Promise<number> {
    const json = await this.request("POST", `/collections/${encodeURIComponent(name)}/points/count`, { exact: true }) as { result: { count: number } };
    return json.result.count;
  }

  async countBySourceKind(name: string, kind: string): Promise<number> {
    const json = await this.request("POST",
      `/collections/${encodeURIComponent(name)}/points/count`,
      { filter: { must: [{ key: "source_kind", match: { value: kind } }] }, exact: true },
    ) as { result: { count: number } };
    return json.result.count;
  }

  async clearCollection(name: string): Promise<void> {
    await this.request("DELETE", `/collections/${encodeURIComponent(name)}`);
  }

  /** Delete all code-summary points for the given file paths (spec §8.2).
   * Deliberately non-fatal like Zoo-Code's deletes: a failed cleanup must never
   * break a sync — the next sync retries. */
  async deletePointsByFiles(name: string, filePaths: string[]): Promise<void> {
    if (!filePaths.length) return;
    const enc = encodeURIComponent(name);
    for (let i = 0; i < filePaths.length; i += 50) {
      const chunk = filePaths.slice(i, i + 50);
      try {
        await this.request("POST", `/collections/${enc}/points/delete`, {
          filter: {
            should: chunk.map((p) => ({ must: [{ key: "file_path", match: { value: p } }] })),
          },
        });
      } catch (err) {
        console.error(`pi-qdrant-memory: code point delete failed (non-fatal): ${String(err)}`);
      }
    }
  }

  /** Previously indexed code files: file_path → file_sha (spec §8.3). Malformed
   * payloads (missing fields) are skipped defensively — the diff re-indexes them. */
  async codeIndexSnapshot(name: string): Promise<Map<string, string>> {
    const enc = encodeURIComponent(name);
    const out = new Map<string, string>();
    let offset: string | number | undefined;
    for (;;) {
      const body: Record<string, unknown> = {
        filter: { must: [{ key: "source_kind", match: { value: "code_summary" } }] },
        with_payload: ["file_path", "file_sha"],
        limit: 256,
      };
      if (offset !== undefined) body.offset = offset;
      const json = await this.request("POST", `/collections/${enc}/points/scroll`, body) as {
        result: {
          points: Array<{ payload?: { file_path?: unknown; file_sha?: unknown } | null }>;
          next_page_offset?: string | number | null;
        };
      };
      for (const p of json.result.points) {
        const fp = p.payload?.file_path;
        const sha = p.payload?.file_sha;
        if (typeof fp === "string" && typeof sha === "string") out.set(fp, sha);
      }
      const next = json.result.next_page_offset;
      if (next === null || next === undefined) break;
      offset = next;
    }
    return out;
  }
}
