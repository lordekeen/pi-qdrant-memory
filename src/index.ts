import { makeRuntime, writeGlobalConfigAndReload } from "./deps.ts";
import type { MakeRuntimeIO } from "./deps.ts";
import { readGlobalConfig, takeLoadWarnings, writeConfigFile } from "./config.ts";
import { agentDirFromEnv, detectBlackhole, loadHostAgentDir } from "./mode.ts";
import { resolveMode } from "./mode.ts";
import { markCommandFormatNoticeShown, readState } from "./state.ts";
import { rememberLogic, memorySearchLogic, forgetLogic } from "./tools-core.ts";
import { renderHits } from "./render.ts";
import { readPendingArtifacts } from "./blackhole.ts";
import { artifactToIngestItem, ingestItems } from "./ingest.ts";
import { captureAtCompaction } from "./capture.ts";
import { projectIdFrom, findGitRoot } from "./project.ts";
import { syncCodeKnowledge } from "./code-sync.ts";
import type { SyncResult } from "./code-sync.ts";
import { statusHandler, settingsHandler, rememberHandler, searchHandler, forgetHandler, clearHandler, helpHandler, depsToIO } from "./handlers.ts";
import type { HandlerIO, SettingsUI } from "./handlers.ts";
import { runSettingsForm } from "./handlers.ts";
import {
  INDEX_KINDS,
  USAGE_KEYS,
  canonicalEnumArg,
  canonicalIndexKind,
  checkArgShape,
  getQdrantCompletions,
  isEnumKey,
  parseQdrantArgs,
  splitKeyedArg,
} from "./commands.ts";
import type { EnumKey, IndexKind, QdrantKey } from "./commands.ts";
import {
  clearUsageText,
  commandFormatNoticeEntry,
  commandUsageText,
  errorEntry,
  indexUsageText,
  loadWarningText,
  memoryHeaderText,
  message,
  noArgumentText,
  unexpectedArgumentText,
  unknownKeyText,
  unknownValueText,
  codeMemorySyncMessage,
} from "./out.ts";
import type { CodeMemoryHealth } from "./out.ts";
import { QdrantError } from "./qdrant.ts";
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
  /** pi command name as typed after the slash, e.g. "qdrant". */
  name: string;
  description: string;
  /** Receives the raw argument string — everything after the command token. */
  execute: (args: string) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label?: string; description?: string }> | null;
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

/** `ctx.mode` is `json` or `print` in a headless session — there is no
 *  transcript to show a prose notice in, so both the migration notice and the
 *  corrupt-config warning stay silent there (`rpc` renders a transcript and is
 *  NOT gated). Part D.2. */
function isHeadlessMode(ctx: unknown): boolean {
  const mode = (ctx as { mode?: unknown } | undefined)?.mode;
  return mode === "json" || mode === "print";
}

function buildIO(api: WireApi, rt: RuntimeDeps, codeMemory?: CodeMemoryHealth): HandlerIO {
  // Live view over `rt`: handlers read cfg/projectId/embed/qdrant through getters,
  // so a session_start project-id refresh or a runtime config reload (applyConfig)
  // is immediately visible to slash-command handlers — never a stale copy.
  return depsToIO(rt, {
    // Structured entries through the appendEntry seam — visible in the TUI,
    // never in LLM context. No text prefix is added here (or anywhere).
    emit: (e) => api.appendEntry(CUSTOM_TYPE, e),
    codeMemory,
  });
}

/** Testable wiring: registers the two tools, the single /qdrant command, and the
 * lifecycle handlers for the resolved mode. Returns a cleanup that unsubscribes
 * every registered handler. */
