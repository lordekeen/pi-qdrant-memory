import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { markCommandFormatNoticeShown, readState, statePath } from "../src/state.ts";

function tempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-qm-state-"));
}

/** Simulate a hand-edited state file (bypassing the writer). */
function writeStateRaw(dir: string, raw: string): void {
  const file = statePath(dir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, raw, "utf8");
}

test("statePath nests under the agent dir", () => {
  assert.equal(statePath("/tmp/agent"), "/tmp/agent/pi-qdrant-memory/state.json");
});

test("absent file reads as empty state", () => {
  const dir = tempAgentDir();
  try {
    assert.deepEqual(readState(dir), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("true flag reads back", () => {
  const dir = tempAgentDir();
  try {
    writeStateRaw(dir, JSON.stringify({ commandFormatNoticeShown: true }));
    assert.deepEqual(readState(dir), { commandFormatNoticeShown: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readState preserves unrelated top-level fields (#57)", () => {
  const dir = tempAgentDir();
  try {
    // Fields written by another version of the file must survive both the read
    // and a later write from this version — that is the whole point of the
    // index signature and of the merge-write below.
    writeStateRaw(dir, JSON.stringify({ commandFormatNoticeShown: true, futureFlag: "keep-me", nested: { a: 1 } }));
    assert.deepEqual(readState(dir), { commandFormatNoticeShown: true, futureFlag: "keep-me", nested: { a: 1 } });

    markCommandFormatNoticeShown(dir);
    const onDisk = JSON.parse(readFileSync(statePath(dir), "utf8")) as Record<string, unknown>;
    assert.equal(onDisk.futureFlag, "keep-me");
    assert.deepEqual(onDisk.nested, { a: 1 });
    assert.equal(onDisk.commandFormatNoticeShown, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mark merges into an existing file rather than replacing it (#57)", () => {
  const dir = tempAgentDir();
  try {
    writeStateRaw(dir, JSON.stringify({ somethingElse: 42 }));
    markCommandFormatNoticeShown(dir);
    assert.deepEqual(readState(dir), { somethingElse: 42, commandFormatNoticeShown: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("false flag reads as empty state", () => {
  const dir = tempAgentDir();
  try {
    writeStateRaw(dir, JSON.stringify({ commandFormatNoticeShown: false }));
    assert.deepEqual(readState(dir), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("non-boolean flag values read as empty state", () => {
  const dir = tempAgentDir();
  try {
    for (const v of [1, "true", null, []]) {
      writeStateRaw(dir, JSON.stringify({ commandFormatNoticeShown: v }));
      assert.deepEqual(readState(dir), {}, `value ${JSON.stringify(v)}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("corrupt JSON reads as empty state", () => {
  const dir = tempAgentDir();
  try {
    writeStateRaw(dir, "{not json");
    assert.deepEqual(readState(dir), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("non-object JSON reads as empty state", () => {
  const dir = tempAgentDir();
  try {
    for (const raw of ['"x"', "null", "[]"]) {
      writeStateRaw(dir, raw);
      assert.deepEqual(readState(dir), {}, `value ${raw}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mark then read round-trips, and the file exists", () => {
  const dir = tempAgentDir();
  try {
    markCommandFormatNoticeShown(dir);
    assert.ok(existsSync(statePath(dir)));
    assert.deepEqual(readState(dir), { commandFormatNoticeShown: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mark does not throw when the state directory cannot be created", () => {
  // Point agentDir at an existing *file*: mkdir of `<file>/pi-qdrant-memory`
  // must fail, and the failure must be swallowed.
  const dir = tempAgentDir();
  const blocked = join(dir, "not-a-dir");
  writeFileSync(blocked, "x", "utf8");
  try {
    assert.doesNotThrow(() => markCommandFormatNoticeShown(blocked));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("state file is created with mode 0600 on POSIX", (t) => {
  if (process.platform === "win32") t.skip("mode bits are not meaningful on win32");
  const dir = tempAgentDir();
  try {
    markCommandFormatNoticeShown(dir);
    assert.equal(statSync(statePath(dir)).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the writer is atomic: target holds the new content and no .tmp is left (#57)", () => {
  const dir = tempAgentDir();
  try {
    // Start from a file with an unrelated field so the write is a real update,
    // not a first creation.
    writeStateRaw(dir, JSON.stringify({ other: true }));
    const staleTmp = `${statePath(dir)}.tmp`;
    writeFileSync(staleTmp, "{ this stale temp file must not survive", "utf8");

    markCommandFormatNoticeShown(dir);

    // The rename replaced the target in one step: it parses, and the stale
    // temp is gone — a crash between write and rename is what temp-then-rename
    // exists to make harmless.
    const onDisk = JSON.parse(readFileSync(statePath(dir), "utf8")) as Record<string, unknown>;
    assert.deepEqual(onDisk, { other: true, commandFormatNoticeShown: true });
    assert.equal(existsSync(staleTmp), false, "a failed or completed write must never leave a .tmp behind");
    assert.deepEqual(
      readdirSync(dirname(statePath(dir))).filter((f) => f.endsWith(".tmp")),
      [],
      "no temp files remain in the state directory",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mark heals a corrupt file back to valid JSON on write", () => {
  const dir = tempAgentDir();
  try {
    writeStateRaw(dir, "{not json");
    markCommandFormatNoticeShown(dir);
    // The corrupt file had no recoverable fields, so the write is a fresh
    // object — and the reader is no longer stuck at "not shown" forever.
    assert.deepEqual(readState(dir), { commandFormatNoticeShown: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
