import test from "node:test";
import assert from "node:assert/strict";
import {
  ARG_SHAPE,
  CLEAR_TARGETS,
  COMMAND_ROWS,
  INDEX_KINDS,
  USAGE_KEYS,
  canonicalEnumArg,
  canonicalIndexKind,
  checkArgShape,
  getQdrantCompletions,
  isEnumKey,
  parseQdrantArgs,
  splitKeyedArg,
} from "../src/commands.ts";
import type { EnumKey, QdrantKey } from "../src/commands.ts";
import { commandUsageText, indexUsageText, unknownKeyText, unknownValueText, noArgumentText, unexpectedArgumentText } from "../src/out.ts";
import { SETTING_FIELDS } from "../src/config.ts";

const KEYS = Object.keys(ARG_SHAPE) as QdrantKey[];

// ── parseQdrantArgs ───────────────────────────────────────────────────────────

test("the bare form has no key and no rest, for any amount of whitespace", () => {
  for (const raw of ["", "   ", "\n\t "]) {
    assert.deepEqual(parseQdrantArgs(raw), { key: undefined, rest: "", raw: "" });
  }
});

test("each key is recognized as the head token", () => {
  for (const key of KEYS) {
    assert.equal(parseQdrantArgs(key).key, key);
    assert.equal(parseQdrantArgs(key).rest, "");
  }
});

test("free text is preserved verbatim — internal spaces, quotes, trailing whitespace", () => {
  const parsed = parseQdrantArgs("search   the  \"exact  phrase\"   trailing   ");
  assert.equal(parsed.key, "search");
  // Only the head is tokenised; the remainder is never re-split, so the run of
  // spaces after the head collapses exactly once at the join.
  assert.equal(parsed.rest, "the  \"exact  phrase\"   trailing");
  assert.equal(parsed.raw, "search   the  \"exact  phrase\"   trailing");
});

test("unknown heads stay representable so the caller can emit one error entry", () => {
  const parsed = parseQdrantArgs("bogus thing");
  assert.equal(parsed.key, undefined);
  assert.equal(parsed.raw, "bogus thing");
  assert.equal(parsed.rest, "thing");
  // Same text as the builder, so dispatch has nothing to spell out itself.
  assert.equal(unknownKeyText(parsed.raw, USAGE_KEYS), `error: unknown key "bogus thing"\n${commandUsageText(USAGE_KEYS)}`);
});

test("splitKeyedArg splits the bounded key token from a verbatim value", () => {
  assert.deepEqual(splitKeyedArg(""), { field: "", value: undefined });
  assert.deepEqual(splitKeyedArg("scoreThreshold"), { field: "scoreThreshold", value: undefined });
  assert.deepEqual(
    splitKeyedArg("qdrantUrl   http://user:pw@host:6333  "),
    { field: "qdrantUrl", value: "http://user:pw@host:6333" },
  );
  // A value with internal spaces is not re-tokenised.
  assert.deepEqual(splitKeyedArg("embeddingModel  my model  v2"), { field: "embeddingModel", value: "my model  v2" });
});

// ── ARG_SHAPE: the single grammar table ───────────────────────────────────────

test("ARG_SHAPE assigns the documented shape to every key", () => {
  const byKind = (kind: string): QdrantKey[] => KEYS.filter((k) => ARG_SHAPE[k].kind === kind);
  assert.deepEqual(byKind("none").sort(), ["help", "status"]);
  assert.deepEqual(byKind("free").sort(), ["forget", "remember", "search"]);
  assert.deepEqual(byKind("enum").sort(), ["clear", "index"]);
  assert.deepEqual(byKind("keyed"), ["settings"]);
  // Declaration order is the presentation order shared with the help rows.
  assert.deepEqual(KEYS, ["status", "settings", "remember", "search", "forget", "clear", "index", "help"]);
});

test("the settings key token is exactly the settings surface's field list", () => {
  const shape = ARG_SHAPE.settings;
  assert.equal(shape.kind, "keyed");
  assert.deepEqual(shape.kind === "keyed" ? shape.values : [], SETTING_FIELDS);
  assert.equal(SETTING_FIELDS.length, 12);
});