export function wireApi(api: WireApi, rt: RuntimeDeps): () => void {
  // Registration-time mode: decides which lifecycle hooks are wired (mode1 →
  // session_shutdown ingest; mode2 → compaction capture). A mode change via
  // /qdrant settings applies to the hooks at the next session; the footer and
  // every command re-resolve the mode live (see currentMode).
  const registrationMode = resolveMode(rt.cfg, detectBlackhole(rt.agentDir));
  // Same session-fixation rule for code memory: the code_memory tool is
  // registered here iff enabled; a mid-session flip is covered by the settings
  // reload notice (spec §12). The single /qdrant command is registered
  // unconditionally and its `index` key carries a live-config guard — that is
  // what makes §12's "index right away" promise keepable right after an off→on
  // flip (the TOOL still waits for the reload, satisfying G5).
  const codeMemoryOn = rt.cfg.codeKnowledge === "on";
  const codeMemoryState: { state: "off" | "syncing" | "synced" | "error"; files?: number; symbols?: number } = {
    state: codeMemoryOn ? "syncing" : "off",
  };
  const io = buildIO(api, rt, codeMemoryOn ? codeMemoryState : undefined);

  /** Repo root for the code sync, re-resolved per call — the session cwd
   * anchor can change at session_start (see there). */
  const codeRepoRoot = async (): Promise<string> => (await findGitRoot(rt.cwd)) ?? rt.cwd;

  let activeCodeSync: Promise<SyncResult> | undefined;

  const runCodeSync = async (): Promise<SyncResult> => {
    if (activeCodeSync) return activeCodeSync;
    codeMemoryState.state = "syncing";
    activeCodeSync = (async () => {
      try {
        const r = await syncCodeKnowledge({
          embedBatch: rt.embedBatch ?? (async (texts) => Promise.all(texts.map((t) => rt.embed(t)))),
          qdrant: rt.qdrant,
          projectId: rt.projectId,
          expectedDimension: rt.cfg.expectedDimension,
          repoRoot: await codeRepoRoot(),
        });
        codeMemoryState.state = r.ok ? "synced" : "error";
        codeMemoryState.files = r.totalFiles;
        codeMemoryState.symbols = r.totalSymbols;
        void refreshStatus(); // footer count now includes code points
        return r;
      } finally {
        activeCodeSync = undefined;
      }
    })();
    return activeCodeSync;
  };

  // Footer statusline state: total points stored in the project collection.
  // 0 when the collection does not exist yet; undefined (header without the
  // count) when Qdrant is unreachable — the statusline is best-effort and
  // must never throw.
  const collectionPoints = async (): Promise<number | undefined> => {
    try {
      return await rt.qdrant.count(rt.projectId);
    } catch (err) {
      return err instanceof QdrantError && err.status === 404 ? 0 : undefined;
    }
  };

  /** Re-resolve mode + project collection live and repaint the footer
   * statusline with the stored-memory count. Fire-and-forget at every call
   * site: a slow or down Qdrant must never block a tool result, a command, or
   * a lifecycle handler. */
  const refreshStatus = async (): Promise<void> => {
    const points = await collectionPoints();
    const mode = resolveMode(rt.cfg, detectBlackhole(rt.agentDir));
    api.setStatus(memoryHeaderText(points === undefined
      ? { mode, collection: rt.projectId }
      : { mode, collection: rt.projectId, points }));
  };

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
      if (res.ok) {
        void refreshStatus(); // footer count, best-effort
        if (res.value.skipped) return OK(`already saved: ${res.value.text}`);
        return OK(`remembered (${res.value.source_kind}): ${res.value.text}`);
      }
      return ERR(`remember failed: ${res.error}`);
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

  // Opt-in structural code search (spec §11): present only when enabled at
  // registration time — the agent discovers the feature by the tool existing
  // at all. No tool description mentions codegraph (spec D3).
  if (codeMemoryOn) {
    api.registerTool({
      name: "code_memory",
      label: "code_memory",
      description:
        "Search indexed code structure summaries (exported functions, classes, types, modules) " +
        "for this project semantically. Use for 'how/where does X work' questions before " +
        "falling back to grep or file reads; open the returned file:line pointers for full context.",
      promptSnippet: "code_memory(query, limit?) — semantic search of indexed code structure summaries.",
      promptGuidelines: [
        "For 'how/where does X work' questions, query code_memory first; it retrieves indexed summaries of this project's top-level symbols and modules.",
        "Results carry file:line pointers — open the file for full context when a summary is promising.",
        "code_memory covers structure, not rationale — pair it with memory_search for design decisions.",
      ],
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language description of the code knowledge needed." },
          limit: { type: "number", description: "Override result count (capped by config maxResults)." },
        },
        required: ["query"],
      },
      execute: async (_toolCallId: string, params: { query: string; limit?: number }) => {
        const res = await memorySearchLogic(rt, params.query, "code", params.limit);
        return res.ok ? OK(renderHits(res.value)) : ERR(`code_memory failed: ${res.error}`);
      },
    });
  }

  // Opt-in model exact-match retraction (spec Layer 4): gated on memoryForget: on.
  if (rt.cfg.memoryForget === "on") {
    api.registerTool({
      name: "memory_forget",
      label: "memory_forget",
      description:
        "Retract a previously saved memory that is now obsolete or contradicted by the user. Requires the exact verbatim text as returned by memory_search.",
      promptSnippet: "memory_forget(text) — retract an obsolete memory previously saved with memory_save.",
      promptGuidelines: [
        "When the user explicitly contradicts or deprecates a previous decision or fact, query memory_search first to get the exact saved text, then call memory_forget with that verbatim text.",
        "memory_forget operates only on exact text matches saved by memory_save; it will not delete auto-captured summaries or partial matches.",
      ],
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The exact verbatim text of the memory to retract, as returned by memory_search.",
          },
        },
        required: ["text"],
      },
      execute: async (_toolCallId: string, params: { text: string }) => {
        const res = await forgetLogic(rt, params.text);
        if (res.ok) {
          void refreshStatus();
          return OK(`forgotten: ${res.value.text}`);
        }
        return ERR(`memory_forget failed: ${res.error}`);
      },
    });
  }

  // ── /qdrant command ────────────────────────────────────────────────────────
  // ONE pi command with a subcommand key: the host splits the line on the first
  // space (agent-session.ts), so "/qdrant search foo" arrives here as the command
  // "qdrant" with args "search foo". The grammar (ARG_SHAPE, the kind registry,
  // completion) lives in src/commands.ts; this block is the only routing code.
  const indexRunners: Record<IndexKind, () => Promise<SyncResult>> = { code: runCodeSync };

  /** One-shot arm of the migration notice (plan Part D.2). Called ONLY once a
   *  `/qdrant` invocation was recognised by the grammar — the bare form, or a
   *  known key whose arguments passed `checkArgShape`. An unknown key or an
   *  argument-shape error returns before this point, because such a user has
   *  demonstrably not migrated.
   *
   *  The `noticeMarked` latch makes the write at most once per process: the
   *  command runs many times per session, and stat-ing/writing the state file on
   *  every keystroke-driven invocation would be pure noise. After the first
   *  success this closure does no filesystem work at all. */
  let noticeMarked = false;
  const markNoticeShown = (): void => {
    if (noticeMarked) return;
    noticeMarked = true;
    try { markCommandFormatNoticeShown(rt.agentDir); } catch { /* best-effort: advisory state */ }
  };

  /** Usage line for a key whose bounded token is missing, keyed by the `enum`
   *  keys of ARG_SHAPE (`Record<EnumKey, string>`): a future enum key is a
   *  compile error here, never a silent fall-through to another key's text
   *  (#62). The strings come from out.ts; the index line is generated from
   *  INDEX_KINDS so it cannot drift. */
  const ENUM_USAGE: Record<EnumKey, string> = {
    clear: clearUsageText(),
    index: indexUsageText(INDEX_KINDS),
  };

  /** Only `enum` keys can report `missing-value`, so the guard always holds; it
   *  exists to narrow the key without a cast. The non-enum branch prints the
   *  generic usage line — unreachable, but never another key's text. */
  const enumUsageText = (key: QdrantKey): string =>
    isEnumKey(key) ? ENUM_USAGE[key] : commandUsageText(USAGE_KEYS);

  const runQdrantCommand = async (args: string): Promise<void> => {
    const parsed = parseQdrantArgs(args);
    if (parsed.key === undefined) {
      // Bare form: self-documenting in every mode — the status block plus the
      // command list. Anything else is an unknown key.
      if (parsed.raw === "") {
        markNoticeShown();
        await statusHandler(io);
        await helpHandler(io);
        return;
      }
      io.emit(errorEntry(unknownKeyText(parsed.raw, USAGE_KEYS)));
      return;
    }
    const key = parsed.key;
    const problem = checkArgShape(key, parsed.rest);
    if (problem) {
      // Nothing is guessed: a missing bounded token prints that key's own usage
      // line; anything else is one error entry naming the correction.
      if (problem.kind === "missing-value") { io.emit(message(enumUsageText(key))); return; }
      if (problem.kind === "no-argument") { io.emit(errorEntry(noArgumentText(key))); return; }
      if (problem.kind === "unknown-value") { io.emit(errorEntry(unknownValueText(key, problem.value, problem.values, USAGE_KEYS))); return; }
      io.emit(errorEntry(unexpectedArgumentText(problem.corrected)));
      return;
    }
    // Past the grammar gate: the user typed a valid `/qdrant <key> [...]`, so
    // the migration notice has served its purpose (Part D.2).
    markNoticeShown();
    switch (key) {
      case "status":
        await statusHandler(io);
        return;
      case "help":
        await helpHandler(io);
        return;
      case "search":
        // free text, verbatim — never re-tokenised
        await searchHandler(io, parsed.rest);
        return;
      case "remember":
        await rememberHandler(io, parsed.rest);
        void refreshStatus();
        return;
      case "forget":
        await forgetHandler(io, parsed.rest, api.requestUI?.());
        void refreshStatus();
        return;
      case "settings": {
        if (parsed.rest === "") {
          const ui = api.requestUI?.();
          if (ui) { await runSettingsForm(ui, io); return; }
          // No dialog-capable ui (print/headless harnesses): print usage. NOT an
          // rpc fallback — rpc sets ctx.hasUI = true and implements the dialog
          // trio over extension_ui_request/response, so requestUI() returns a ui
          // there and the form path above runs (issue #51).
          await settingsHandler(io);
          return;
        }
        // Only the key token is bounded; the value is the verbatim remainder.
        const { field, value } = splitKeyedArg(parsed.rest);
        await settingsHandler(io, field, value);
        return;
      }
      case "clear": {
        // The target in the registry's own spelling (`clear ALL` → `all`);
        // checkArgShape already accepted it, so `?? ""` is unreachable and lands
        // on the usage line rather than dispatching an unvalidated token.
        const target = canonicalEnumArg("clear", parsed.rest) ?? "";
        // requestUI() is undefined when no dialog-capable UI is present — the
        // handler then refuses to clear `all` rather than deleting blindly.
        await clearHandler(io, target, api.requestUI?.());
        void refreshStatus();
        return;
      }
      case "index": {
        // The kind in the registry's own spelling (`index CODE` → `code`), so
        // INDEX_KINDS[kind] is always a real entry — no cast, no guess. The
        // undefined branch is unreachable and prints the key's own usage line.
        const kind = canonicalIndexKind(parsed.rest);
        if (kind === undefined) { io.emit(message(enumUsageText("index"))); return; }
        // Live-config guard (spec §10.1/§12): after a mid-session flip-off this
        // answers honestly instead of silently indexing; the code_memory TOOL
        // still requires the session reload. Declared per kind via INDEX_KINDS.
        const gate = INDEX_KINDS[kind].gate;
        if (rt.cfg[gate] !== "on") {
          io.emit(message(`code memory is disabled (${gate}: off)`));
          return;
        }
        const r = await indexRunners[kind]();
        if (!r.ok) {
          io.emit(errorEntry(`code memory: sync failed — ${r.error ?? "unknown error"}`));
          return;
        }
        io.emit(message(codeMemorySyncMessage({
          files: r.files,
          symbols: r.symbols,
          deleted: r.deleted,
        })));
        return;
      }
    }
    // Compile-time exhaustiveness (#62): every key returns above, so control
    // only reaches this line if a key was added to ARG_SHAPE without an arm —
    // then `key` is no longer `never` and the build fails instead of the
    // command answering "unknown key" for a *valid* key.
    const unhandled: never = key;
    throw new Error(`pi-qdrant-memory: unhandled /qdrant key ${unhandled}`);
  };

  const commands: CommandDef[] = [
    {
      name: "qdrant",
      description: "Show status, search memories, and manage settings for this project",
      execute: runQdrantCommand,
      getArgumentCompletions: getQdrantCompletions,
    },
  ];
  for (const c of commands) {
    api.registerCommand({
      name: c.name,
      description: c.description,
      execute: c.execute,
      getArgumentCompletions: c.getArgumentCompletions,
    });
  }

  // ── Lifecycle handlers ─────────────────────────────────────────────────────
  const ingestPending = async (): Promise<void> => {
    // Mode 1: ingest pi-blackhole's pending durable artifacts (catch-up). Never
    // claims the compaction hook. Idempotent via deterministic point ids.
    try {
      const arts = readPendingArtifacts(rt.agentDir);
      const items = arts.map((a) => artifactToIngestItem(a, rt.projectId, Date.now()));
      if (items.length) {
        await ingestItems({
          embed: rt.embed,
          embedBatch: rt.embedBatch,
          qdrant: rt.qdrant,
          projectId: rt.projectId,
        }, rt.cfg.expectedDimension, items);
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
    // The hosting project drives its own settings (D7): re-resolve the effective
    // config for the live projectId and swap it into the runtime. Unconditional
    // (not just on re-anchor) so a store written by another session is picked up
    // too. Local disk only — never blocks on Qdrant; applyConfig swaps cfg +
    // clients and does NOT re-register.
    rt.reloadEffectiveConfig();
    // Corrupt-file warning (#57): the reader already fell back to the safe
    // default, so this is the only place the user learns their settings were
    // ignored. Drained AFTER the reload, so it covers both the factory-time read
    // and this one; a drain that finds nothing emits nothing. Gated on the mode
    // for the same reason as the notice below. Best-effort: a lifecycle handler
    // must never throw.
    try {
      if (!isHeadlessMode(ctx)) {
        const unreadable = takeLoadWarnings();
        if (unreadable.length > 0) api.appendEntry(CUSTOM_TYPE, message(loadWarningText(unreadable)));
      }
    } catch { /* never block session_start on a warning */ }
    // The /qdrant-* → /qdrant migration notice (plan Part D.2): emitted at the
    // start of every session until the user successfully dispatches any /qdrant
    // key (runQdrantCommand arms the flag, and only there). NOT headless-gated
    // on write because this path never writes; and never throws.
    try {
      if (!isHeadlessMode(ctx) && readState(rt.agentDir).commandFormatNoticeShown !== true) {
        api.appendEntry(CUSTOM_TYPE, commandFormatNoticeEntry());
      }
    } catch { /* never block session_start on a notice */ }
    // Footer statusline — icon-led label like ketch's "🌐 ketch: active", then
    // the stored-memory count + mode + project collection as the state
    // (DESIGN.md footer-status). Mode is re-resolved live so a /qdrant settings
    // mode change is reflected without a restart.
    const mode = resolveMode(rt.cfg, detectBlackhole(rt.agentDir));
    api.setStatus(memoryHeaderText({ mode, collection: rt.projectId }));
    if (mode === "mode1") await ingestPending();
    void refreshStatus(); // repaint with the count once known, best-effort
    // LIVE effective gate (D7 item 4): a session re-anchored into a project
    // whose override is off must skip the sync even when the factory-time value
    // was on. Same shape as /qdrant index code's live-config guard. Tool
    // registration stays fixed to `codeMemoryOn` (session-fixed by design).
    if (rt.cfg.codeKnowledge === "on") {
      // Fire-and-forget code sync (spec §10): never blocks session start.
      void runCodeSync();
    } else {
      codeMemoryState.state = "off";
    }
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
    )
      .then((r) => { if (r.ingested > 0) void refreshStatus(); })
      .catch((err) => console.error(`pi-qdrant-memory: compaction capture error (non-fatal): ${String(err)}`));
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
  if (registrationMode === "mode1") {
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
//   - on(event, handler) — handler receives (event, ctx); the returned
//     `() => void` unsubscribes that one handler (#55 — the host DOES return an
//     unsubscribe: `on(event: "session_start", ...): () => void` in
//     `dist/core/extensions/types.d.ts:1146`, implemented as a real removal from
//     the per-extension handler map in `dist/core/extensions/loader.js:213-227`)
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
  registerCommand(name: string, options: {
    description?: string;
    handler(args: string, ctx: unknown): void | Promise<void>;
    getArgumentCompletions?: (prefix: string) => Array<{ value: string; label?: string; description?: string }> | null;
  }): void;
  on(event: string, handler: (payload: unknown, ctx: unknown) => void | Promise<void>): () => void;
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
  // #60: prefer the host's own `getAgentDir()` so this extension and pi resolve
  // PI_CODING_AGENT_DIR to the *same* tree (the host expands a leading `~`; the
  // pure fallback below does too). Lazily imported — a plain-node run never
  // resolves the host package, and the loader's rules forbid a top-level import.
  const agentDir = (await loadHostAgentDir()) ?? agentDirFromEnv(env);

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

  // Assigned by makeRuntime below; writeGlobalConfig may run later (after a
  // settings write) and needs to reload the assembled runtime onto the new
  // config.
  let rt: RuntimeDeps | undefined;

  const io: MakeRuntimeIO = {
    readGlobalConfig: () => readGlobalConfig(agentDir, env),
    writeGlobalConfig: (c) => {
      // D10 fix: `io.writeConfig` reloaded with `loadConfig` (global), which
      // would drop a live project override from the runtime for the rest of the
      // session. Persist the global file, then re-apply the EFFECTIVE reader.
      if (rt) writeGlobalConfigAndReload(rt, agentDir, c);
      else writeConfigFile(agentDir, c);
    },
    // Text sink for non-wire paths (handlers emit structured entries via the
    // wireApi adapter's appendEntry; this is the plain fallback).
    print: (text) => pi.appendEntry(CUSTOM_TYPE, { kind: "message", text }),
  };

  rt = await makeRuntime(agentDir, process.cwd(), env, io);

  const adapter: WireApi = {
    registerTool: (def) => pi.registerTool(def),
    registerCommand: (def) => {
      // One real pi command per def. pi splits the line on the first space, so
      // "/qdrant search foo" resolves the command "qdrant" with
      // args = "search foo" and the def runs on its own argument text — the
      // subcommand dispatch itself lives in wireApi.
      const d = def as {
        name?: string;
        description?: string;
        execute?: (args: string) => Promise<void>;
        getArgumentCompletions?: (prefix: string) => Array<{ value: string; label?: string; description?: string }> | null;
      };
      if (!d.name) return;
      pi.registerCommand(d.name, {
        description: d.description,
        getArgumentCompletions: d.getArgumentCompletions,
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
      // #55: forward the host's REAL unsubscribe. The wrapper below only
      // remembers the ctx.ui handle, which is per-invocation state, so
      // unsubscribing the host subscription is exactly `pi.on`'s own return
      // value — no bookkeeping of our own is needed.
      return pi.on(event, (payload, ctx) => {
        // Remember the ui context so setStatus()/future notify() calls can route.
        const ui = (ctx as { ui?: unknown } | undefined)?.ui as typeof currentUi;
        if (ui) currentUi = ui;
        return handler(payload, ctx);
      });
    },
    appendEntry: (_type, data) => { pi.appendEntry(CUSTOM_TYPE, data); },
    setStatus: (text) => {
      try { currentUi?.setStatus?.(QDRANT_STATUS_KEY, text); } catch { /* status is best-effort */ }
    },
    requestUI: () => {
      // Only expose the interactive dialogs when the current ui context really
      // has them. The interactive TUI and rpc both provide the trio (rpc
      // translates select/input/confirm into extension_ui_request/response and
      // sets ctx.hasUI = true, per pi docs/rpc.md); print/headless contexts may
      // not (issue #51).
      const u = currentUi;
      if (!u || typeof u.select !== "function" || typeof u.input !== "function" || typeof u.confirm !== "function") {
        return undefined;
      }
      return { select: u.select, input: u.input, confirm: u.confirm } satisfies SettingsUI;
    },
  };

  const cleanup = wireApi(adapter, rt);

  // #55: the cleanup is no longer dropped. The host discards a factory's return
  // value (`initializeExtension`: `await factory(load.api)` with nothing bound,
  // `dist/core/extensions/loader.js:505-517`) and `ExtensionFactory`'s type is
  // `(pi) => void | Promise<void>`, so there is no return-value hook to hang
  // teardown on. `session_shutdown` IS the host's teardown event — pi emits it
  // from `teardownCurrent`/`dispose` (`agent-session-runtime.ts`) and pi's own
  // bundled MCP extension releases its connections there.
  //
  // Safety of unsubscribing from inside a handler: the runner dispatches from a
  // snapshot (`snapshotEventHandlers` copies the handler arrays,
  // `dist/core/extensions/runner.js:807-830`), so removing handlers mid-emit
  // cannot skip a sibling that has not run yet — in mode1 the shutdown-time
  // ingest is registered first and therefore still runs. Registering this AFTER
  // `wireApi` guarantees that ordering. On a session switch pi reloads the whole
  // extension set (`clearExtensionCache()` + re-running every factory), so these
  // unsubscribes only ever touch the Extension object being discarded anyway.
  //
  // The hook unsubscribes ITSELF too: `cleanup()` only knows about the handlers
  // wireApi registered through the adapter, not this one, which is registered
  // directly on `pi`. Leaving it in place would keep this closure — and the whole
  // runtime it holds — alive for the life of the Extension object.
  const offTeardown = pi.on("session_shutdown", () => {
    try { cleanup(); } catch { /* teardown must never throw */ }
    try { offTeardown(); } catch { /* already removed */ }
  });
}
