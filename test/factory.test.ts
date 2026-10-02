import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../src/index.ts";
import { outText } from "../src/out.ts";
import type { OutEntry } from "../src/out.ts";
import { statePath } from "../src/state.ts";

interface FakePiCommand {
  description?: string;
  handler: (args: string, ctx: unknown) => void | Promise<void>;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label?: string; description?: string }> | null;
}

/** Minimal fake of the real pi ExtensionAPI surface the factory adapts.
 *  `on` returns a REAL working unsubscribe, mirroring
 *  `dist/core/extensions/loader.js:213-227` — a fake that returned a no-op
 *  could not tell "the adapter forwards pi's unsubscribe" apart from "the
 *  adapter returns a no-op" (#55). */
function fakePi() {
  const tools: unknown[] = [];
  const commands = new Map<string, FakePiCommand>();
  const events: Array<{ event: string; handler: (p: unknown, ctx: unknown) => void | Promise<void> }> = [];
  const entryRenderers = new Map<string, unknown>();
  const messages: string[] = [];
  const pi = {
    registerTool(d: unknown) { tools.push(d); },
    registerCommand(name: string, opts: FakePiCommand) { commands.set(name, opts); },
    on(event: string, handler: (p: unknown, ctx: unknown) => void | Promise<void>) {
      events.push({ event, handler });
      // Real removal from the per-extension handler map, like the host.
      return () => {
        const i = events.findIndex((e) => e.handler === handler);
        if (i !== -1) events.splice(i, 1);
      };
    },
    appendEntry(_customType: string, data?: unknown) {
      const entry = data as OutEntry | undefined;
      messages.push(entry && typeof entry === "object" && typeof entry.kind === "string" ? outText(entry) : String(data ?? ""));
    },
    registerEntryRenderer(customType: string, renderer: unknown) { entryRenderers.set(customType, renderer); },
  };
  return { pi, tools, commands, events, entryRenderers, messages };
}

/** Dispatch every handler registered for an event, over a snapshot (as the
 *  host's runner does — `snapshotEventHandlers` copies the handler arrays). */
async function emit(events: Array<{ event: string; handler: (p: unknown, ctx: unknown) => void | Promise<void> }>, event: string, ctx: unknown = {}): Promise<void> {
  for (const { handler } of events.filter((e) => e.event === event).slice()) {
    await handler({ type: event }, ctx);
  }
}

