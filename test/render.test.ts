import test from "node:test";
import assert from "node:assert/strict";
import { renderHits } from "../src/render.ts";
import type { PointPayload } from "../src/types.ts";

test("renderHits shows type, score, text, and source pointer", () => {
  const payload: PointPayload = { type: "decision", text: "use REST", project_id: "p", ts: 1, source_kind: "blackhole_reflection", source_entry_id: "id1", session_id: "s9" };
  const out = renderHits([{ id: "x", score: 0.8765, payload }]);
  assert.match(out, /decision/);
  assert.match(out, /0\.88/);
  assert.match(out, /use REST/);
  assert.match(out, /id1/);
});

test("renderHits handles empty results", () => {
  assert.equal(renderHits([]), "No relevant memory found.");
});

test("renderHits tolerates a hit whose payload lacks text", () => {
  const payload = { type: "decision", project_id: "p", ts: 1, source_kind: "blackhole_reflection" } as unknown as PointPayload;
  const out = renderHits([{ id: "x", score: 0.5, payload }]);
  assert.match(out, /0\.50/);
  assert.doesNotThrow(() => renderHits([{ id: "x", score: 0.5, payload }]));
});

test("sourcePointer renders file_path:start_line for line-level code payloads", () => {
  const hits = [{ id: "x", score: 0.9, payload: {
    type: "code", text: "function f — src/a.ts:2-4 — f()", project_id: "p", ts: 1,
    source_kind: "code_summary", file_path: "src/a.ts", start_line: 2, end_line: 4,
  } as PointPayload }];
  assert.match(renderHits(hits), /\(src\/a\.ts:2\)/);
});

test("sourcePointer renders the bare file_path for file-level code payloads", () => {
  const hits = [{ id: "x", score: 0.64, payload: {
    type: "code", text: "src/qdrant.ts — 7 definitions", project_id: "p", ts: 1,
    source_kind: "code_summary", file_path: "src/qdrant.ts",
  } as PointPayload }];
  const out = renderHits(hits);
  assert.match(out, /\(src\/qdrant\.ts\)/);
  assert.doesNotMatch(out, /no source pointer/);
});

test("sourcePointer falls through to 'no source pointer' only without a file_path", () => {
  const hits = [{ id: "x", score: 0.4, payload: {
    type: "fact", text: "orphan", project_id: "p", ts: 1, source_kind: "remember_tool",
  } as PointPayload }];
  assert.match(renderHits(hits), /\(no source pointer\)/);
});
