/**
 * The `/qdrant <key>` grammar — the single table the dispatcher, the argument
 * completion and the usage text all read, so a new key or a new enum value
 * cannot be added to one of them and forgotten in the others.
 *
 * Pure module: no pi imports, no network, no fs side effects. Data + parsing
 * only. `runCodeSync` closes over the runtime, so it lives in `wireApi`; the
 * `INDEX_KINDS` registry below holds **data only** (never functions) and
 * `wireApi` maps kind → runner.
 */
import { SETTING_FIELDS } from "./config.ts";

/** The eight subcommand keys. The bare form (`/qdrant`) is the absence of one. */
export type QdrantKey =
  | "status"
  | "settings"
  | "remember"
  | "search"
  | "forget"
  | "clear"
  | "help"
  | "index";

/** How a key treats the text after it. */
export type ArgShape =
  | { kind: "none" }                                    // status, help
  | { kind: "free" }                                    // search, remember, forget
  | { kind: "enum"; values: readonly string[] }          // clear, index — exactly one token
  | { kind: "keyed"; values: readonly string[] };        // settings — one key token, then free remainder

/**
 * Index kinds are a registry, not a special case: `/qdrant index` takes a kind
 * because more than one may exist. `gate` is the config key that must be `on`
 * for the kind to run; `summary` is the usage line for that kind.
 */
export const INDEX_KINDS = {
  code: { summary: "Re-index code summaries now", gate: "codeKnowledge" },
} as const;
export type IndexKind = keyof typeof INDEX_KINDS;

/** Accepted `clear` modifiers. */
export const CLEAR_TARGETS = ["all", "code"] as const;

/** The second-token vocabulary per enum key, derived from the registry. */
const INDEX_KIND_NAMES: readonly string[] = Object.keys(INDEX_KINDS);

/**
 * Declaration order IS the presentation order — the completion menu and the
 * help rows read this table, so the most common key comes first.
 *
 * Declared `as const satisfies Record<QdrantKey, ArgShape>` so each key's `kind`
 * stays a literal type: `EnumKey` below is derived from that, which makes the
 * per-key usage map in index.ts exhaustive at compile time (#62). `satisfies`
 * also cuts both ways — a missing key and a surplus key are both build errors.
 */
const ARG_SHAPE_DEF = {
  status: { kind: "none" },
  settings: { kind: "keyed", values: SETTING_FIELDS },
  remember: { kind: "free" },
  search: { kind: "free" },
  forget: { kind: "free" },
  clear: { kind: "enum", values: CLEAR_TARGETS },
  index: { kind: "enum", values: INDEX_KIND_NAMES },
  help: { kind: "none" },
} as const satisfies Record<QdrantKey, ArgShape>;

export const ARG_SHAPE: Record<QdrantKey, ArgShape> = ARG_SHAPE_DEF;

/**
 * The keys whose shape is `enum` — the ones whose *second* token is bounded.
 * Derived from `ARG_SHAPE_DEF`'s literal kinds, so a key added to the table as
 * `enum` widens this union and every `Record<EnumKey, …>` becomes a compile
 * error until it is handled (#62).
 */
export type EnumKey = {
  [K in QdrantKey]: (typeof ARG_SHAPE_DEF)[K] extends { kind: "enum" } ? K : never;
}[QdrantKey];

/** The keys in declaration order — the printed `/qdrant <key>` usage line reads
 *  this, so the usage text cannot drift from the grammar (#62). */
export const USAGE_KEYS: readonly string[] = Object.keys(ARG_SHAPE);

/** Whether a key's second token is bounded. A guard, not a cast: only `enum`
 *  keys report `missing-value`, and only they have a usage line. */
export function isEnumKey(key: QdrantKey): key is EnumKey {
  return ARG_SHAPE[key].kind === "enum";
}

/** One-line summaries shown as argument-completion descriptions. */
export const KEY_SUMMARY: Record<QdrantKey, string> = {
  status: "connection health, active mode, collection status",
  settings: "open the settings screen, or set a field: <key> <value>",
  remember: "save durable knowledge now: <text>",
  search: "semantic search of durable knowledge: <query>",
  forget: "search and remove memories interactively: <query>",
  clear: "reset the collection (all) or purge code summaries (code)",
  help: "list the commands",
  index: "re-index now: code",
};

export function isQdrantKey(token: string): token is QdrantKey {
  return Object.hasOwn(ARG_SHAPE, token);
}

export interface ParsedCommand {
  /** `undefined` for the bare form *and* for an unrecognised head — `raw` tells
   * the two apart, so the caller can emit one error entry with the usage line. */
  key: QdrantKey | undefined;
  /** Everything after the head, trimmed; never re-tokenised. */
  rest: string;
  /** The input with surrounding whitespace removed. */
  raw: string;
}

/**
 * Split `/qdrant`'s argument string into a key and the remainder. The head is
 * the first whitespace-delimited token; the remainder is the raw slice after it
 * (trimmed only at the ends), so free text keeps its internal spacing, quotes
 * and punctuation verbatim.
 */
export function parseQdrantArgs(args: string): ParsedCommand {
  const raw = args.trim();
  if (raw === "") return { key: undefined, rest: "", raw };
  const head = firstToken(raw);
  return { key: isQdrantKey(head) ? head : undefined, rest: raw.slice(head.length).trim(), raw };
}

export interface KeyedArgs { field: string; value: string | undefined; }

/**
 * Split a `keyed` remainder into its bounded field token and the free-text
 * value. The value is the verbatim remainder, never re-tokenised.
 */