test("factory registers tools, /qdrant commands, and lifecycle hooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-factory-"));
  mkdirSync(join(dir, "pi-qdrant-memory"), { recursive: true });
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const { pi, tools, commands, events, entryRenderers } = fakePi();
  try {
    await factory(pi);

    // Two tools under their canonical names.
    assert.equal(tools.length, 2);
    const toolNames = (tools as Array<{ name: string }>).map((t) => t.name).sort();
    assert.deepEqual(toolNames, ["memory_save", "memory_search"]);

    // Command output is an entry renderer + appendEntry channel (human-visible,
    // never in the LLM context).
    assert.ok(entryRenderers.has("qdrant-memory"), "expected an entry renderer for qdrant-memory");

    // ONE command with a subcommand key — pi splits the line on the first space,
    // so "/qdrant help" is this command with args "help". The hard cut is pinned
    // here: if an old alias ever creeps back, this assertion fails.
    const cmdNames = [...commands.keys()].sort();
    assert.deepEqual(cmdNames, ["qdrant"]);

    // Two-level completion arrives through the same registration.
    const qdrant = commands.get("qdrant")!;
    assert.deepEqual(qdrant.getArgumentCompletions?.("")?.map((c) => c.value), [
      "status", "settings", "remember", "search", "forget", "clear", "index", "help",
    ]);

    // No pi-blackhole config in the temp agent dir → mode2 → lifecycle hooks.
    const registered = events.map((e) => e.event);
    for (const ev of ["session_start", "session_before_compact", "session_compact"]) {
      assert.ok(registered.includes(ev), `expected ${ev} hook`);
    }
    // mode2 must not add the mode-1 shutdown ingest. Exactly one session_shutdown
    // remains: the factory's own teardown hook (#55), which is not mode-dependent.
    assert.equal(
      registered.filter((e) => e === "session_shutdown").length,
      1,
      "mode2 must register only the teardown hook, never the mode-1 ingest hook",
    );
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the adapter forwards pi's real unsubscribe, and cleanup runs on session_shutdown (#55)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-factory-"));
  mkdirSync(join(dir, "pi-qdrant-memory"), { recursive: true });
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const { pi, events } = fakePi();
  try {
    await factory(pi);
    // mode2 → session_start + session_before_compact + session_compact, plus
    // the teardown hook the factory registers.
    assert.ok(events.length >= 4, `expected the wired hooks, got ${events.length}`);
    const before = events.length;

    // The host drops a factory's return value (ExtensionFactory returns
    // void | Promise<void>; initializeExtension does `await factory(load.api)`
    // and binds nothing), so teardown hangs off session_shutdown — which pi
    // really does emit. Firing it must release EVERY handler the extension
    // registered. This only passes if the adapter returned pi's own unsubscribe
    // rather than a no-op: a no-op would leave all `before` handlers in place.
    await emit(events, "session_shutdown");
    assert.ok(before > 0, "the factory registered handlers to begin with");
    assert.equal(events.length, 0, "every handler the extension registered must be unsubscribed");
    assert.ok(events.length < before, "cleanup released something");

    // Idempotent: the teardown removed itself, and a repeated shutdown is a no-op.
    await emit(events, "session_shutdown");
    assert.equal(events.length, 0);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mode1 keeps the shutdown ingest alongside the teardown hook (#55)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-factory-"));
  // An operational pi-blackhole config makes detectBlackhole true → mode1.
  mkdirSync(join(dir, "pi-blackhole"), { recursive: true });
  writeFileSync(join(dir, "pi-blackhole", "pi-blackhole-config.json"), JSON.stringify({ compactionEngine: "blackhole" }), "utf8");
  mkdirSync(join(dir, "pi-qdrant-memory"), { recursive: true });
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const { pi, events } = fakePi();
  try {
    await factory(pi);
    // Two: the mode-1 ingestPending AND the teardown hook. The runner dispatches
    // from a snapshot, so the teardown running cannot skip the ingest that was
    // registered first.
    assert.equal(events.filter((e) => e.event === "session_shutdown").length, 2);
    await emit(events, "session_shutdown"); // ingest is a no-op with no pending artifacts
    assert.equal(events.length, 0, "shutdown releases both");
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the migration notice reaches the transcript and the flag is written by a command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-factory-"));
  mkdirSync(join(dir, "pi-qdrant-memory"), { recursive: true });
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const { pi, events, commands, messages } = fakePi();
  try {
    await factory(pi);
    await emit(events, "session_start", { mode: "tui", cwd: dir });
    assert.ok(
      messages.some((m) => m.includes("/qdrant-* is now /qdrant <key>")),
      "session_start must emit the migration notice",
    );
    assert.equal(existsSync(statePath(dir)), false, "session_start must not write the flag");

    // A successful dispatch writes it; the next session_start is then silent.
    await commands.get("qdrant")!.handler("help", {});
    assert.deepEqual(JSON.parse(readFileSync(statePath(dir), "utf8")), { commandFormatNoticeShown: true });

    messages.length = 0;
    await emit(events, "session_start", { mode: "tui", cwd: dir });
    assert.ok(
      !messages.some((m) => m.includes("/qdrant-* is now")),
      "the notice must not come back after a successful /qdrant dispatch",
    );
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("factory: qdrant help prints the command list; a bad settings key is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-factory-"));
  mkdirSync(join(dir, "pi-qdrant-memory"), { recursive: true });
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const { pi, commands, messages } = fakePi();
  try {
    await factory(pi);

    // "/qdrant help" → helpHandler output routed through appendEntry (no network).
    await commands.get("qdrant")!.handler("help", {});
    assert.ok(messages.join("\n").includes("/qdrant status"), "help output missing command list");

    // "/qdrant settings definitely-not-a-key 1" → unknown-key message, no crash.
    await commands.get("qdrant")!.handler("settings definitely-not-a-key 1", {});
    assert.ok(messages.join("\n").includes("unknown key"), "expected an unknown-key message");

    // An unknown subcommand answers with one error entry, and never throws.
    const before = messages.length;
    await commands.get("qdrant")!.handler("bogus thing", {});
    assert.equal(messages.length - before, 1);
    assert.match(messages.at(-1)!, /unknown key "bogus thing"/);
    assert.match(messages.at(-1)!, /usage: \/qdrant <key>/);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("factory: a settings write persists and triggers a runtime config reload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-factory-"));
  mkdirSync(join(dir, "pi-qdrant-memory"), { recursive: true });
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const { pi, commands, messages } = fakePi();
  try {
    await factory(pi);
    const qdrant = commands.get("qdrant")!;

    // Write a valid numeric setting — persists to the canonical file and reloads
    // the runtime (applyConfig) without any network I/O.
    await qdrant.handler("settings scoreThreshold 0.99", {});
    assert.ok(messages.join("\n").includes("scoreThreshold updated"));
    const { readFileSync } = await import("node:fs");
    const { configPath } = await import("../src/config.ts");
    const onDisk = JSON.parse(readFileSync(configPath(dir), "utf8")) as { scoreThreshold?: unknown };
    assert.equal(onDisk.scoreThreshold, 0.99);

    // Invalid write is rejected and leaves the file unchanged (no clobber).
    await qdrant.handler("settings maxResults not-a-number", {});
    const onDisk2 = JSON.parse(readFileSync(configPath(dir), "utf8")) as { scoreThreshold?: unknown; maxResults?: unknown };
    assert.equal(onDisk2.scoreThreshold, 0.99);
    assert.equal(onDisk2.maxResults, 10); // unchanged default
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("factory: /qdrant clear completes its modifiers and shows usage without one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-factory-"));
  mkdirSync(join(dir, "pi-qdrant-memory"), { recursive: true });
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const { pi, commands, messages } = fakePi();
  try {
    await factory(pi);
    const qdrant = commands.get("qdrant")!;
    assert.ok(qdrant, "qdrant should be registered");

    // Second-level argument completions, off the single command:
    assert.deepEqual(qdrant.getArgumentCompletions?.("clear "), [{ value: "all", label: "all" }, { value: "code", label: "code" }]);
    assert.deepEqual(qdrant.getArgumentCompletions?.("clear c"), [{ value: "code", label: "code" }]);
    assert.deepEqual(qdrant.getArgumentCompletions?.("clear xyz"), []); // no match suppresses the menu
    assert.equal(qdrant.getArgumentCompletions?.("search anything"), null); // free text: not ours

    // Bare invocation without a modifier shows usage:
    await qdrant.handler("clear", {});
    assert.match(messages.join("\n"), /clear: usage — \/qdrant clear all \| code/);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
