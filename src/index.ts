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
import type { HandlerIO, SettingsUI } from "./handlers.ts";
import { runSettingsForm } from "./handlers.ts";
import { errorEntry } from "./out.ts";
import { loadRendererModules, renderEntryComponent } from "./entry-render.ts";
import type { RendererOptions, RendererTheme } from "./entry-render.ts";
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
  setStatus(text: string): void;
  /** Interactive ctx.ui (select/input/confirm) when a command runs in the TUI. */
  requestUI?(): SettingsUI | undefined;
}

type ToolTextResult = { content: Array<{ type: "text"; text: string }>; details?: unknown };

const OK = (text: string): ToolTextResult => ({ content: [{ type: "text", text }], details: undefined });
const ERR = (text: string): ToolTextResult => ({ content: [{ type: "text", text }], details: undefined });

interface CommandDef {
  /** Single-token command name as typed after the slash, e.g. "qdrant-status". */
  name: string;
  description: string;
  /** Receives the raw argument string — everything after the command token. */
  execute: (args: string) => Promise<void>;
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
    // Structured entries through the appendEntry seam — visible in the TUI,
    // never in LLM context. No text prefix is added here (or anywhere).
    emit: (e) => api.appendEntry(CUSTOM_TYPE, e),
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
    name: "memory_save",
    label: "memory_save",
    description:
      "Persist a durable decision, constraint, or preference from the conversation so future sessions can recall it semantically.",
    promptSnippet: "memory_save(text, type?) — persist a durable decision/constraint/preference for future sessions.",
    promptGuidelines: [
      "When a design choice is finalized, a constraint is stated, or a user preference is made explicit, call memory_save to persist it.",
      "Keep the statement concise and self-contained so it reads correctly outside this conversation.",
      "Don't re-record what auto-capture already covers (session summaries, blackhole observations/reflections are ingested automatically) — use memory_save for decisions and rationale the auto-capture would lose.",
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
      "At the start of a session resuming prior project work, call memory_search for relevant prior decisions before assuming you have no context.",
      "memory_search covers conversation-only knowledge, not file content — for code structure or files use codegraph / read / grep instead.",
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
  // One pi command per unique single-token name: pi resolves "/qdrant-status" as
  // the command "qdrant-status" with everything after the first space as its raw
  // args. No subcommand parsing, and every command is individually discoverable
  // and autocompletable in the TUI.
  const commands: CommandDef[] = [
    { name: "qdrant-status", description: "Connection health, active mode, collection status", execute: async () => { await statusHandler(io); } },
    {
      name: "qdrant-settings",
      description: "Settings form, or persist a config field: /qdrant-settings <key> <value>",
      execute: async (args) => {
        const trimmed = args.trim();
        const field = trimmed.split(/\s+/)[0] ?? "";
        if (!field) {
          const ui = api.requestUI?.();
          if (ui) { await runSettingsForm(ui, io); return; }
          await settingsHandler(io); // no interactive UI (headless tests / rpc): print usage
          return;
        }
        const value = trimmed.slice(trimmed.indexOf(field) + field.length).trim();
        await settingsHandler(io, field, value === "" ? undefined : value);
      },
    },
    { name: "qdrant-remember", description: "Save durable knowledge now: /qdrant-remember <text>", execute: async (args) => { await rememberHandler(io, args.trim()); } },
    { name: "qdrant-search", description: "Semantic search: /qdrant-search <query>", execute: async (args) => { await searchHandler(io, args.trim()); } },
    { name: "qdrant-clear", description: "Reset the current project's collection", execute: async () => { await clearHandler(io); } },
    { name: "qdrant-help", description: "List /qdrant commands", execute: async () => { await helpHandler(io); } },
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
    // Footer statusline — icon-led label like ketch's "🌐 ketch: active", then
    // the mode + project collection as the state.
    api.setStatus(`🧠 Memory: ${mode} (${rt.projectId})`);
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
//   - appendEntry(customType, data) + registerEntryRenderer(customType, renderer)
//     — slash-command output goes here: custom entries are rendered in the TUI
//     transcript but DO NOT participate in LLM context (unlike sendMessage,
//     whose `display` flag only gates TUI rendering).
//   - ctx.ui.setStatus(key, text) / ctx.ui.notify(text, level) on the context
//
// Tool `parameters` are plain JSON Schema objects (structurally identical to what
// pi's TypeBox `Type.Object(...)` produces), so this file adds no runtime
// dependencies.

interface PiSurface {
  registerTool(def: unknown): void;
  registerCommand(name: string, options: { description?: string; handler(args: string, ctx: unknown): void | Promise<void> }): void;
  on(event: string, handler: (payload: unknown, ctx: unknown) => void | Promise<void>): void;
  appendEntry(customType: string, data?: unknown): void;
  registerEntryRenderer(customType: string, renderer: (entry: { customType?: string; data?: unknown }, options?: unknown, theme?: unknown) => unknown): void;
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

  let currentUi: {
    setStatus?: (key: string, text: string | undefined) => void;
    notify?: (text: string, level?: string) => void;
    select?: (title: string, options: string[]) => Promise<string | undefined>;
    input?: (title: string, placeholder?: string) => Promise<string | undefined>;
    confirm?: (title: string, message: string) => Promise<boolean>;
  } | undefined;

  // pi-tui components + keyHint, loaded lazily: pi's extension loader aliases
  // `@earendil-works/pi-tui` / `@earendil-works/pi-coding-agent` to its bundled
  // copies, but plain-node test runs never resolve them (they don't render
  // entries). Until they resolve, the renderer returns undefined and pi skips
  // the row — safe under every runtime.
  void loadRendererModules();

  pi.registerEntryRenderer(CUSTOM_TYPE, (entry, options, theme) =>
    renderEntryComponent(entry?.data, options as RendererOptions | undefined, theme as RendererTheme | undefined));

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
    // Text sink for non-wire paths (handlers emit structured entries via the
    // wireApi adapter's appendEntry; this is the plain fallback).
    print: (text) => pi.appendEntry(CUSTOM_TYPE, { kind: "message", text }),
  };

  rt = await makeRuntime(agentDir, process.cwd(), env, io);

  const adapter: WireApi = {
    registerTool: (def) => pi.registerTool(def),
    registerCommand: (def) => {
      // One real pi command per def. pi resolves "/qdrant-status" as the command
      // "qdrant-status" and passes everything after the first space as the raw
      // `args` string, so each def runs directly on its own argument text — no
      // family coalescing or subcommand dispatch in the adapter.
      const d = def as { name?: string; description?: string; execute?: (args: string) => Promise<void> };
      if (!d.name) return;
      pi.registerCommand(d.name, {
        description: d.description,
        handler: async (args: string, ctx: unknown) => {
          const ui = (ctx as { ui?: unknown } | undefined)?.ui as typeof currentUi;
          if (ui) currentUi = ui;
          try {
            await d.execute?.(args);
          } catch (err) {
            // Surface handler failures as an error entry instead of relying on
            // pi's (easily missed) extension-error channel.
            pi.appendEntry(CUSTOM_TYPE, errorEntry(`error: ${err instanceof Error ? err.message : String(err)}`));
          }
        },
      });
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
    appendEntry: (_type, data) => { pi.appendEntry(CUSTOM_TYPE, data); },
    setStatus: (text) => {
      try { currentUi?.setStatus?.(QDRANT_STATUS_KEY, text); } catch { /* status is best-effort */ }
    },
    requestUI: () => {
      // Only expose the interactive dialogs when the current ui context really
      // has them (interactive TUI does; rpc/print contexts may not).
      const u = currentUi;
      if (!u || typeof u.select !== "function" || typeof u.input !== "function" || typeof u.confirm !== "function") {
        return undefined;
      }
      return { select: u.select, input: u.input, confirm: u.confirm } satisfies SettingsUI;
    },
  };

  const cleanup = wireApi(adapter, rt);

  // pi tracks and releases event-bus subscriptions on runtime teardown and the
  // adapter's `on` intentionally returns a no-op, so the structural `cleanup`
  // returned by wireApi is a no-op here — it only matters for unit tests with the
  // fake WireApi. Keep a reference so future wiring can flush in-flight work.
  void cleanup;
}