test("the command registry has one row per key, in grammar order, each naming its own command", () => {
  // The registry is the ONE table behind the help rows and the completion
  // summaries — no second list can drift (the old parity test lived here).
  assert.deepEqual(Object.keys(COMMAND_ROWS), KEYS);
  for (const key of KEYS) {
    const row = COMMAND_ROWS[key];
    assert.ok(row.cmd.startsWith(`/qdrant ${key}`), `row for ${key} names its own key`);
    assert.ok(row.desc.length > 0, `missing help description for ${key}`);
    assert.ok(row.summary.length > 0, `missing completion summary for ${key}`);
  }
  // Only the index row is feature-gated, and its gate is a real config flag.
  assert.deepEqual(Object.entries(COMMAND_ROWS).filter(([, r]) => r.gated).map(([k]) => k), ["index"]);
});

test("enum values come from their registries, not from a second list", () => {
  const clear = ARG_SHAPE.clear;
  assert.deepEqual(clear.kind === "enum" ? clear.values : [], CLEAR_TARGETS);
  const index = ARG_SHAPE.index;
  assert.deepEqual(index.kind === "enum" ? index.values : [], Object.keys(INDEX_KINDS));
});

// ── The usage line and the enum-key union cannot drift (#62) ─────────────────

test("the printed usage line is ARG_SHAPE's own key list, in declaration order", () => {
  // No hand-maintained key list: the grammar owns it, so adding a key to
  // ARG_SHAPE cannot leave the usage line printing a stale set.
  assert.deepEqual([...USAGE_KEYS], Object.keys(ARG_SHAPE));
  assert.equal(
    commandUsageText(USAGE_KEYS),
    `usage: /qdrant <key> — ${Object.keys(ARG_SHAPE).join(" | ")}`,
  );
  // The wording is the contract users read; only the key list is derived.
  assert.match(commandUsageText(USAGE_KEYS), /^usage: \/qdrant <key> — /);
});

test("isEnumKey holds exactly for the keys whose second token is bounded", () => {
  const enums = KEYS.filter((k) => isEnumKey(k));
  assert.deepEqual(enums, KEYS.filter((k) => ARG_SHAPE[k].kind === "enum"));
  // The guard is what makes the dispatcher's per-key usage map exhaustive at
  // compile time (Record<EnumKey, string> in index.ts).
  assert.deepEqual(enums.sort(), ["clear", "index"]);
  assert.equal(isEnumKey("status"), false);
  assert.equal(isEnumKey("settings"), false);
  const exhaustive: Record<EnumKey, true> = { clear: true, index: true };
  assert.equal(Object.keys(exhaustive).length, enums.length);
});

// ── checkArgShape ─────────────────────────────────────────────────────────────

test("none keys: a remainder is a correction, never a silent ignore", () => {
  assert.equal(checkArgShape("status", ""), undefined);
  assert.deepEqual(checkArgShape("status", "now"), { kind: "no-argument" });
  assert.deepEqual(checkArgShape("help", "me please"), { kind: "no-argument" });
  assert.equal(noArgumentText("status"), "error: /qdrant status takes no arguments — try /qdrant status");
});

test("free keys accept anything, including an empty query", () => {
  for (const key of ["search", "remember", "forget"] as const) {
    assert.equal(checkArgShape(key, ""), undefined);
    assert.equal(checkArgShape(key, "a \"quoted  query\" and   spaces"), undefined);
  }
});

test("enum keys: a missing token is reported as missing, an unknown one names the values", () => {
  assert.deepEqual(checkArgShape("clear", ""), { kind: "missing-value", values: CLEAR_TARGETS });
  assert.deepEqual(checkArgShape("index", ""), { kind: "missing-value", values: Object.keys(INDEX_KINDS) });
  assert.deepEqual(checkArgShape("index", "documents"), {
    kind: "unknown-value", value: "documents", values: Object.keys(INDEX_KINDS),
  });
  assert.equal(
    unknownValueText("index", "documents", Object.keys(INDEX_KINDS), USAGE_KEYS),
    `error: unknown index value "documents" — accepted: ${Object.keys(INDEX_KINDS).join(", ")}\n${commandUsageText(USAGE_KEYS)}`,
  );
});

