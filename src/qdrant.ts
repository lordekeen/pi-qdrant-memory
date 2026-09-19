import type { MemoryType, PointPayload, SearchHit } from "./types.ts";

/** Default per-request timeout (ms) — a hanging Qdrant must never stall a
 * session_start ingest or a slash command indefinitely. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Strip any userinfo credentials from a URL before it lands in an error
 * message that will be echoed to the TUI. */
export function redactUrl(url: string): string {
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

export class DimensionMismatchError extends QdrantError {
  readonly stored?: number;
  readonly expected: number;
  constructor(name: string, stored: number | undefined, expected: number) {
    super(
      `collection ${name} dim ${String(stored)} ≠ expectedDimension ${expected} — collection left untouched; move it aside or set the matching model`,
    );
    this.name = "DimensionMismatchError";
    this.stored = stored;
    this.expected = expected;
  }
}

export interface EnsureCollectionOptions {
  onDimensionMismatch?: "error" | "recreate";
}

export interface QdrantPoint { id: string; vector: number[]; payload: PointPayload; }

export interface QdrantLike {
  ensureCollection(
    name: string,
    dim: number,
    opts?: EnsureCollectionOptions,
  ): Promise<"created" | "exists" | "recreated">;
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
  /** Delete points matching a source_kind filter. */
  deletePointsBySourceKind?(name: string, kind: string): Promise<void>;
  /** Delete points matching source_entry_id values (Layer 1 ingest supersede). */
  deletePointsBySourceEntryIds?(name: string, ids: string[]): Promise<void>;
  /** Delete points by their point IDs. Returns the count of IDs deleted. */
  deletePointsByIds?(name: string, ids: string[]): Promise<number>;
  /** Retrieve the subset of given point IDs that already exist in the collection. */
  existingPointIds?(name: string, ids: string[]): Promise<Set<string>>;
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
  private readonly ensured = new Map<string, number>();
  private readonly ensurePromises = new Map<string, Promise<"created" | "exists" | "recreated">>();

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

  async ensureCollection(
    name: string,
    dim: number,
    opts?: EnsureCollectionOptions,
  ): Promise<"created" | "exists" | "recreated"> {
    if (this.ensured.get(name) === dim) return "exists";
    const onMismatch = opts?.onDimensionMismatch ?? "error";
    const key = `${name}:${dim}:${onMismatch}`;
    const inFlight = this.ensurePromises.get(key);
    if (inFlight) return inFlight;

    const promise = (async () => {
      try {
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
            if (onMismatch === "error") {
              throw new DimensionMismatchError(name, size, dim);
            }
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
        this.ensured.set(name, dim);
        return outcome;
      } finally {
        this.ensurePromises.delete(key);
      }
    })();

    this.ensurePromises.set(key, promise);
    return promise;
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
      // query excludes them so durable memory stays pure conversation knowledge.
      mustNot.push({ key: "type", match: { value: "code" } });
    }
    const json = await this.request("POST", `/collections/${encodeURIComponent(name)}/points/query`, {
      query: vector,
      filter: { must, must_not: mustNot },
      limit: opts.limit,
      score_threshold: opts.threshold,
      with_payload: true,
      with_vector: false,
    }) as { result: { points: Array<{ id: string; score: number; payload: PointPayload }> } };
    return (json.result.points ?? []).map((p) => ({
      id: p.id,
      score: p.score,
      payload: p.payload,
    }));
  }

  async count(name: string): Promise<number> {
    const json = await this.request("POST",
      `/collections/${encodeURIComponent(name)}/points/count`,
      { exact: true },
    ) as { result: { count: number } };
    return json.result.count;
  }

  async countBySourceKind(name: string, kind: string): Promise<number> {
    const json = await this.request("POST",
      `/collections/${encodeURIComponent(name)}/points/count`,
      { filter: { must: [{ key: "source_kind", match: { value: kind } }] }, exact: true },
      { notFound: true },
    ) as { result?: { count: number } } | null;
    return json?.result?.count ?? 0;
  }

  async deletePointsBySourceKind(name: string, kind: string): Promise<void> {
    const enc = encodeURIComponent(name);
    await this.request("POST", `/collections/${enc}/points/delete`, {
      filter: { must: [{ key: "source_kind", match: { value: kind } }] },
    }, { notFound: true });
  }

  async deletePointsBySourceEntryIds(name: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const enc = encodeURIComponent(name);
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      await this.request("POST", `/collections/${enc}/points/delete`, {
        filter: {
          must: [{ key: "source_entry_id", match: { any: chunk } }],
        },
      }, { notFound: true });
    }
  }

  async deletePointsByIds(name: string, ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const enc = encodeURIComponent(name);
    let total = 0;
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      await this.request("POST", `/collections/${enc}/points/delete`, {
        points: chunk,
      }, { notFound: true });
      total += chunk.length;
    }
    return total;
  }

  async clearCollection(name: string): Promise<void> {
    await this.request("DELETE", `/collections/${encodeURIComponent(name)}`);
    this.ensured.delete(name);
    for (const key of this.ensurePromises.keys()) {
      if (key.startsWith(`${name}:`)) this.ensurePromises.delete(key);
    }
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

  async existingPointIds(name: string, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const enc = encodeURIComponent(name);
    const json = await this.request("POST", `/collections/${enc}/points`, {
      ids,
      with_payload: false,
      with_vector: false,
    }, { notFound: true }) as { result?: Array<{ id: string | number }> } | null;
    const found = new Set<string>();
    for (const p of json?.result ?? []) {
      const strId = String(p.id);
      found.add(strId);
      // Qdrant normalizes UUIDs with hyphens even when ingested without hyphens;
      // indexing both forms guarantees matching regardless of representation.
      found.add(strId.replace(/-/g, ""));
    }
    return found;
  }
}
