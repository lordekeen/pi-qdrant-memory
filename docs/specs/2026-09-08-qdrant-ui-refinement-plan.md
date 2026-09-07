# pi-qdrant-memory — /qdrant-* UI Refinement Implementation Plan

Date: 2026-09-08. Contract: `DESIGN.md` (rewritten) · Decisions: `docs/specs/2026-09-08-qdrant-ui-refinement-decisions.md`.

Goal: move slash-command output from plain prefixed text to the DESIGN.md
"content-first chrome" contract — structured entries (status card, expandable
search, typed confirmations/errors), host-theme semantic colors/glyphs, no
`/qdrant: ` text echo. Tool return strings (`memory_save`/`memory_search`) and
`renderHits` are **untouched** (LLM-facing).

## 1. Design decisions (the seams)

### 1.1 Typed output model — new pure module `src/out.ts` (no pi imports)

```ts
export type OutEntry =
  | { kind: "message"; text: string }                     // confirmations, usage, zero-hits, help text
  | { kind: "error"; text: string }                       // whole row in error slot
  | { kind: "help"; rows: Array<{ cmd: string; desc: string }> }
  | { kind: "status"; mode: string; rows: StatusRow[]; detail: StatusRow[] } // collapsed card + expanded rows
  | { kind: "search"; count: number; top?: TopLine; hits: HitView[] };       // collapsed + expanded content
```

`StatusRow = { label: string; value: string; state?: "ok"|"warn"|"err" }`;
`HitView = { type: MemoryType; score: number; pointer: string; text: string }` (text **verbatim**);
`TopLine` = the collapsed summary bits. Put the **exact strings/glyphs from
DESIGN.md** in builders here.

Also export a pure **outline renderer** `renderOut(e): OutLine[]` where
`OutLine = { text: string; role?: "default"|"bold"|"success"|"warning"|"error"|"accent"|"dim"|"muted"; card?: boolean }`.
This is the single source of truth for content AND per-line style roles, so it
is fully unit-testable under plain node. `renderOut` decides collapsed vs
expanded via a `{ expanded: boolean }` arg.

Rules enforced in `renderOut`:
- status collapsed = card lines (`memory: mode1` bold; `qdrant: ✓ reachable · N points`; `embeddings: ✓ reachable`); unhealthy rows whole-line `error`/`warning` role; missing-collection variant `! collection … does not exist yet` warning. Expanded appends `detail` rows (collection, qdrant url, model @ base, `dimension: N · threshold: T · maxResults: M`) — never API keys. No card on detail.
- search collapsed = `N results · top [type] score` (single line; type part role = per-type color; rest default) — shown **only when hits exist**, plus a `(enter to expand)` hint handled by the renderer (1.3). Empty hits → `message` entry `No relevant memory found.`.
- search expanded = per hit: meta line `[type] score (pointer)` role = type color, then verbatim text default role; blank line between hits; never truncate.
- 200-char `…` truncation applies to the collapsed "top" preview only (see §3).
- Per-type color roles: `decision`→accent, `fact`→success, `constraint`→warning, `preference`→dim, `session_summary`→muted.

### 1.2 Channel seam: `HandlerIO.print` → `HandlerIO.emit`

- `src/handlers.ts`: replace `print(text: string)` on `HandlerIO` with
  `emit(e: OutEntry): void`. Keep the interface otherwise (live getters over
  `RuntimeDeps`).
- `depsToIO(deps, { emit })`: default `emit = (e) => deps.print(renderOutText(e))`
  (a plain-text join of `renderOut`), so plain-node/rpc runtimes and the
  factory's `MakeRuntimeIO.print` keep working textually without knowing about
  entries.