test("enum keys: a valid token passes, extra tokens quote the corrected command", () => {
  assert.equal(checkArgShape("clear", "all"), undefined);
  assert.equal(checkArgShape("index", "code"), undefined);
  assert.deepEqual(checkArgShape("index", "code extra"), { kind: "too-many", corrected: "/qdrant index code" });
  assert.equal(unexpectedArgumentText("/qdrant index code"), "error: unexpected arguments — try /qdrant index code");
  // A wrong token is reported as wrong even when more tokens follow it.
  assert.deepEqual(checkArgShape("index", "documents extra"), {
    kind: "unknown-value", value: "documents", values: Object.keys(INDEX_KINDS),
  });
});

test("keyed keys are never shape-rejected — setConfigField owns field validation", () => {
  assert.equal(checkArgShape("settings", ""), undefined);
  assert.equal(checkArgShape("settings", "scoreThreshold 0.9"), undefined);
  // Unknown fields reach settingsHandler, which answers with its shared error.
  assert.equal(checkArgShape("settings", "not-a-field 1"), undefined);
});

// ── Case variants (#61) ──────────────────────────────────────────────────────
// Completion has always matched the bounded token case-insensitively, so
// `/qdrant clear ALL` used to work (the old handler lowercased its target). The
// dispatcher must accept exactly what completion suggests.

test("enum tokens match case-insensitively, so a case variant is not a rejection", () => {
  for (const token of ["all", "ALL", "All", "aLL"]) {
    assert.equal(checkArgShape("clear", token), undefined, `clear ${token}`);
    assert.equal(canonicalEnumArg("clear", token), "all", `clear ${token}`);
  }
  for (const token of ["code", "CODE", "Code"]) {
    assert.equal(checkArgShape("index", token), undefined, `index ${token}`);
    assert.equal(canonicalIndexKind(token), "code", `index ${token}`);
  }
  // Case-insensitivity never widens the vocabulary: only real values pass.
  assert.deepEqual(checkArgShape("clear", "allx"), {
    kind: "unknown-value", value: "allx", values: CLEAR_TARGETS,
  });
  assert.equal(canonicalEnumArg("clear", "allx"), undefined);
  assert.equal(canonicalIndexKind("documents"), undefined);
});

test("a case variant still gets a corrected command quoted in the canonical spelling", () => {
  assert.deepEqual(checkArgShape("index", "CODE extra"), {
    kind: "too-many", corrected: "/qdrant index code",
  });
  assert.deepEqual(checkArgShape("clear", "ALL extra"), {
    kind: "too-many", corrected: "/qdrant clear all",
  });
  // The unknown-value error names what the user typed, not the canonical form.
  assert.deepEqual(checkArgShape("clear", "Bogus"), {
    kind: "unknown-value", value: "Bogus", values: CLEAR_TARGETS,
  });
});

test("canonical dispatch tokens resolve to a real registry key, or nothing", () => {
  // The dispatcher runs these, so they must be spellings a registry can index.
  for (const rest of ["", "all", "ALL", "all extra"]) {
    const arg = canonicalEnumArg("clear", rest);
    assert.ok(arg === undefined || CLEAR_TARGETS.includes(arg as (typeof CLEAR_TARGETS)[number]), `clear ${rest}`);
  }
  for (const rest of ["", "code", "CODE"]) {
    const kind = canonicalIndexKind(rest);
    assert.ok(kind === undefined || Object.hasOwn(INDEX_KINDS, kind), `index ${rest}`);
  }
  // A non-enum key has no bounded token at all.
  assert.equal(canonicalEnumArg("status", ""), undefined);
  assert.equal(canonicalEnumArg("settings", "scoreThreshold 0.5"), undefined);
  assert.equal(canonicalEnumArg("clear", ""), undefined);
});

test("every value completion suggests is accepted by the dispatcher, in any case", () => {
  // The bug this pins (#61): completion suggested a token the dispatcher
  // rejected when typed literally.
  for (const head of ["clear", "index"] as const) {
    for (const partial of ["", "a", "A", "c", "C"]) {
      const suggestions = getQdrantCompletions(`${head} ${partial}`) ?? [];
      for (const s of suggestions) {
        assert.equal(checkArgShape(head, s.value), undefined, `${head} ${partial} → ${s.value}`);
        const canonical = canonicalEnumArg(head, s.value);
        assert.ok(canonical !== undefined && canonical === s.value, `${head} suggests ${s.value}`);
      }
    }
  }
});

// ── getQdrantCompletions ──────────────────────────────────────────────────────

