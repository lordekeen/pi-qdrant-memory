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

function addIndexRoutes(routes: Map<string, (u: string, i: RequestInit) => Response>, hits: string[] = []): void {
  for (const field of ["source_kind", "file_path"]) {
    routes.set(`PUT http://qdrant:6333/collections/pi-mem-abc/index/${field}`, (_u, _i) => {
      hits.push(field);
      return jsonRes({ result: { status: "ok" } });
    });
  }
}

test("ensureCollection creates on 404", async () => {
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  const indexed: string[] = [];
  routes.set("GET http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ status: "error" }, 404));
  routes.set("PUT http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ result: true }));
  addIndexRoutes(routes, indexed);
  const client = makeClient(routes);
  assert.equal(await client.ensureCollection("pi-mem-abc", 768), "created");
  assert.deepEqual(indexed.sort(), ["file_path", "source_kind"]);
});

test("ensureCollection recreates on dimension mismatch", async () => {
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  const indexed: string[] = [];
  routes.set("GET http://qdrant:6333/collections/pi-mem-abc", () =>
    jsonRes({ result: { config: { params: { vectors: { size: 384 } } } } }));
  routes.set("DELETE http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ result: true }));
  routes.set("PUT http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ result: true }));
  addIndexRoutes(routes, indexed);
  const client = makeClient(routes);
  assert.equal(await client.ensureCollection("pi-mem-abc", 768), "recreated");
  assert.equal(indexed.length, 2);
});

test("payload index failures are non-fatal", async () => {
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("GET http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ status: "error" }, 404));
  routes.set("PUT http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ result: true }));
  routes.set("PUT http://qdrant:6333/collections/pi-mem-abc/index/source_kind", () => jsonRes({ err: 1 }, 500));
  routes.set("PUT http://qdrant:6333/collections/pi-mem-abc/index/file_path", () => jsonRes({ result: { status: "ok" } }));
  const client = makeClient(routes);
  assert.equal(await client.ensureCollection("pi-mem-abc", 768), "created");
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

test("untyped search excludes code points; typed search filters by type", async () => {
  const bodies: unknown[] = [];
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points/query", (_u, i) => {
    bodies.push(JSON.parse(String(i.body)));
    return jsonRes({ result: { points: [] } });
  });
  const client = makeClient(routes);
  await client.search("pi-mem-abc", [0.1], { projectId: "p", limit: 5, threshold: 0.18 });
  await client.search("pi-mem-abc", [0.1], { projectId: "p", type: "code", limit: 5, threshold: 0.4 });
  const untyped = bodies[0] as { filter: { must: unknown[]; must_not: Array<Record<string, unknown>> } };
  const typed = bodies[1] as { filter: { must: Array<Record<string, unknown>>; must_not: unknown[] } };
  assert.deepEqual(untyped.filter.must_not, [{ key: "type", match: { value: "code" } }]);
  assert.equal(typed.filter.must_not.length, 0);
  assert.deepEqual(typed.filter.must[1], { key: "type", match: { value: "code" } });
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

test("deletePointsByFiles builds should-of-must filters and no-ops on empty", async () => {
  const bodies: unknown[] = [];
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points/delete", (_u, i) => {
    bodies.push(JSON.parse(String(i.body)));
    return jsonRes({ result: { status: "completed" } });
  });
  const client = makeClient(routes);
  await client.deletePointsByFiles("pi-mem-abc", []);
  assert.equal(bodies.length, 0);
  await client.deletePointsByFiles("pi-mem-abc", ["src/a.ts", "src/b.ts"]);
  assert.equal(bodies.length, 1);
  const body = bodies[0] as { filter: { should: Array<{ must: Array<Record<string, unknown>> }> } };
  assert.equal(body.filter.should.length, 2);
  assert.deepEqual(body.filter.should[0].must[0], { key: "file_path", match: { value: "src/a.ts" } });
});

test("deletePointsByFiles chunks above 50 paths and survives errors", async () => {
  let calls = 0;
  let failed = 0;
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points/delete", (_u, _i) => {
    calls++;
    if (calls === 1) { failed++; return jsonRes({ err: 1 }, 500); }
    return jsonRes({ result: { status: "completed" } });
  });
  const client = makeClient(routes);
  const paths = Array.from({ length: 60 }, (_, k) => `src/f${String(k)}.ts`);
  await client.deletePointsByFiles("pi-mem-abc", paths);
  assert.equal(calls, 2); // 50 + 10
  assert.equal(failed, 1); // first chunk's error did not abort the second
});

test("codeIndexSnapshot pages through scroll results and skips malformed payloads", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points/scroll", (_u, i) => {
    const body = JSON.parse(String(i.body)) as Record<string, unknown>;
    bodies.push(body);
    if (bodies.length === 1) {
      return jsonRes({
        result: {
          points: [
            { payload: { file_path: "src/a.ts", file_sha: "aaa" } },
            { payload: { file_path: "src/broken.ts" } }, // missing sha → skipped
          ],
          next_page_offset: "next-1",
        },
      });
    }
    return jsonRes({
      result: { points: [{ payload: { file_path: "src/b.ts", file_sha: "bbb" } }], next_page_offset: null },
    });
  });
  const client = makeClient(routes);
  const snap = await client.codeIndexSnapshot("pi-mem-abc");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].offset, "next-1");
  assert.equal(snap.size, 2);
  assert.equal(snap.get("src/a.ts"), "aaa");
  assert.equal(snap.get("src/b.ts"), "bbb");
  assert.equal(snap.has("src/broken.ts"), false);
});
