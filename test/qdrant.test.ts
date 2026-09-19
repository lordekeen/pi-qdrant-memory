import test from "node:test";
import assert from "node:assert/strict";
import { DimensionMismatchError, QdrantClient, QdrantError, redactUrl } from "../src/qdrant.ts";
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

function addIndexRoutes(routes: Map<string, (u: string, i: RequestInit) => Response>, hits: Array<{ field: string; body: { field_name: string; field_schema: string } }> = []): void {
  // Correct Qdrant API (live-verified on 1.19.1): PUT /collections/{name}/index
  // with {field_name, field_schema} — the old path-style route 404s.
  routes.set("PUT http://qdrant:6333/collections/pi-mem-abc/index", (_u, i) => {
    const body = JSON.parse(String(i.body)) as { field_name: string; field_schema: string };
    hits.push({ field: body.field_name, body });
    return jsonRes({ result: { status: "ok" } });
  });
}

test("ensureCollection creates on 404", async () => {
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  const indexed: Array<{ field: string; body: { field_name: string; field_schema: string } }> = [];
  routes.set("GET http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ status: "error" }, 404));
  routes.set("PUT http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ result: true }));
  addIndexRoutes(routes, indexed);
  const client = makeClient(routes);
  assert.equal(await client.ensureCollection("pi-mem-abc", 768), "created");
  const fields = indexed.map((h) => h.field).sort();
  assert.deepEqual(fields, ["file_path", "source_kind"]);
  for (const h of indexed) {
    assert.deepEqual(h.body, { field_name: h.field, field_schema: "keyword" });
  }
});

test("ensureCollection recreates on dimension mismatch when opted in", async () => {
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  const indexed: Array<{ field: string; body: { field_name: string; field_schema: string } }> = [];
  routes.set("GET http://qdrant:6333/collections/pi-mem-abc", () =>
    jsonRes({ result: { config: { params: { vectors: { size: 384 } } } } }));
  routes.set("DELETE http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ result: true }));
  routes.set("PUT http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ result: true }));
  addIndexRoutes(routes, indexed);
  const client = makeClient(routes);
  assert.equal(await client.ensureCollection("pi-mem-abc", 768, { onDimensionMismatch: "recreate" }), "recreated");
  assert.equal(indexed.length, 2);
});

test("ensureCollection throws DimensionMismatchError on mismatch by default and issues no DELETE", async () => {
  let deleted = false;
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("GET http://qdrant:6333/collections/pi-mem-abc", () =>
    jsonRes({ result: { config: { params: { vectors: { size: 384 } } } } }));
  routes.set("DELETE http://qdrant:6333/collections/pi-mem-abc", () => {
    deleted = true;
    return jsonRes({ result: true });
  });
  const client = makeClient(routes);
  await assert.rejects(
    () => client.ensureCollection("pi-mem-abc", 768),
    (err: unknown) => {
      assert.ok(err instanceof DimensionMismatchError);
      assert.equal((err as DimensionMismatchError).stored, 384);
      assert.equal((err as DimensionMismatchError).expected, 768);
      return true;
    },
  );
  assert.equal(deleted, false);
});

test("ensureCollection memoizes verified collection on QdrantClient instance (OI-010)", async () => {
  let requests = 0;
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("GET http://qdrant:6333/collections/pi-mem-abc", () => {
    requests++;
    return jsonRes({ result: { config: { params: { vectors: { size: 768 } } } } });
  });
  routes.set("PUT http://qdrant:6333/collections/pi-mem-abc/index", () => {
    requests++;
    return jsonRes({ result: true });
  });
  routes.set("DELETE http://qdrant:6333/collections/pi-mem-abc", () => {
    requests++;
    return jsonRes({ result: true });
  });
  const client = makeClient(routes);
  assert.equal(await client.ensureCollection("pi-mem-abc", 768), "exists");
  const initialRequests = requests;
  assert.ok(initialRequests > 0);
  // Second call: memoized, zero additional requests
  assert.equal(await client.ensureCollection("pi-mem-abc", 768), "exists");
  assert.equal(requests, initialRequests);

  // Clear collection invalidates the memo
  await client.clearCollection("pi-mem-abc");
  assert.equal(await client.ensureCollection("pi-mem-abc", 768), "exists");
  assert.ok(requests > initialRequests + 1);
});

test("ensureCollection deduplicates in-flight concurrent calls for the same collection", async () => {
  let getCalls = 0;
  let putCalls = 0;
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("GET http://qdrant:6333/collections/pi-mem-abc", () => {
    getCalls++;
    return jsonRes({ status: "error" }, 404);
  });
  routes.set("PUT http://qdrant:6333/collections/pi-mem-abc", () => {
    putCalls++;
    return jsonRes({ result: true });
  });
  routes.set("PUT http://qdrant:6333/collections/pi-mem-abc/index", () => jsonRes({ result: true }));
  const client = makeClient(routes);
  const [res1, res2, res3] = await Promise.all([
    client.ensureCollection("pi-mem-abc", 768),
    client.ensureCollection("pi-mem-abc", 768),
    client.ensureCollection("pi-mem-abc", 768),
  ]);
  assert.equal(res1, "created");
  assert.equal(res2, "created");
  assert.equal(res3, "created");
  assert.equal(getCalls, 1, "only one GET request should be issued for concurrent calls");
  assert.equal(putCalls, 1, "only one PUT request should be issued for concurrent calls");
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

test("count throws QdrantError with status 404 when collection does not exist", async () => {
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points/count", () =>
    jsonRes({ status: "error", message: "Not found" }, 404));
  const client = makeClient(routes);
  await assert.rejects(
    () => client.count("pi-mem-abc"),
    (err: unknown) => err instanceof QdrantError && err.status === 404,
  );
});

test("countBySourceKind counts points matching source_kind filter", async () => {
  let seenBody: unknown;
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points/count", (_u, i) => {
    seenBody = JSON.parse(String(i.body));
    return jsonRes({ result: { count: 42 } });
  });
  const client = makeClient(routes);
  const count = await client.countBySourceKind("pi-mem-abc", "code_summary");
  assert.equal(count, 42);
  assert.deepEqual(seenBody, {
    filter: { must: [{ key: "source_kind", match: { value: "code_summary" } }] },
    exact: true,
  });
});

test("countCodeSymbols excludes file anchors (is_empty symbol) (#49)", async () => {
  let seenBody: unknown;
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points/count", (_u, i) => {
    seenBody = JSON.parse(String(i.body));
    return jsonRes({ result: { count: 3 } });
  });
  const client = makeClient(routes);
  const count = await client.countCodeSymbols("pi-mem-abc");
  assert.equal(count, 3);
  assert.deepEqual(seenBody, {
    filter: {
      must: [{ key: "source_kind", match: { value: "code_summary" } }],
      must_not: [{ is_empty: { key: "symbol" } }],
    },
    exact: true,
  });
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

test("deletePointsBySourceKind sends filter for source_kind", async () => {
  const bodies: unknown[] = [];
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points/delete", (_u, i) => {
    bodies.push(JSON.parse(String(i.body)));
    return jsonRes({ result: { status: "completed" } });
  });
  const client = makeClient(routes);
  await client.deletePointsBySourceKind("pi-mem-abc", "code_summary");
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0], {
    filter: { must: [{ key: "source_kind", match: { value: "code_summary" } }] },
  });
});

