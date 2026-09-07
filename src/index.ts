import { makeRuntime, applyConfig } from "./deps.ts";
import type { MakeRuntimeIO } from "./deps.ts";
import { loadConfig, writeConfigFile } from "./config.ts";
import { agentDirFromEnv, detectBlackhole } from "./mode.ts";
import { resolveMode } from "./mode.ts";
import { rememberLogic, memorySearchLogic } from "./tools-core.ts";
import { renderHits } from "./render.ts";
import { readPendingArtifacts } from "./blackhole.ts";
import { artifactToIngestItem, ingestItems } from "./ingest.ts";
import { captureAtCompaction } from "./capture.ts";
import { projectIdFrom } from "./project.ts";
import { statusHandler, settingsHandler, rememberHandler, searchHandler, clearHandler, helpHandler, depsToIO } from "./handlers.ts";
import type { HandlerIO } from "./handlers.ts";
import type { MemoryType, RuntimeDeps } from "./types.ts";

/**
 * Narrow structural surface the wiring logic depends on. Isolating pi's real
 * `ExtensionAPI` behind this keeps `wireApi` unit-testable with a fake and means
 * only the `factory` adapter at the bottom of this file touches pi specifics.
 * `on()` returns an unsubscribe so `wireApi`'s cleanup actually removes handlers.
 */
export interface WireApi {
  registerTool(def: unknown): void;
  registerCommand(def: unknown): void;
  on(event: string, handler: (payload: unknown, ctx?: unknown) => void | Promise<void>): () => void;
  appendEntry(type: string, data: unknown): void;
  sendMessage(text: string): void;
  setStatus(text: string): void;
}

type ToolTextResult = { content: Array<{ type: "text"; text: string }>; details?: unknown };

const OK = (text: string): ToolTextResult => ({ content: [{ type: "text", text }], details: undefined });
const ERR = (text: string): ToolTextResult => ({ content: [{ type: "text", text }], details: undefined });

interface CommandDef {
  name: string; // "<family> <sub>", e.g. "qdrant status"
  description: string;
  execute: (args: string[]) => Promise<void>;
}

/** Extract a durable summary text from an event payload when one is present. */
function payloadSummaryText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const o = payload as Record<string, unknown>;
  const entry = o.compactionEntry as Record<string, unknown> | undefined;
  if (entry && typeof entry.summary === "string") return entry.summary;
  if (typeof o.summary === "string") return o.summary;
  return undefined;
}

