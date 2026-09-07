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
  const entryRenderers = new Map<string, unknown>();
  const messages: string[] = [];
  const pi = {
    registerTool(d: unknown) { tools.push(d); },
    registerCommand(name: string, opts: FakePiCommand) { commands.set(name, opts); },
    on(event: string, handler: (p: unknown, ctx: unknown) => void | Promise<void>) { events.push({ event, handler }); },
    appendEntry(_customType: string, data?: unknown) { messages.push(String(data ?? "")); },
    registerEntryRenderer(customType: string, renderer: unknown) { entryRenderers.set(customType, renderer); },
  };
  return { pi, tools, commands, events, entryRenderers, messages };
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

    // One real pi command per unique single-token name (pi resolves
    // "/qdrant-status" as the command "qdrant-status" — no subcommand parsing).
    const cmdNames = [...commands.keys()].sort();
    assert.deepEqual(cmdNames, ["qdrant-clear", "qdrant-help", "qdrant-remember", "qdrant-search", "qdrant-settings", "qdrant-status"]);

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

test("factory: qdrant-help prints the command list; bad settings key is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-factory-"));
  mkdirSync(join(dir, "pi-qdrant-memory"), { recursive: true });
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const { pi, commands, messages } = fakePi();
  try {
    await factory(pi);

    // "/qdrant-help" → helpHandler output routed through sendMessage (no network).
    await commands.get("qdrant-help")!.handler("", {});
    assert.ok(messages.join("\n").includes("/qdrant-status"), "help output missing command list");

    // "/qdrant-settings badkey 1" → unknown-key message, no crash.
    await commands.get("qdrant-settings")!.handler("definitely-not-a-key 1", {});
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
    const settings = commands.get("qdrant-settings")!;

    // Write a valid numeric setting — persists to the canonical file and reloads
    // the runtime (applyConfig) without any network I/O.
    await settings.handler("scoreThreshold 0.99", {});
    assert.ok(messages.join("\n").includes("scoreThreshold updated"));
    const { readFileSync } = await import("node:fs");
    const { configPath } = await import("../src/config.ts");
    const onDisk = JSON.parse(readFileSync(configPath(dir), "utf8")) as { scoreThreshold?: unknown };
    assert.equal(onDisk.scoreThreshold, 0.99);

    // Invalid write is rejected and leaves the file unchanged (no clobber).
    await settings.handler("maxResults not-a-number", {});
    const onDisk2 = JSON.parse(readFileSync(configPath(dir), "utf8")) as { scoreThreshold?: unknown; maxResults?: unknown };
    assert.equal(onDisk2.scoreThreshold, 0.99);
    assert.equal(onDisk2.maxResults, 10); // unchanged default
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