test("deletePointsBySourceEntryIds sends match any filter and chunks by 50", async () => {
  const bodies: unknown[] = [];
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points/delete", (_u, i) => {
    bodies.push(JSON.parse(String(i.body)));
    return jsonRes({ result: { status: "completed" } });
  });
  const client = makeClient(routes);
  await client.deletePointsBySourceEntryIds("pi-mem-abc", []);
  assert.equal(bodies.length, 0);

  const ids = Array.from({ length: 65 }, (_, i) => `entry-${i}`);
  await client.deletePointsBySourceEntryIds("pi-mem-abc", ids);
  assert.equal(bodies.length, 2);
  assert.deepEqual((bodies[0] as { filter: { must: Array<{ key: string; match: { any: string[] } }> } }).filter.must[0], {
    key: "source_entry_id",
    match: { any: ids.slice(0, 50) },
  });
  assert.deepEqual((bodies[1] as { filter: { must: Array<{ key: string; match: { any: string[] } }> } }).filter.must[0], {
    key: "source_entry_id",
    match: { any: ids.slice(50) },
  });
});

test("deletePointsByIds sends point list, chunks by 50, and returns deleted count", async () => {
  const bodies: unknown[] = [];
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points/delete", (_u, i) => {
    bodies.push(JSON.parse(String(i.body)));
    return jsonRes({ result: { status: "completed" } });
  });
  const client = makeClient(routes);
  const count0 = await client.deletePointsByIds("pi-mem-abc", []);
  assert.equal(count0, 0);
  assert.equal(bodies.length, 0);

  const ids = Array.from({ length: 55 }, (_, i) => `pt-${i}`);
  const count = await client.deletePointsByIds("pi-mem-abc", ids);
  assert.equal(count, 55);
  assert.equal(bodies.length, 2);
  assert.deepEqual((bodies[0] as { points: string[] }).points, ids.slice(0, 50));
  assert.deepEqual((bodies[1] as { points: string[] }).points, ids.slice(50));
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

