/**
 * The `/qdrant <key>` dispatcher: everything between the registered command and
 * the handlers.
 *
 * `src/index.ts` owns registration and the live per-invocation UI binding; this
 * module owns the routing decision (grammar gate → key → handler). Handlers keep
 * their `HandlerIO`; the dispatcher's own runtime touchpoints — the code-sync
 * runner, the migration-notice latch and the footer repaint — arrive as
 * `CommandDeps`, so the whole mapping is testable with a fake IO and no pi
 * surface, and no invocation state can leak between calls.
 */
import {
  INDEX_KINDS,
  USAGE_KEYS,
  canonicalEnumArg,
  canonicalIndexKind,
  checkArgShape,
  isEnumKey,
  parseQdrantArgs,
  splitKeyedArg,
} from "./commands.ts";
import type { EnumKey, IndexKind, QdrantKey } from "./commands.ts";
import type { SyncResult } from "./code-sync.ts";
import type { SettingsHost } from "./entry-render.ts";
import {
  clearHandler,
  forgetHandler,
  helpHandler,
  rememberHandler,
  runSettingsForm,
  searchHandler,
  settingsHandler,
  statusHandler,
} from "./handlers.ts";
import type { HandlerIO, SettingsUI } from "./handlers.ts";
import {
  clearUsageText,
  codeMemoryDisabledText,
  codeMemorySyncFailedText,
  codeMemorySyncMessage,
  commandUsageText,
  errorEntry,
  indexUsageText,
  message,
  noArgumentText,
  unknownKeyText,
  unknownValueText,
  unexpectedArgumentText,
} from "./out.ts";
import { openSettingsScreen } from "./settings-ui.ts";
import type { MountFn } from "./settings-ui.ts";

/**
 * The settings screen's host requirements, checked against the resolved bridge.
 *
 * Returns undefined when the bridge is missing ANY of the three symbols the
 * screen cannot run without, which is what makes graceful degradation a hard
 * rule rather than a hope: the dispatch then falls back to the dialog form or
 * the usage entry instead of mounting a half-built screen.
 */
function settingsHost(bridge: Partial<SettingsHost> | undefined): SettingsHost | undefined {
  if (!bridge?.SettingsList || !bridge.Input || !bridge.getSettingsListTheme) return undefined;
  return {
    SettingsList: bridge.SettingsList,
    Input: bridge.Input,
    getSettingsListTheme: bridge.getSettingsListTheme,
    ...(bridge.DynamicBorder ? { DynamicBorder: bridge.DynamicBorder } : {}),
    ...(bridge.keyText ? { keyText: bridge.keyText } : {}),
  };
}

/**
 * The live UI view of ONE command invocation (#56).
 *
 * Every field is read from the `ctx` the host passed to THAT handler — nothing
 * here is duck-typed and nothing is captured across handlers. `mode` is the
 * host's own predicate for "terminal-only UI is real"
 * (`dist/core/extensions/types.d.ts:216-219`), and `hasUI` is its
 * dialog-capable predicate (true in TUI and rpc).
 */
export interface CommandUi {
  hasUI: boolean;
  mode: "tui" | "rpc" | "json" | "print";
  /** select/input/confirm — present iff `hasUI`. */
  dialogs?: SettingsUI;
  /** `ctx.ui.custom` — present iff `mode === "tui"`. Its RPC implementation is
   *  a no-op (`dist/modes/rpc/rpc-mode.js`), so the modal is gated on mode. */
  custom?: MountFn;
}

/**
 * Everything the dispatcher needs from the wiring layer, resolved freshly for
 * the invocation in flight. `ui`/`host` are the LIVE per-invocation views
 * (`WireApi.commandUI()` / `WireApi.hostBridge()`) — never a captured ctx.
 */
export interface CommandDeps {
  io: HandlerIO;
  /** The live UI view of this invocation, or undefined outside one. */
  ui?: CommandUi;
  /** The resolved host bridge, or undefined when it has not resolved. */
  host?: Partial<SettingsHost>;
  /** Run one index kind (wireApi owns the runner map + its dedupe). */
  index(kind: IndexKind): Promise<SyncResult>;
  /** One-shot arm of the migration notice (wired to wireApi's latch). */
  notice(): void;
  /** Fire-and-forget footer repaint. */
  refreshStatus(): void;
}

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

/**
 * Route one `/qdrant` argument string to its handler. Stateless: the same call
 * with the same deps always reaches the same handler, and the only per-process
 * state the wiring adds (the notice latch, the code-sync dedupe) lives in
 * `wireApi` behind `CommandDeps`.
 */
export async function runQdrantCommand(args: string, deps: CommandDeps): Promise<void> {
  const { io } = deps;
  const parsed = parseQdrantArgs(args);
  if (parsed.key === undefined) {
    // Bare form: self-documenting in every mode — the status block plus the
    // command list. Anything else is an unknown key.
    if (parsed.raw === "") {
      deps.notice();
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
  deps.notice();
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
      deps.refreshStatus();
      return;
    case "forget":
      await forgetHandler(io, parsed.rest, deps.ui?.dialogs);
      deps.refreshStatus();
      return;
    case "settings": {
      if (parsed.rest === "") {
        const ui = deps.ui;
        // Plan B.5, decided from the LIVE ctx of this invocation:
        //   mode === "tui" → pi's own SettingsList modal
        //   hasUI          → the select → input → confirm sequence (rpc)
        //   otherwise      → the usage entry
        // `ctx.ui.custom` is a silent no-op under rpc
        // (dist/modes/rpc/rpc-mode.js), so the modal is gated on `mode`, not
        // on `hasUI`.
        if (ui?.mode === "tui" && ui.custom) {
          const host = settingsHost(deps.host);
          if (host) {
            await openSettingsScreen(io, host, ui.custom);
            return;
          }
        }
        if (ui?.hasUI && ui.dialogs) { await runSettingsForm(ui.dialogs, io); return; }
        // No dialog-capable UI (print/headless): print usage.
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
      // The deps' dialogs are undefined when no dialog-capable UI is present —
      // the handler then refuses to clear `all` rather than deleting blindly.
      await clearHandler(io, target, deps.ui?.dialogs);
      deps.refreshStatus();
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
      if (io.cfg[gate] !== "on") {
        io.emit(message(codeMemoryDisabledText(gate)));
        return;
      }
      const r = await deps.index(kind);
      if (!r.ok) {
        io.emit(errorEntry(codeMemorySyncFailedText(r.error)));
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
}
