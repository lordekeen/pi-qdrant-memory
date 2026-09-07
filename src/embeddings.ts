type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

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

  constructor(
    baseURL: string,
    model: string,
    apiKey: string | null,
    expectedDimension: number,
    fetchFn: FetchLike = globalThis.fetch as FetchLike,
  ) {
    this.url = baseURL.replace(/\/+$/, "") + "/embeddings";
    this.model = model;
    this.apiKey = apiKey;
    this.expectedDimension = expectedDimension;
    this.fetchFn = fetchFn;
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
}
