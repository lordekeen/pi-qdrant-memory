import test from "node:test";
import assert from "node:assert/strict";
import { QdrantClient, QdrantError } from "../src/qdrant.ts";
import type { PointPayload } from "../src/types.ts";

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function makeClient(routes: Map<string, (url: string, init: RequestInit) => Response>) {
  return new QdrantClient("http://qdrant:6333", null,
    async (u, init) => {
      const url = String(u);
      const method = (init?.method ?? "GET") as string;
      const key = `${method} ${url}`;
      const handler = routes.get(key) ?? routes.get(method);
      if (!handler) throw new Error(`unexpected ${key}`);
      return handler(url, init ?? {});
    });
}

const payload: PointPayload = {
  type: "decision", text: "use REST", project_id: "pi-mem-abc", ts: 1, source_kind: "remember_tool",
};

test("ensureCollection creates on 404", async () => {
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("GET http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ status: "error" }, 404));
  routes.set("PUT http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ result: true }));
  const client = makeClient(routes);
  assert.equal(await client.ensureCollection("pi-mem-abc", 768), "created");
});

test("ensureCollection recreates on dimension mismatch", async () => {
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("GET http://qdrant:6333/collections/pi-mem-abc", () =>
    jsonRes({ result: { config: { params: { vectors: { size: 384 } } } } }));
  routes.set("DELETE http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ result: true }));
  routes.set("PUT http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ result: true }));
  const client = makeClient(routes);
  assert.equal(await client.ensureCollection("pi-mem-abc", 768), "recreated");
});

test("upsert posts points with wait=true", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("PUT http://qdrant:6333/collections/pi-mem-abc/points?wait=true", (u, i) => {
    seen = { url: u, init: i }; return jsonRes({ result: { status: "completed" } });
  });
  const client = makeClient(routes);
  await client.upsert("pi-mem-abc", [{ id: "aa", vector: [0.1, 0.2], payload }]);
  const body = JSON.parse(String(seen!.init.body)) as { points: Array<{ id: string; vector: number[]; payload: PointPayload }> };
  assert.equal(body.points.length, 1);
  assert.equal(body.points[0].payload.source_kind, "remember_tool");
});

test("search builds query with project_id filter and maps hits", async () => {
  let seenBody: unknown;
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points/query", (_u, i) => {
    seenBody = JSON.parse(String(i.body));
    return jsonRes({ result: { points: [{ id: "aa", score: 0.9, payload }] } });
  });
  const client = makeClient(routes);
  const hits = await client.search("pi-mem-abc", [0.1], { projectId: "pi-mem-abc", limit: 5, threshold: 0.15 });
  const body = seenBody as { filter: { must: Array<Record<string, unknown>> }; score_threshold: number; limit: number };
  assert.equal(body.score_threshold, 0.15);
  assert.equal(body.limit, 5);
  assert.deepEqual(body.filter.must[0], { key: "project_id", match: { value: "pi-mem-abc" } });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].payload.type, "decision");
});

test("count returns point count", async () => {
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points/count", () =>
    jsonRes({ result: { count: 7 } }));
  const client = makeClient(routes);
  assert.equal(await client.count("pi-mem-abc"), 7);
});

test("network errors are wrapped as QdrantError", async () => {
  const client = new QdrantClient("http://qdrant:6333", null,
    async () => { throw new Error("ECONNREFUSED"); });
  await assert.rejects(() => client.count("pi-mem-abc"), QdrantError);
});