/** Best-effort session id from the event context (`ctx.sessionManager.getSessionId()`). */
function ctxSessionId(ctx: unknown): string | undefined {
  try {
    const sm = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)?.sessionManager;
    const id = sm?.getSessionId?.();
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

function buildIO(api: WireApi, rt: RuntimeDeps): HandlerIO {
  // Live view over `rt`: handlers read cfg/projectId/embed/qdrant through getters,
  // so a session_start project-id refresh or a runtime config reload (applyConfig)
  // is immediately visible to slash-command handlers — never a stale copy.
  return depsToIO(rt, {
    print: (t) => api.sendMessage(`/qdrant: ${t}`),
  });
}

/** Testable wiring: registers the two tools, the /qdrant command family, and the
 * lifecycle handlers for the resolved mode. Returns a cleanup that unsubscribes
 * every registered handler. */
export function wireApi(api: WireApi, rt: RuntimeDeps): () => void {
  const mode = resolveMode(rt.cfg, detectBlackhole(rt.agentDir));
  const io = buildIO(api, rt);

  // ── Agent tools ────────────────────────────────────────────────────────────
  api.registerTool({
    name: "remember",
    label: "remember",
    description:
      "Persist a durable decision, constraint, or preference from the conversation so future sessions can recall it semantically.",
    promptSnippet: "remember(text, type?) — persist a durable decision/constraint/preference.",
    promptGuidelines: [
      "When a design choice is finalized, a constraint is stated, or a user preference is made explicit, call remember to persist it across sessions.",
    ],
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Self-contained durable statement to remember." },
        type: { type: "string", enum: ["decision", "fact", "constraint", "preference"] },
      },
      required: ["text"],
    },
    execute: async (_toolCallId: string, params: { text: string; type?: "decision" | "fact" | "constraint" | "preference" }) => {
      const res = await rememberLogic(rt, params.text, params.type);
      return res.ok ? OK(`remembered (${res.value.source_kind}): ${res.value.text}`) : ERR(`remember failed: ${res.error}`);
    },
  });

  api.registerTool({
    name: "memory_search",
    label: "memory_search",
    description:
      "Search prior durable project knowledge (decisions, facts, constraints, preferences, session summaries) semantically across sessions.",
    promptSnippet: "memory_search(query, type?, limit?) — semantic search of prior durable knowledge.",
    promptGuidelines: [
      "When reasoning about something the project may have decided before, call memory_search to recall prior durable knowledge before re-deciding.",
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language description of what prior knowledge is needed." },
        type: { type: "string", enum: ["decision", "fact", "constraint", "preference", "session_summary"] },
        limit: { type: "number", description: "Override result count (capped by config maxResults)." },
      },
      required: ["query"],
    },
    execute: async (_toolCallId: string, params: { query: string; type?: MemoryType; limit?: number }) => {
      const res = await memorySearchLogic(rt, params.query, params.type, params.limit);
      return res.ok ? OK(renderHits(res.value)) : ERR(`memory_search failed: ${res.error}`);
    },
  });

  // ── /qdrant command family ─────────────────────────────────────────────────
  // Each entry is "<family> <sub>" so a single /qdrant dispatcher (see the real
  // factory adapter) can route subcommands — pi resolves "/qdrant status" as the
  // "qdrant" command with args "status ...".
  const commands: CommandDef[] = [
    { name: "qdrant status", description: "Connection health, active mode, collection status", execute: async () => { await statusHandler(io); } },
    { name: "qdrant settings", description: "Edit settings: /qdrant settings <key> <value>", execute: async (a) => { await settingsHandler(io, a[0], a[1]); } },
    { name: "qdrant remember", description: "Save durable knowledge now: /qdrant remember <text>", execute: async (a) => { await rememberHandler(io, a.join(" ")); } },
    { name: "qdrant search", description: "Semantic search: /qdrant search <query>", execute: async (a) => { await searchHandler(io, a.join(" ")); } },
    { name: "qdrant clear", description: "Reset the current project's collection", execute: async () => { await clearHandler(io); } },
    { name: "qdrant help", description: "List /qdrant commands", execute: async () => { await helpHandler(io); } },
  ];
  for (const c of commands) api.registerCommand({ name: c.name, description: c.description, execute: c.execute });

  // ── Lifecycle handlers ─────────────────────────────────────────────────────
  const ingestPending = async (): Promise<void> => {
    // Mode 1: ingest pi-blackhole's pending durable artifacts (catch-up). Never
    // claims the compaction hook. Idempotent via deterministic point ids.
    try {
      const arts = readPendingArtifacts(rt.agentDir);
      const items = arts.map((a) => artifactToIngestItem(a, rt.projectId, Date.now()));
      if (items.length) {
        await ingestItems({ embed: rt.embed, qdrant: rt.qdrant, projectId: rt.projectId }, rt.cfg.expectedDimension, items);
      }
    } catch (err) {
      console.error(`pi-qdrant-memory: Mode-1 pending ingest error (non-fatal): ${String(err)}`);
    }
  };

  const sessionStart = async (_payload: unknown, ctx?: unknown): Promise<void> => {
    // Anchor the project id to the session's real cwd: a session can be resumed
    // from a different directory than the one the factory ran in.
    const cwd = ctx && typeof ctx === "object" ? (ctx as { cwd?: unknown }).cwd : undefined;
    if (typeof cwd === "string" && cwd !== rt.cwd) {
      try {
        rt.cwd = cwd;
        rt.projectId = await projectIdFrom(cwd);
      } catch { /* keep the factory-time anchor */ }
    }
    api.setStatus(`qdrant-memory: ${mode} (${rt.projectId})`);
    if (mode === "mode1") await ingestPending();
    // Mode 2 safety-net auto snapshot (spec §3.3) is intentionally NOT wired here:
    // an early-session snapshot needs mid-session content distillation access that
    // this extension does not yet have. Mode 2 relies on the session_compact
    // capture of pi's own compaction summary plus the manual `/qdrant remember`
    // command as its safety nets (see sessionCompact handler below).
  };

  const sessionCompact = async (payload: unknown, ctx?: unknown): Promise<void> => {
    // Mode 2: embed pi's own compaction summary produced at the compaction
    // boundary (spec §3.3). Fire-and-forget — compaction has already succeeded and
    // the embed must never stall the session. Capture never throws.
    const summary = payloadSummaryText(payload);
    if (!summary || !summary.trim()) return;
    const sessionId = ctxSessionId(ctx);
    const promise = captureAtCompaction(
      { embed: rt.embed, qdrant: rt.qdrant, projectId: rt.projectId },
      rt.cfg.expectedDimension, summary, sessionId ?? "unknown-session", Date.now(),
    ).catch((err) => console.error(`pi-qdrant-memory: compaction capture error (non-fatal): ${String(err)}`));
    void promise;
  };

  const sessionBeforeCompact = async (): Promise<void> => {
    // Mode 2: the spec §3.3 hook is claimed (free only while blackhole is absent).
    // pi has not produced its summary at this point, so no blocking work happens
    // here — the durable capture runs on session_compact with the real summary.
    // This handler must never stall compaction.
  };

  const handlers = new Map<string, (payload: unknown, ctx?: unknown) => void | Promise<void>>();
  handlers.set("session_start", sessionStart);
  if (mode === "mode1") {
    handlers.set("session_shutdown", ingestPending); // capture the current session's drops as it closes
  } else {
    handlers.set("session_before_compact", sessionBeforeCompact);
    handlers.set("session_compact", sessionCompact);
  }

  const unsubs: Array<() => void> = [];
  for (const [event, handler] of handlers) {
    const off = api.on(event, handler);
    if (typeof off === "function") unsubs.push(off);
  }

  return () => {
    for (const off of unsubs) {
      try { off(); } catch { /* unsubscribe must never throw during cleanup */ }
    }
    unsubs.length = 0;
  };
}

