type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Default per-request timeout (ms) — embedding long text on a slow local
 * server can legitimately take seconds, so this is more generous than the
 * Qdrant client's, but still bounded. */
const DEFAULT_TIMEOUT_MS = 30_000;

export class EmbeddingError extends Error {
  constructor(message: string) { super(message); this.name = "EmbeddingError"; }
}

// NOTE: no TypeScript parameter properties here — they are non-erasable syntax and
// would not run under Node's native type stripping. Fields are declared plainly and
// assigned in the constructor body.
export class EmbeddingClient {
  private readonly url: string;
  private readonly model: string;
  private readonly apiKey: string | null;
  private readonly expectedDimension: number;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    baseURL: string,
    model: string,
    apiKey: string | null,
    expectedDimension: number,
    fetchFn: FetchLike = globalThis.fetch as FetchLike,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.url = baseURL.replace(/\/+$/, "") + "/embeddings";
    this.model = model;
    this.apiKey = apiKey;
    this.expectedDimension = expectedDimension;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
  }

  async embed(text: string): Promise<number[]> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.model, input: [text] }),
        // Bounded request: a hanging embedding server must not stall a session.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new EmbeddingError(`Embedding server unreachable at ${this.url}: ${String(err)}`);
    }
    if (!res.ok) {
      throw new EmbeddingError(`Embedding request failed at ${this.url}: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = json.data?.[0]?.embedding;
    if (!embedding) {
      throw new EmbeddingError(`Embedding response missing data[0].embedding from ${this.url}`);
    }
    if (embedding.length !== this.expectedDimension) {
      throw new EmbeddingError(
        `Embedding dimension ${embedding.length} does not match expected ${this.expectedDimension} for model ${this.model}`);
    }
    return embedding;
  }

  /** Batch embedding for the code-memory sync (spec §5/D9): one request per
   * batch of summaries, order-preserving. Empty input is a no-op — never a
   * wasted request. */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new EmbeddingError(`Embedding server unreachable at ${this.url}: ${String(err)}`);
    }
    if (!res.ok) {
      throw new EmbeddingError(`Embedding request failed at ${this.url}: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { data?: Array<{ index?: number; embedding?: number[] }> };
    const data = json.data ?? [];
    if (data.length !== texts.length) {
      throw new EmbeddingError(
        `Embedding batch response has ${String(data.length)} items for ${String(texts.length)} inputs from ${this.url}`);
    }
    // OpenAI-compatible servers return items with an explicit `index`; trust it
    // when present, fall back to array order (some local servers omit it).
    const out: number[][] = Array.from({ length: texts.length });
    for (const item of data) {
      const idx = typeof item.index === "number" && item.index >= 0 && item.index < texts.length
        ? item.index
        : out.findIndex((v) => v === undefined);
      if (!item.embedding) {
        throw new EmbeddingError(`Embedding response missing data[${String(idx)}].embedding from ${this.url}`);
      }
      if (item.embedding.length !== this.expectedDimension) {
        throw new EmbeddingError(
          `Embedding dimension ${String(item.embedding.length)} does not match expected ${String(this.expectedDimension)} for model ${this.model}`);
      }
      out[idx] = item.embedding;
    }
    if (out.some((v) => v === undefined)) {
      throw new EmbeddingError(`Embedding batch response has gaps from ${this.url}`);
    }
    return out;
  }
}