- Handlers switch to `io.emit(...)`:
  - `statusHandler` → **one** `{kind:"status"}` emit (was 3 `print`s). Keep the
    reachable/missing/error distinction (count try/catch, HTTP-404 branch).
  - `searchHandler` → `{kind:"search"}` on success w/ hits; zero-hits →
    `{kind:"message", text:"No relevant memory found."}`; failure →
    `{kind:"error", text:"error: search failed: …"}` (content keeps the
    `search failed:` reason; add the `error: ` lead).
  - `rememberHandler` ok → message `remembered (remember_tool): <verbatim>`; fail → error.
  - `clearHandler` ok → message `cleared: collection … reset`; fail → error `error: clear failed: …`.
  - `settingsHandler` write ok/declined messages as today (message kind);
    field-validation errors → error kind (keep the existing error strings so
    `unknown key` / `expects a number` substrings survive); bare-usage text →
    message kind.
  - `helpHandler` → `{kind:"help", rows:[…]}` (command names unchanged).
  - `runSettingsForm` prints → message/error kinds (same strings).
- **Prefix removal**: the only `/qdrant: ` composition is `buildIO` in
  `src/index.ts:73` (`api.sendMessage(\`/qdrant: ${t}\`)`). It disappears with
  the emit seam. `sendText` in the factory and the raw error catch in the
  `registerCommand` handler (~`src/index.ts:349`) are replaced by the entry
  path so thrown-handler errors become `{kind:"error"}` entries.

### 1.3 Real entry renderer — new module `src/entry-render.ts` (pi-tui land)

- Single registered custom type (`"qdrant-memory"`) as today; `appendEntry`
  payload becomes the `OutEntry` object instead of a string.
- The renderer is built once by a factory that **lazily imports** pi-tui
  (`Text`, and `Box` only if used for the card) and pi's `keyHint` from
  `@earendil-works/pi-coding-agent` (mirror pi-ketch's usage; keep the existing
  guarded lazy-import pattern so plain-node runs resolve nothing and the
  renderer returns `undefined` → pi skips the row).
- Renderer body: switch on `e.kind`; map each `renderOut` line's `role` to
  `theme.fg(role, line.text)` / `theme.bold(...)`; `error` entries → whole-line
  `theme.fg("error")`; `help` → title + aligned rows (`cmd.padEnd(20)` column,
  desc dimmed); `status` collapsed wraps the card lines in the bg Box (below);
  `search` collapsed appends the `(enter to expand)` hint via `keyHint`
  (fallback text "enter to expand").
- Status card bg: resolve one host bg token (e.g. the docs' `customMessageBg`)
  defensively — wrap in try/catch and fall back to plain (unboxed) lines on any
  failure. Never hard-code a color.
- Expansion: rely on pi's `{ expanded }` option to the renderer (docs
  `extensions.md` §registerEntryRenderer). VERIFY at implementation: the exact
  user gesture that toggles `expanded` for custom entries and the correct
  `keyHint` keybinding id (ketch uses `"app.tools.expand"`).

### 1.4 Span-color simplification (VERIFY at implementation)

pi-tui `Text` appears single-styled per component. If no horizontal
row-composition primitive exists to mix colors within one transcript line
(e.g. colored glyph + default text on the same status row), fall back to
**whole-line roles** — content unchanged, only color placement:
healthy status rows default with a plain `✓`; mode line bold; whole unhealthy
rows error/warning; the whole search meta line takes the type color. Do not
block on this; pick the fallback if the layout check takes more than a few
minutes.

## 2. Tasks (ordered; each ends green)

- **T1** `src/out.ts`: types + `renderOut` + text-join helper. No imports from
  pi or the network. [files: +`src/out.ts`]
- **T2** `test/out.test.ts`: unit tests for every kind, both collapse states —
  exact strings from DESIGN.md, glyphs, roles, verbatim text, blank-line
  separation, 200-char preview truncation + `…`, no-truncation-when-expanded,
  per-type role map, zero-hit message. [files: +`test/out.test.ts`]
- **T3** `src/handlers.ts` seam: swap `print`→`emit`, adapt `HandlerIO`/
  `depsToIO`; update every handler to emit typed entries per §1.2 (status → one
  card entry; search → one search entry; failures → error kind). Delete the
  `renderHits` import from handlers (now used by the search payload builder or
  `out.ts`). [files: `src/handlers.ts`, maybe `src/deps.ts` if `HandlerIO` moves]
