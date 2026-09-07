import test from "node:test";
import assert from "node:assert/strict";
import { canonicalString, contentHash, normalizeText, pointId } from "../src/ids.ts";

test("normalizeText trims and collapses whitespace", () => {
  assert.equal(normalizeText("  we   chose X\n\n over Y  "), "we chose X over Y");
});

test("canonicalString joins normalized text, source_kind, contextId with pipes", () => {
  assert.equal(canonicalString(" use REST ", "remember_tool", "sess1"),
    "use REST|remember_tool|sess1");
});

test("pointId is 32 hex chars and stable for equal inputs", () => {
  const a = pointId("decide on REST", "remember_tool", "s1");
  const b = pointId("decide on REST", "remember_tool", "s1");
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, b);
});

test("same text different source_kind yields different id", () => {
  const a = pointId("same", "blackhole_observation", "s1");
  const b = pointId("same", "blackhole_reflection", "s1");
  assert.notEqual(a, b);
});

test("contentHash is sha256 slice(0,32)", () => {
  assert.match(contentHash("anything"), /^[0-9a-f]{32}$/);
});
