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
