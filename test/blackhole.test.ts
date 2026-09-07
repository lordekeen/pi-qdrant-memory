import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOmEntry, artifactToPayload, listPendingFiles, readPendingArtifacts } from "../src/blackhole.ts";
import type { BlackholeArtifact } from "../src/blackhole.ts";

test("parseOmEntry maps observations.recorded", () => {
  const arts = parseOmEntry("om.observations.recorded", {
    observations: [{ id: "abc123def456", content: "user prefers X", timestamp: "2026-09-07", relevance: 0.8 }],
  });
  assert.ok(arts);
  assert.equal(arts!.length, 1);
  assert.equal(arts![0].kind, "observation");
  assert.equal(arts![0].data.id, "abc123def456");
});

test("parseOmEntry maps reflections.recorded", () => {
  const arts = parseOmEntry("om.reflections.recorded", {
    reflections: [{ id: "1234567890ab", content: "decision: use REST" }],
  });
  assert.ok(arts);
  assert.equal(arts![0].kind, "reflection");
});

test("parseOmEntry returns null for unknown or malformed", () => {
  assert.equal(parseOmEntry("om.observations.dropped", {}), null);
  assert.equal(parseOmEntry("om.observations.recorded", {}), null);
});

test("artifactToPayload maps observation to fact with blackhole_observation source", () => {
  const art: BlackholeArtifact = { kind: "observation", sessionId: "sess", data: { id: "abc123def456", content: "pref X" } };
  const p = artifactToPayload(art, "pi-mem-abc", 42);
  assert.equal(p.type, "fact");
  assert.equal(p.source_kind, "blackhole_observation");
  assert.equal(p.source_entry_id, "abc123def456");
  assert.equal(p.session_id, "sess");
  assert.equal(p.ts, 42);
  assert.equal(p.project_id, "pi-mem-abc");
});

test("listPendingFiles lists every -pending.json; readPendingArtifacts tolerates corrupt files", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-bh-"));
  try {
    const bh = join(dir, "pi-blackhole");
    mkdirSync(bh, { recursive: true });
    writeFileSync(join(bh, "sess1-pending.json"), JSON.stringify({
      observations: [{ id: "aaaaaaaaaaaa", content: "obs A" }],
    }), "utf8");
    writeFileSync(join(bh, "sess2-pending.json"), "not json", "utf8"); // corrupt tolerated by the reader
    // listPendingFiles is a pure suffix listing — both files match.
    const files = listPendingFiles(dir);
    assert.equal(files.length, 2);
    // Corruption tolerance lives in the reader: the corrupt file is skipped.
    const arts = readPendingArtifacts(dir);
    assert.equal(arts.length, 1);
    assert.equal(arts[0].data.id, "aaaaaaaaaaaa");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