export function splitKeyedArg(rest: string): KeyedArgs {
  const trimmed = rest.trim();
  if (trimmed === "") return { field: "", value: undefined };
  const field = firstToken(trimmed);
  const value = trimmed.slice(field.length).trim();
  return { field, value: value === "" ? undefined : value };
}

/** Why a key rejected its argument text. `undefined` means it is acceptable. */
export type ArgProblem =
  | { kind: "missing-value"; values: readonly string[] }
  | { kind: "unknown-value"; value: string; values: readonly string[] }
  | { kind: "too-many"; corrected: string }
  | { kind: "no-argument" };

/**
 * Enforce the key's `ArgShape` against the text after it. Nothing is guessed:
 * every rejection names either the accepted values or the corrected command.
 *
 * `free` keys never reject a remainder. `keyed` keys are accepted as-is — the
 * field token is validated downstream by the shared `setConfigField`, so the
 * command path and the form can never disagree about what a valid key is.
 *
 * Enum tokens match case-insensitively (completion already suggests them that
 * way, and `/qdrant clear ALL` worked before the consolidation), but the value
 * that leaves this function is always the registry's own spelling: the
 * `too-many` correction quotes a command that really runs, and the dispatcher
 * resolves the token with `canonicalEnumArg`/`canonicalIndexKind` before it
 * looks anything up in a registry.
 */
export function checkArgShape(key: QdrantKey, rest: string): ArgProblem | undefined {
  const shape = ARG_SHAPE[key];
  if (shape.kind === "free" || shape.kind === "keyed") return undefined;
  if (shape.kind === "none") return rest === "" ? undefined : { kind: "no-argument" };
  const tokens = rest === "" ? [] : rest.split(/\s+/);
  if (tokens.length === 0) return { kind: "missing-value", values: shape.values };
  const canonical = canonicalValue(shape.values, tokens[0]);
  if (canonical === undefined) return { kind: "unknown-value", value: tokens[0], values: shape.values };
  // A valid value plus extra tokens: quote the corrected command back, in the
  // canonical spelling so the quoted command is one that runs.
  if (tokens.length > 1) return { kind: "too-many", corrected: `/qdrant ${key} ${canonical}` };
  return undefined;
}

/** The registry's own spelling of `token`, matched case-insensitively;
 *  `undefined` when it is not one of `values`. */
function canonicalValue(values: readonly string[], token: string): string | undefined {
  const wanted = token.toLowerCase();
  return values.find((v) => v.toLowerCase() === wanted);
}

/**
 * The bounded token of an `enum` key, in the registry's spelling — what the
 * dispatcher must run with. `undefined` for a non-`enum` key or an unaccepted
 * token (never after a passing `checkArgShape`).
 */
export function canonicalEnumArg(key: QdrantKey, rest: string): string | undefined {
  const shape = ARG_SHAPE[key];
  if (shape.kind !== "enum") return undefined;
  return canonicalValue(shape.values, rest === "" ? "" : firstToken(rest));
}

function isIndexKind(value: string | undefined): value is IndexKind {
  return value !== undefined && Object.hasOwn(INDEX_KINDS, value);
}

/**
 * The `index` kind to run, in the registry's spelling. Typed as `IndexKind`, so
 * the dispatcher indexes `INDEX_KINDS[kind]` without a cast even though the
 * token arrives from user input.
 */
export function canonicalIndexKind(rest: string): IndexKind | undefined {
  const match = canonicalValue(INDEX_KIND_NAMES, rest === "" ? "" : firstToken(rest));
  return isIndexKind(match) ? match : undefined;
}

export interface QdrantCompletion { value: string; label?: string; description?: string }

/**
 * Two-level argument completion (`references/commands-and-arguments.md`):
 * the keys when no space has been typed, then the second-token vocabulary of an
 * `enum`/`keyed` head. `[]` suppresses the menu (the prefix matches nothing);
 * `null` means completion is not ours (free text, or past the bounded token).
 */
export function getQdrantCompletions(prefix: string): QdrantCompletion[] | null {
  // Only the LEFT edge is trimmed: a trailing space is the user's signal that the
  // bounded second token is being typed, so it must survive the split.
  const typed = prefix.replace(/^\s+/, "");
  const gap = typed.search(/\s/);
  if (gap < 0) {
    const partial = typed.toLowerCase();
    return (Object.keys(ARG_SHAPE) as QdrantKey[])
      .filter((k) => k.startsWith(partial))
      .map((k) => ({ value: k, label: k, description: KEY_SUMMARY[k] }));
  }
  const head = typed.slice(0, gap);
  if (!isQdrantKey(head)) return [];
  const shape = ARG_SHAPE[head];
  // Past the head the only bounded token is the second one; `free`/`none` keys
  // take text that is not ours to complete.
  if (shape.kind === "none" || shape.kind === "free") return null;
  const rest = typed.slice(gap).replace(/^\s+/, "");
  if (rest === "") return shape.values.map((v) => ({ value: v, label: v }));
  // Two tokens (or one plus its trailing space) means the value is already
  // being typed: the value is free text and completion stops here.
  const tokens = rest.split(/\s+/);
  if (tokens.length > 1) return null;
  const partial = tokens[0].toLowerCase();
  const matches = shape.values.filter((v) => v.toLowerCase().startsWith(partial));
  return matches.length > 0 ? matches.map((v) => ({ value: v, label: v })) : [];
}

/** First whitespace-delimited token of a non-empty, already-trimmed string. */
function firstToken(trimmed: string): string {
  return trimmed.split(/\s+/, 1)[0];
}