test("redactUrl strips username and password", () => {
  assert.equal(
    redactUrl("http://user:s3cret@host:6333/path"),
    "http://***:***@host:6333/path",
  );
});

test("redactUrl is a no-op when no credentials present", () => {
  assert.equal(redactUrl("http://host:6333"), "http://host:6333/");
});

test("redactUrl returns unparseable URLs unchanged", () => {
  assert.equal(redactUrl("not-a-url"), "not-a-url");
});

test("existingPointIds queries Qdrant and returns set of found point ids (#17)", async () => {
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  let requestedBody: unknown;
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points", (_u, i) => {
    requestedBody = JSON.parse(String(i.body));
    return jsonRes({
      result: [{ id: "id1" }, { id: "id3" }],
    });
  });
  const client = makeClient(routes);
  const found = await client.existingPointIds("pi-mem-abc", ["id1", "id2", "id3"]);
  assert.deepEqual(requestedBody, { ids: ["id1", "id2", "id3"], with_payload: false, with_vector: false });
  assert.equal(found.size, 2);
  assert.ok(found.has("id1"));
  assert.ok(!found.has("id2"));
  assert.ok(found.has("id3"));

  // Empty ids returns empty set without network request
  const empty = await client.existingPointIds("pi-mem-abc", []);
  assert.equal(empty.size, 0);
});

test("existingPointIds returns empty set on 404 (missing collection)", async () => {
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points", () =>
    jsonRes({ status: "error", message: "Not found" }, 404));
  const client = makeClient(routes);
  const found = await client.existingPointIds("pi-mem-abc", ["id1"]);
  assert.equal(found.size, 0);
});

test("existingPointIds throws QdrantError on network or server failure", async () => {
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points", () =>
    jsonRes({ status: "error", message: "Internal server error" }, 500));
  const client = makeClient(routes);
  await assert.rejects(
    () => client.existingPointIds("pi-mem-abc", ["id1"]),
    QdrantError,
  );
});

test("deletePointsByFiles survives 404 cleanly when collection does not exist", async () => {
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points/delete", () =>
    jsonRes({ status: "error", message: "Not found" }, 404));
  const client = makeClient(routes);
  await client.deletePointsByFiles("pi-mem-abc", ["src/a.ts"]);
});

test("existingPointIds chunks requests above 50 ids", async () => {
  let calls = 0;
  const chunkSizes: number[] = [];
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points", (_u, i) => {
    calls++;
    const body = JSON.parse(String(i.body)) as { ids: string[] };
    chunkSizes.push(body.ids.length);
    return jsonRes({
      result: body.ids.slice(0, 1).map((id) => ({ id })),
    });
  });
  const client = makeClient(routes);
  const ids = Array.from({ length: 120 }, (_, k) => `id${k}`);
  const found = await client.existingPointIds("pi-mem-abc", ids);
  assert.equal(calls, 3);
  assert.deepEqual(chunkSizes, [50, 50, 20]);
  assert.equal(found.size, 3);
  assert.ok(found.has("id0"));
  assert.ok(found.has("id50"));
  assert.ok(found.has("id100"));
});


