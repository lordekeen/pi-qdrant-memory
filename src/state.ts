import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./config.ts";

/** One-shot flags persisted across sessions (Part D of the 2026-10-02 plan).
 * Lives in `state.json`, alongside the global config — deliberately not in the
 * config file, which is the user's editable settings surface.
 *
 * The index signature is load-bearing, not sloppiness (#57): the reader hands
 * back every top-level field it found so a future flag written by a *newer*
 * version of this file survives a write from an older one, and so
 * `markCommandFormatNoticeShown` can merge instead of clobber. */
export interface ExtensionState {
  commandFormatNoticeShown?: boolean;
  [key: string]: unknown;
}

export function statePath(agentDir: string): string {
  return join(agentDir, "pi-qdrant-memory", "state.json");
}

/** Tolerant reader: absent file, unreadable file, invalid JSON, or non-object
 * JSON all read as "no state" — never a throw, never a log.
 *
 * A present object is returned **whole** (#57), so fields this version does not
 * know about survive a round-trip through the writer. The one field this
 * version does read, `commandFormatNoticeShown`, is normalised: anything that
 * is not the literal boolean `true` is dropped, which is what makes the callers'
 * `state.commandFormatNoticeShown === true` check the whole test. */
export function readState(agentDir: string): ExtensionState {
  let raw: string;
  try {
    raw = readFileSync(statePath(agentDir), "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  // Copy rather than return the parsed object directly: dropping a non-`true`
  // flag must not mutate what a caller re-merges back into the file.
  const state: ExtensionState = { ...(parsed as Record<string, unknown>) };
  if (state.commandFormatNoticeShown !== true) delete state.commandFormatNoticeShown;
  return state;
}

/** Best-effort flag writer, called ONLY from a successful `/qdrant` dispatch.
 *
 * Read-merge-write (#57): a fresh `{ commandFormatNoticeShown: true }` object
 * would delete every other top-level field in `state.json`, so an older version
 * of the extension would silently discard flags a newer one wrote.
 *
 * Writes temp-then-rename (`writeJsonAtomic`) so a crash cannot leave a
 * truncated file that reads as "not shown" forever. Every fs operation stays
 * wrapped: state is advisory, so the worst outcome of a failure is that the
 * one-shot notice shows again next session — never a throw out of a command
 * handler. */
export function markCommandFormatNoticeShown(agentDir: string): void {
  try {
    const file = statePath(agentDir);
    // A corrupt file reads as `{}` here, so marking also heals it back to valid
    // JSON — the only "field" it could still have held was unrecoverable anyway.
    const merged: ExtensionState = { ...readState(agentDir), commandFormatNoticeShown: true };
    writeJsonAtomic(file, merged);
  } catch {
    // Swallowed on purpose: state is advisory, never fatal.
  }
}