// ── Real pi adapter ──────────────────────────────────────────────────────────
//
// The subset of the real pi ExtensionAPI this extension uses, verified against
// the installed @earendil-works/pi-coding-agent package types:
//   - registerTool(toolDefinition)
//   - registerCommand(name, { description, handler(args: string, ctx) })
//   - on(event, handler) — handler receives (event, ctx); subscriptions are
//     tracked by the extension runtime and released on teardown (pi has no
//     unsubscribe return value)
//   - sendMessage({ customType, content, display, details }, { triggerTurn })
//   - ctx.ui.setStatus(key, text) / ctx.ui.notify(text, level) on the context
//
// Tool `parameters` are plain JSON Schema objects (structurally identical to what
// pi's TypeBox `Type.Object(...)` produces), so this file adds no runtime
// dependencies.

interface PiSurface {
  registerTool(def: unknown): void;
  registerCommand(name: string, options: { description?: string; handler(args: string, ctx: unknown): void | Promise<void> }): void;
  on(event: string, handler: (payload: unknown, ctx: unknown) => void | Promise<void>): void;
  sendMessage(message: unknown): void;
}

const QDRANT_STATUS_KEY = "qdrant-memory";
const CUSTOM_TYPE = "qdrant-memory";

/**
 * Default pi extension factory. Thin adapter: assembles the runtime from the
 * canonical config/env, wraps the real `ExtensionAPI` in the structural `WireApi`,
 * then delegates all wiring to `wireApi`.
 */
