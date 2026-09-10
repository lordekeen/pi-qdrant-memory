import test from "node:test";
import assert from "node:assert/strict";
import { EmbeddingClient, EmbeddingError } from "../src/embeddings.ts";

function okJson(body: unknown) {
  return {
    ok: true, status: 200,
    json: async () => body,
  } as Response;
}

test("embed posts correct body and returns vector", async () => {
  const calls: unknown[] = [];
  const client = new EmbeddingClient("http://llama:8080/v1", "nomic-embed-text", null, 768,
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return okJson({ data: [{ embedding: new Array(768).fill(0.5) }] });
    });
  const v = await client.embed("remember this");
  assert.equal(v.length, 768);
  const call = calls[0] as { url: string; init: RequestInit };
  assert.equal(call.url, "http://llama:8080/v1/embeddings");
  const body = JSON.parse(String(call.init.body));
  assert.equal(body.model, "nomic-embed-text");
  assert.deepEqual(body.input, ["remember this"]);
});

test("embed sends bearer token when apiKey present", async () => {
  let auth: string | null | undefined;
  const client = new EmbeddingClient("http://llama:8080/v1", "m", "secret", 768,
    async (_u, init) => {
      auth = (init?.headers as Record<string, string>)?.Authorization;
      return okJson({ data: [{ embedding: new Array(768).fill(0.1) }] });
    });
  await client.embed("x");
  assert.equal(auth, "Bearer secret");
});

test("embed throws EmbeddingError on HTTP error", async () => {
  const client = new EmbeddingClient("http://llama:8080/v1", "m", null, 768,
    async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
  await assert.rejects(() => client.embed("x"), EmbeddingError);
});

test("embed throws EmbeddingError on dimension mismatch", async () => {
  const client = new EmbeddingClient("http://llama:8080/v1", "m", null, 768,
    async () => okJson({ data: [{ embedding: new Array(384).fill(0.1) }] }));
  await assert.rejects(() => client.embed("x"), EmbeddingError);
});

function makeBatchClient(respond: (body: { model: string; input: string[] }) => Response) {
  const calls: Array<{ model: string; input: string[] }> = [];
  const client = new EmbeddingClient("http://llama:8080/v1", "nomic-embed-text", null, 3,
    async (_u, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
      calls.push(body);
      return respond(body);
    });
  return { client, calls };
}

test("embedBatch posts one request with the full input and preserves order", async () => {
  const { client, calls } = makeBatchClient((body) =>
    okJson({ data: body.input.map((_t, i) => ({ index: i, embedding: new Array(3).fill(i) })) }));
  const out = await client.embedBatch(["a", "b", "c"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, ["a", "b", "c"]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], [0, 0, 0]);
  assert.deepEqual(out[2], [2, 2, 2]);
});

test("embedBatch with empty input is a no-op", async () => {
  const { client, calls } = makeBatchClient(() => { throw new Error("should not request"); });
  assert.deepEqual(await client.embedBatch([]), []);
  assert.equal(calls.length, 0);
});

test("embedBatch tolerates servers that omit index by array order", async () => {
  const { client } = makeBatchClient((body) =>
    okJson({ data: body.input.map(() => ({ embedding: new Array(3).fill(1) })) }));
  const out = await client.embedBatch(["a", "b"]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1], [1, 1, 1]);
});

test("embedBatch rejects mismatched item count, gaps, and dimension drift", async () => {
  const short = makeBatchClient(() => okJson({ data: [{ index: 0, embedding: [1, 1, 1] }] }));
  await assert.rejects(() => short.client.embedBatch(["a", "b"]), EmbeddingError);
  const dim = makeBatchClient((body) =>
    okJson({ data: body.input.map(() => ({ index: 0, embedding: [1, 1] })) }));
  await assert.rejects(() => dim.client.embedBatch(["a"]), EmbeddingError);
  const http = makeBatchClient(() => ({ ok: false, status: 500, json: async () => ({}) } as Response));
  await assert.rejects(() => http.client.embedBatch(["a"]), EmbeddingError);
});
