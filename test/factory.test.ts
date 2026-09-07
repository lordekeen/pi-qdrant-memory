import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../src/index.ts";

interface FakePiCommand {
  description?: string;
  handler: (args: string, ctx: unknown) => void | Promise<void>;
}

/** Minimal fake of the real pi ExtensionAPI surface the factory adapts. */
function fakePi() {
  const tools: unknown[] = [];
  const commands = new Map<string, FakePiCommand>();
  const events: Array<{ event: string; handler: (p: unknown, ctx: unknown) => void | Promise<void> }> = [];
  const messages: string[] = [];
  const pi = {
    registerTool(d: unknown) { tools.push(d); },
    registerCommand(name: string, opts: FakePiCommand) { commands.set(name, opts); },
    on(event: string, handler: (p: unknown, ctx: unknown) => void | Promise<void>) { events.push({ event, handler }); },
    sendMessage(m: unknown) { messages.push(String((m as { content?: unknown }).content ?? m)); },
  };
  return { pi, tools, commands, events, messages };
}

test("factory registers tools, one /qdrant family command, and lifecycle hooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-factory-"));
  mkdirSync(join(dir, "pi-qdrant-memory"), { recursive: true });
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const { pi, tools, commands, events } = fakePi();
  try {
    await factory(pi);

    // Two tools under their canonical names.
    assert.equal(tools.length, 2);
    const toolNames = (tools as Array<{ name: string }>).map((t) => t.name).sort();
    assert.deepEqual(toolNames, ["memory_search", "remember"]);

    // The /qdrant family coalesces into one real command (pi dispatches on the
    // first token of "/qdrant <sub>").
    assert.ok(commands.has("qdrant"), "expected a single 'qdrant' command");
    assert.match(commands.get("qdrant")!.description ?? "", /status.*remember.*search/);

    // No pi-blackhole config in the temp agent dir → mode2 → lifecycle hooks.
    const registered = events.map((e) => e.event);
    for (const ev of ["session_start", "session_before_compact", "session_compact"]) {
      assert.ok(registered.includes(ev), `expected ${ev} hook`);
    }
    assert.ok(!registered.includes("session_shutdown"), "mode2 must not register session_shutdown");
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("factory: /qdrant command dispatches subcommands and defaults to help", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-factory-"));
  mkdirSync(join(dir, "pi-qdrant-memory"), { recursive: true });
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const { pi, commands, messages } = fakePi();
  try {
    await factory(pi);
    const qdrant = commands.get("qdrant")!;
    assert.ok(qdrant, "expected the qdrant command");

    // "/qdrant help" → helpHandler output routed through sendMessage (no network).
    await qdrant.handler("help", {});
    assert.ok(messages.join("\n").includes("/qdrant status"), "help output missing command list");

    // "/qdrant" with no args → defaults to help.
    const before = messages.length;
    await qdrant.handler("", {});
    assert.ok(messages.length > before, "bare /qdrant should print the help list");

    // "/qdrant settings badkey 1" → unknown-key message, no crash.
    await qdrant.handler("settings definitely-not-a-key 1", {});
    assert.ok(messages.join("\n").includes("unknown key"), "expected an unknown-key message");
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