export default async function factory(api: unknown): Promise<void> {
  const pi = api as PiSurface;
  const env = process.env;
  const agentDir = agentDirFromEnv(env);

  let currentUi: { setStatus?: (key: string, text: string | undefined) => void; notify?: (text: string, level?: string) => void } | undefined;

  const sendText = (text: string): void => {
    pi.sendMessage({
      customType: CUSTOM_TYPE,
      content: text,
      display: false, // render for the human without polluting the model's context
      details: undefined,
    });
  };

  // Assigned by makeRuntime below; writeConfig may run later (after a settings
  // write) and needs to reload the assembled runtime onto the new config.
  let rt: RuntimeDeps | undefined;

  const io: MakeRuntimeIO = {
    readConfig: () => loadConfig(agentDir, env),
    writeConfig: (c) => {
      writeConfigFile(agentDir, c);
      // Reload-on-save (design D13): reflect the new settings immediately by
      // re-reading the canonical file and swapping cfg + embed/qdrant clients.
      if (rt) applyConfig(rt, loadConfig(agentDir, env));
    },
    print: sendText,
  };

  rt = await makeRuntime(agentDir, process.cwd(), env, io);

  const family = new Map<string, { description: string; members: Array<{ sub: string; execute: (args: string[]) => Promise<void> }> }>();

  const adapter: WireApi = {
    registerTool: (def) => pi.registerTool(def),
    registerCommand: (def) => {
      // Coalesce "<family> <sub>" defs into per-family member lists; the real pi
      // dispatcher resolves "/qdrant <sub>" as command "qdrant" (first token).
      const d = def as { name?: string; description?: string; execute?: (args: string[]) => Promise<void> };
      const [fam, sub] = (d.name ?? "").split(" ");
      if (!fam) return;
      let f = family.get(fam);
      if (!f) { f = { description: `${fam} command family`, members: [] }; family.set(fam, f); }
      f.members.push({ sub: sub ?? "help", execute: d.execute ?? (async () => {}) });
    },
    on: (event, handler) => {
      pi.on(event, (payload, ctx) => {
        // Remember the ui context so setStatus()/future notify() calls can route.
        const ui = (ctx as { ui?: unknown } | undefined)?.ui as typeof currentUi;
        if (ui) currentUi = ui;
        return handler(payload, ctx);
      });
      return () => {}; // pi tracks and releases event-bus subscriptions on teardown
    },
    appendEntry: (type, data) => { /* appendEntry is not needed by the current wiring */ void type; void data; },
    sendMessage: sendText,
    setStatus: (text) => {
      try { currentUi?.setStatus?.(QDRANT_STATUS_KEY, text); } catch { /* status is best-effort */ }
    },
  };

  const cleanup = wireApi(adapter, rt);

  // Register each command family as a single real pi command that dispatches on
  // its first argument (e.g. "/qdrant status", "/qdrant remember <text>").
  for (const [fam, f] of family) {
    pi.registerCommand(fam, {
      description: `${f.description}: ${f.members.map((m) => m.sub).join(", ")}`,
      handler: async (args: string, ctx: unknown) => {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const sub = tokens[0] ?? "help";
        const rest = tokens.slice(1);
        const ui = (ctx as { ui?: unknown } | undefined)?.ui as typeof currentUi;
        if (ui) currentUi = ui;
        const member = f.members.find((m) => m.sub === sub) ?? f.members.find((m) => m.sub === "help");
        await member?.execute(rest);
      },
    });
  }

  // pi tracks and releases event-bus subscriptions on runtime teardown and the
  // adapter's `on` intentionally returns a no-op, so the structural `cleanup`
  // returned by wireApi is a no-op here — it only matters for unit tests with the
  // fake WireApi. Keep a reference so future wiring can flush in-flight work.
  void cleanup;
}
