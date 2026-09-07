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