- **T4** `test/handlers.test.ts`: fake io records `emit` payloads; update
  assertions to inspect the emitted entry (same content strings). Add: status
  emits exactly one entry with mode + reachable states + missing-collection
  variant; search failure emits error kind; zero-hits message single.
- **T5** `src/index.ts` wiring: remove the `/qdrant: ` prefix (`buildIO`),
  replace `sendText` + raw error catch with structured append; factory adapter
  `appendEntry(CUSTOM_TYPE, OutEntry)`; `registerEntryRenderer` delegates to
  the lazy `entry-render.ts` renderer. [files: `src/index.ts`]
- **T6** `test/index.test.ts` + `test/factory.test.ts`: update fakes (they
  currently record strings via `sendMessage`/`appendEntry(String(data))`).
  Fake renderers should project the `OutEntry` back to plain text with the
  `out.ts` helper so existing content-substring asserts survive; add an assert
  that status/search command invocations produce structured (non-string) data.
- **T7** `src/entry-render.ts`: lazy pi-tui + keyHint renderer per §1.3 with
  the §1.4 fallback decided. Untestable under plain node — verify manually in
  a live TUI session (smoke checklist in §4).
- **T8** README pass: confirm no output-example strings need updating (none
  found — command semantics only); update only if the pass finds output text.
- **T9** `npm run typecheck` clean + `npm test` fully green. Optional
  `QDRANT_MEMORY_SMOKE=1 npm run test:smoke` only if servers are up and
  ingest/search paths changed (they didn't — skip unless desired).
- **T10** DESIGN.md consistency re-read vs. implementation (labels, glyphs,
  role names), fix drift.

## 3. Verbatim/truncation rule (regression guard)

Text shown to the human is verbatim except: the collapsed search "top" preview
may truncate at 200 chars with `…` (today's `renderHits` logic — move it into
the collapsed-preview builder). Expanded content and every `remembered:` echo
are never truncated. `renderHits` itself stays for the tool path.

## 4. Live-TUI smoke checklist (after T7/T9)

1. `/qdrant-status` → one card, bg fill, `✓` rows; Enter → config detail; no
   `/qdrant: ` text anywhere; card degrades gracefully if bg missing.
2. `/qdrant-search x` with hits → one entry; collapsed `N results · top …`;
   Enter → full verbatim hits; per-type colors; a >200-char memory truncates
   only in the collapsed preview.
3. `/qdrant-search zzz` → plain `No relevant memory found.`
4. `/qdrant-remember …`/`/qdrant-clear`/`/qdrant-settings k v` → plain
   confirmations; bad key / bad value → red `error:` row; no crash.
5. `/qdrant-help` → aligned rows; command list intact.
6. Statusline still `🧠 Memory: …`; memory_save/search tool results unchanged.

## 5. Risks / VERIFY-at-implementation

1. **pi-tui layout**: Box constructor + child composition for the card;
   horizontal (span) coloring feasibility — see §1.4 fallback.
2. **Custom-entry expansion**: exact toggle gesture and `keyHint` keybinding id
   for custom (non-tool) entries; fallback hint text is fine if id differs.
3. **Host bg slot**: exact token name for the card fill; try/catch fallback to
   plain rows is mandatory.
4. **`keyHint` import** from `@earendil-works/pi-coding-agent` at extension
   runtime — pi-ketch proves it works; keep behind the lazy/guarded import and
   never call it on a path plain-node tests reach.
5. **Test fake churn** (T6) is the largest mechanical edit — do not weaken
   content assertions while switching fakes to structured payloads.

## 6. Commit shape (small, focused; typecheck+tests green before each)

1. `feat: typed slash-command output model + outlines (src/out.ts + tests)` (T1–T2)
2. `refactor: handlers emit typed entries; drop /qdrant: echo` (T3–T4, T5 prefix removal)
3. `ui: themed entry renderer — status card + expandable search` (T7, T5 renderer hookup)
4. `test: adapt index/factory fakes to structured entries` (T6)
5. `docs: DESIGN.md/decision log already updated; README pass` (T8, T10)