test("no space yet: all eight keys with value, label and description", () => {
  const completions = getQdrantCompletions("");
  assert.deepEqual(completions?.map((c) => c.value), KEYS);
  for (const c of completions ?? []) {
    assert.equal(c.label, c.value);
    assert.ok(c.description, "every key completion carries a description");
  }
});

test("keys are filtered by prefix, case-insensitively", () => {
  // Declaration order is preserved, so the menu keeps the help block's order.
  assert.deepEqual(getQdrantCompletions("s")?.map((c) => c.value), ["status", "settings", "search"]);
  assert.deepEqual(getQdrantCompletions("re")?.map((c) => c.value), ["remember"]);
  // A still-being-typed key prefix matches case-insensitively…
  assert.deepEqual(getQdrantCompletions("INDEX")?.map((c) => c.value), ["index"]);
  // …but a committed head is matched exactly, the way dispatch matches it.
  assert.deepEqual(getQdrantCompletions("INDEX "), []);
  // A leading run of whitespace is not a token.
  assert.deepEqual(getQdrantCompletions("  c")?.map((c) => c.value), ["clear"]);
});

test("a prefix that matches no key returns [] — never null", () => {
  assert.deepEqual(getQdrantCompletions("zzz"), []);
  // Unknown head after a space: same rule, suppress the menu.
  assert.deepEqual(getQdrantCompletions("bogus "), []);
});

test("enum heads complete their values, and nothing past the second token", () => {
  assert.deepEqual(getQdrantCompletions("clear "), [{ value: "all", label: "all" }, { value: "code", label: "code" }]);
  assert.deepEqual(getQdrantCompletions("clear c"), [{ value: "code", label: "code" }]);
  assert.deepEqual(getQdrantCompletions("clear x"), []);
  assert.equal(getQdrantCompletions("clear code "), null);
  // The index kinds come from the registry, so a second kind needs no code here.
  assert.deepEqual(
    getQdrantCompletions("index ")?.map((c) => c.value),
    Object.keys(INDEX_KINDS),
  );
  assert.equal(getQdrantCompletions("index code now"), null);
});

test("the settings head completes the field names, then hands over to free text", () => {
  assert.deepEqual(getQdrantCompletions("settings ")?.map((c) => c.value), [...SETTING_FIELDS]);
  assert.deepEqual(getQdrantCompletions("settings code")?.map((c) => c.value), ["codeKnowledge", "codeScoreThreshold"]);
  assert.deepEqual(getQdrantCompletions("settings qdrantApiK")?.map((c) => c.value), ["qdrantApiKey"]);
  assert.equal(getQdrantCompletions("settings scoreThreshold 0."), null);
});

test("free and none heads complete nothing", () => {
  assert.equal(getQdrantCompletions("search "), null);
  assert.equal(getQdrantCompletions("search foo"), null);
  assert.equal(getQdrantCompletions("status "), null);
  assert.equal(getQdrantCompletions("help "), null);
});

// ── index kind registry ───────────────────────────────────────────────────────

test("INDEX_KINDS carries data only: a summary and a config gate per kind", () => {
  assert.deepEqual(Object.keys(INDEX_KINDS), ["code"]);
  for (const [kind, info] of Object.entries(INDEX_KINDS)) {
    assert.equal(typeof info.summary, "string", `${kind} has no summary`);
    assert.equal(typeof info.gate, "string", `${kind} has no gate`);
    // Data, never a function: referencing runCodeSync here would be a cycle.
    assert.ok(typeof info === "object" && info !== null);
  }
});

test("indexUsageText is generated from the kinds it is handed", () => {
  const text = indexUsageText(INDEX_KINDS);
  const lines = text.split("\n");
  assert.equal(lines[0], "index: usage — /qdrant index <kind>");
  assert.equal(lines.length, Object.keys(INDEX_KINDS).length + 1);
  for (const [kind, info] of Object.entries(INDEX_KINDS)) {
    assert.ok(lines.slice(1).some((l) => l.includes(kind) && l.includes(info.summary)), `missing ${kind} line`);
  }
  // A hypothetical second kind appears without touching the builder — and the
  // column re-aligns to the longest name.
  const extended = indexUsageText({ ...INDEX_KINDS, documents: { summary: "Index project documents" } });
  assert.equal(extended, [
    "index: usage — /qdrant index <kind>",
    "code      — Re-index code summaries now",
    "documents — Index project documents",
  ].join("\n"));
});