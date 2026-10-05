---
name: Qdrant Memory
description: >-
  Visual & interaction identity for the pi-qdrant-memory extension inside the
  pi.dev host terminal. A calm, terminal-native surface with content-first
  chrome: expandable search results, a footer-style `🧠 Memory:` header on the
  status/help blocks, semantic host-theme color and glyphs, host-chrome dialogs
  for settings, and no command-echo text prefixes. All presentation (colors,
  type, radius, spacing) is deliberately delegated to the pi host theme.
omitted:
  - section: colors
    reason: "The host pi theme owns every color. This extension adds no palette: it references host semantic slots only (success/warning/error/accent/muted/dim) plus the 🧠 glyph of the shared memory header."
  - section: typography
    reason: "Host monospace only. The extension introduces no weights beyond theme.bold for two structural labels (status mode line, help title) and no sizes or cases."
  - section: rounded
    reason: "No shapes at all: every entry is unboxed transcript text; dialogs use host chrome."
  - section: spacing
    reason: "No layout tokens: output is a sequence of full-width transcript entries; spacing is the host chat layout and blank lines inside entries."
  - section: components
    reason: "Atoms carry no styling tokens. Their content and interaction contract lives in prose (Components section) so agents reproduce exact strings, labels, glyphs, and flows."
---

## Overview

**Qdrant Memory** is a pi extension that stores and recalls durable conversation
knowledge (decisions, facts, constraints, preferences, session summaries) as
embeddings in a per-project Qdrant collection. Its UI is *terminal-native and
calm*: it lives entirely inside the pi transcript and footer, renders nothing
unless the user asks or something breaks, and stays quiet during normal
operation.

The personality is **calm and precise with content-first chrome**. Output reads
fast, and every visual device — color, a glyph, expand-on-demand — exists to buy
at-a-glance scanning or to hide real detail, never as decoration. The extension
draws no borders, frames, rules, layouts, or background panels of its own. The
footer-style `🧠 Memory:` header (count-bearing on the statusbar) — the same
string the statusbar carries, minus its live point count — heads the
`/qdrant status` and `/qdrant help` blocks so
they read as branded panels. Output never echoes its own command path as a text
prefix: the invoking command line already sits above the block, and each entry
carries its own structural labels. The branded element is
the brain glyph `🧠`, used only as the memory header mark.

## Colors

The extension owns no color. Every color an agent needs is resolved by the
**pi host theme**; never hard-code a color, ANSI code, or emoji color inside this
extension's output. Richer output is expressed purely through the host's
semantic slots as exposed to entry renderers (`theme.fg` / `theme.bold`):

- **success** — the `✓` glyph and healthy lines in `/qdrant status`.
- **warning** — the `!` glyph, "collection does not exist yet", terminating-ish
  states.
- **error** — the `✗` glyph, "NOT reachable" lines, and every `error:` row.
- **accent / success / warning / dim / muted** — the per-memory-type tags in
  search results (`decision`→accent, `fact`→success, `constraint`→warning,
  `preference`→dim, `session_summary`→muted).
- **bold** — the `commands` title in `/qdrant help`. Nothing else is bold.

Glyphs are limited to `✓ ✗ !` (state carries meaning, color refines) and `…` for
truncation. The `🧠` glyph is the sole permitted emoji: it marks the memory
header, used in the footer statusline and as the first glyph of the
`/qdrant status` and `/qdrant help` block headers — never elsewhere.

## Typography

Delegated to the host: **monospace, single weight except the two bold labels
above, no decoration**. All text this extension emits is *content*, not chrome:

- No italic, underline, caps, or colorization invented by the extension beyond
  the semantic slots listed under Colors.
- Do not use markdown emphasis inside command output; entries render verbatim.
- Structural structure comes from **leading labels and prefixes** (see
  Components) which are plain text like `remembered:` and `settings:`.

## Layout

The extension produces three kinds of surface, all hosted by pi:

1. **Structured transcript entries** — one entry per logical unit of output
   (`appendEntry` + a registered entry renderer that switches on entry kind).
   Entries are visible in the TUI transcript and absent from the LLM context.
2. **Footer status** — a single statusline entry, format
   `🧠 Memory ({points}): <mode> (<collection>)`, resolved at session start and
   repainted after successful writes (see footer-status); the host owns
   footer teardown.
3. **Settings surface** — pi's own `SettingsList` screen in the TUI (a list,
   not dialogs), and host dialogs in RPC, always walked in the fixed order
   **pick → edit → confirm**. One field per invocation; never more than three
   dialogs per command.

Long values are truncated by the host at the terminal edge, never by the
extension choosing a width — except the explicit collapsed-preview ellipsis
(`…` at 200 chars) defined in the search component.

## Elevation & Depth

**Flat by design.** Visual hierarchy comes from lead-in labels, glyphs, and
collapse/expand:

- Each logical line begins with a stable label (`qdrant: `, `embeddings: `,
  `remembered: `, `cleared: `, `settings: `, `error: `, `commands`) so a reader
  can scan vertically.
- The `/qdrant status` and `/qdrant help` blocks open with the shared
  `🧠 Memory: <mode> (<collection>)` header — the footer-status string without
  its `({points})` segment.
- Search results are expandable entries: a collapsed summary line, with the full
  verbatim text behind the host's expand gesture (the `app.tools.expand`
  keybinding — `ctrl+o` by default, user-remappable).
- Do not add borders, box-drawing frames, horizontal rules, or background fills
  anywhere — every entry is unboxed text.

## Shapes

None. Every entry — `/qdrant status` included — is unboxed text rendered by the
host transcript. Dialogs use pi's built-in chrome. The extension never draws its
own boxes, dividers, borders, background fills, or highlight regions.

## Components

The atoms below are content-and-behavior contracts. Reproduce the exact strings,
glyphs, and flows; apply no styling beyond the slots named here.

### footer-status

The statusline entry shown while a session is active.

- Content: `🧠 Memory ({points}): {mode} ({collection})`.
- `{points}` is the number of memories currently stored in the project
  collection — total points, not a per-session delta. It is resolved from
  Qdrant on `session_start` (after any mode1 catch-up ingest) and repainted
  after every successful write or retraction (`memory_save`, `memory_forget`,
  `/qdrant remember`, `/qdrant forget`, the mode2 compaction capture) and after
  `/qdrant clear`. When the collection does not
  exist yet the count is `0`; when Qdrant is unreachable the header drops the
  `({points})` segment entirely — the statusline is best-effort and never
  blocks a tool result, command, or lifecycle handler.
- `mode` is the resolved runtime mode label: `mode1` (pi-blackhole present,
  ingest its artifacts) or `mode2` (own compaction capture). Re-resolved live
  on every repaint, so a `/qdrant settings mode` change is reflected without a
  restart (lifecycle hook wiring itself is fixed at session start).
- `collection` is the project collection id (`pi-mem-<16 hex>`).
- Set on `session_start`, never cleared mid-session by the extension — the host
  owns footer teardown. Best-effort — never throw if the footer is unavailable.
- The entry headers of `/qdrant status` and `/qdrant help` use the same string
  **without** the `({points})` segment (see status / commands below) — the
  status block already reports the point count on its own qdrant row.

### status (`/qdrant status`)

One entry, one plain always-visible text block — the same minimal shape as
`/qdrant help` and every message. No card, no background fill, no
collapse/expand, no `/qdrant: ` prefix anywhere. It opens with the shared
memory header (the footer-status string), then the subsystem rows, then config
detail in one label column:

```
🧠 Memory: mode2 (pi-mem-abc)
qdrant: ✓ reachable · 47 points
embeddings: ✓ reachable
code memory: ✓ 12 files · 89 symbols
qdrant url: http://localhost:6333
model: nomic-embed-text @ http://localhost:8080/v1
dimension: 768 · threshold: 0.15 · maxResults: 5 · code threshold: 0.55
project settings: codeKnowledge = on (global: off); codeScoreThreshold = 0.6 (global: 0.55)
```

The `code memory:` row appears only while the feature is wired (registration-time
`codeKnowledge: on`). When present, the `dimension:` line also reports `code threshold: <threshold>` showing the effective code-similarity cut. Variants: `code memory: off` (muted slot),
`code memory: on (syncing…)` (dim slot, before the first sync lands),
`code memory: ✓ {files} files · {symbols} symbols` (success slot, reporting total indexed collection inventory after a sync). `{symbols}` counts only points that carry a `symbol` — per-definition summaries. The per-file anchor points carry no symbol and are represented by the `files` count, never as symbols (#49).

The `project settings:` row sits in the config-detail block (after `dimension:`,
with `qdrant url:` / `model:`) and is emitted only when this project has ≥ 1
allowlisted override — quiet by default, matching the design ethos. One line,
`; `-joined; each entry is `<key> = <value> (global: <g>)`, the value in its
stored JSON form (`String(v)` for numbers, never `toFixed`, so the displayed
value equals the stored one). Variants: enum-only
(`project settings: codeKnowledge = on (global: off)`), numeric-only
(`project settings: codeScoreThreshold = 0.6 (global: 0.55)`), or both keys. It is
load-bearing in the off-direction: when an override turns `codeKnowledge` off
while the global is on, the `code memory:` row is **absent** (feature not wired)
and this row is the only place that explains why. A `codeScoreThreshold`-only
override gates nothing and is surfaced for explainability (naming the bar the
results were cut at). No row appears when the store is empty.

State variants on the subsystem rows — the glyph carries the class, the color
refines it:

- healthy: `✓` in the success slot.
- `✗ NOT reachable` — error slot (subsystem down/unreachable).
- `! collection pi-mem-… does not exist yet` — warning slot (fresh project or
  after `/qdrant clear`).
- `mode: ! own while pi-blackhole is installed — …` — warning slot, present only
  when `mode = own` is configured while pi-blackhole is operational (#50): both
  extensions claim `session_before_compact`, and a pi-blackhole cancellation
  means no mode-2 capture. The row sits directly under the header.

Never display API keys or imply their presence. Status shows the same rows
whether or not the host marks the entry expanded — nothing is hidden behind a
gesture.

### commands (`/qdrant help`)

One entry, the same minimal block shape. Opens with the shared memory header,
then a bold `commands` title and aligned rows — command in plain text,
description dim, column aligned to the longest command + 2. The row list is
conditional: `/qdrant index code` appears (between `/qdrant clear all | code` and
`/qdrant help`) only while `codeKnowledge: on` was active at registration. The
bare `/qdrant` emits this block right after the status block, so the bare form
is self-documenting in every mode.

```
🧠 Memory: mode1 (pi-mem-<hex>)
commands
/qdrant status                         connection health + active mode + collection status
/qdrant settings [key] [value]         open the settings screen, or persist a config field — codeKnowledge/codeScoreThreshold apply to this project, other keys are global
/qdrant remember <text>                save durable knowledge now
/qdrant search <query>                 semantic search of durable knowledge
/qdrant forget <query>                 search and remove memories interactively
/qdrant clear all | code               reset entire collection (all) or purge code summaries (code)
/qdrant index code                     re-index code summaries now
/qdrant help                           this list
```

### command grammar (`/qdrant <key>`)

One registered command; the first token after it is the key. `src/commands.ts`
owns the grammar (`ARG_SHAPE`) and the command registry, `src/command-run.ts` is
the only place a key is routed, and `src/out.ts` owns every string below.

| Key | Shape | Behaviour |
|---|---|---|
| `status`, `help` | no arguments | one block each; extra tokens get a correction |
| `search`, `remember`, `forget` | free text | the remainder is passed **verbatim** — never re-tokenised |
| `settings` | one bounded key token, then free text | the value is the rest of the line, so URLs and model names keep their punctuation; the key token is validated by the shared `setConfigField` |
| `clear` | exactly one of `all` or `code` | |
| `index` | exactly one registered kind (`code`) | the kind's own usage line when missing; the gate per kind, then the sync |

Parse failures are **one error entry each**, never a throw and never a silent
no-op. Nothing is guessed — each message names the accepted values or the
corrected command, and the unknown-key case ends in the shared usage line:

```text
error: unknown key "bogus thing"
usage: /qdrant <key> — status | settings | remember | search | forget | clear | index | help

error: /qdrant status takes no arguments — try /qdrant status
error: unknown index value "documents" — accepted: code
       usage: /qdrant <key> — …
error: unexpected arguments — try /qdrant index code
```

Argument completion is two-level: the keys for an empty prefix, then the bounded
second token (`all`/`code`, the registered index kinds, the twelve settings
fields). It returns nothing beyond that token — the value is free text — and a
prefix matching no key shows no menu.

### search-results (`/qdrant search`)

One entry per query. **Collapsed** (default) is a single summary line ending in
a preview of the top hit's text:

```
2 results · top [constraint] 0.91 · Score thresholds are shared…   (ctrl+o to expand)
```

- The per-type tag on the "top" hit is colored per the Colors map; count and
  score are plain/dim.
- The preview shows the top hit's text — default-colored and unadorned
  (verbatim invariant) — truncated at 200 chars with `…` when longer, on a
  grapheme-safe cut (a multi-codepoint emoji or combining sequence is never
  split). This is the one truncation the extension ever does; expanding never
  truncates.
- Only expandable when hits exist (the preview hides the rest of every hit, so
  the hint is legitimate). The hint is the host's own `keyHint("app.tools.expand",
  "to expand")` — dim key + muted description, coloured by the host, wrapped in
  plain parentheses. When the host package has not resolved (plain-node runs)
  the hint is omitted entirely: an invented key name is worse than no hint.

**Expanded** renders every hit, verbatim and never truncated:

```
[decision] 0.92 (source_entry_id=…)
<full text, verbatim>

[fact] 0.87 (session_id=…)
<full text, verbatim>
```

- Type tag colored per the map; `score` and source pointer plain/dim; the memory
  text itself always default-colored and unadorned (verbatim invariant).
- Blank line between hits; no rules, no frames.
- Zero hits: one plain, non-expandable line `No relevant memory found.` — no
  icon.
- Failure: an `error:` row (below).

### message (confirmations)

One plain one-line entry each — `/qdrant remember`, `/qdrant clear all`,
`/qdrant clear code`, and `/qdrant settings` writes/declines. No icons, no color
beyond default text (the leading label may be dimmed):

```
remembered: <verbatim text>
already saved: <verbatim text>
cleared: collection pi-mem-… reset
cleared: 14 code memory points removed
clear: no code points indexed
forgotten: <n> memories removed
forget: no memories matched "<query>"
forget: unchanged (cancelled)
settings: qdrantUrl updated (global config; reloaded at runtime)
settings: scoreThreshold unchanged (cancelled)
code memory: takes effect at the next session start — the code_memory tool registers on reload. Run /qdrant index code to index the current session's code right away.
```

Bare `/qdrant clear` prints usage guidance (as does an unrecognized modifier,
which never clears):

```
clear: usage — /qdrant clear all | code
       all  — reset the current project's entire memory collection (irreversible)
       code — remove all indexed code summaries for this project
```

`/qdrant clear all` is destructive, so it **cannot delete anything without a
confirmation** — and it says so when it cannot ask:

- With a dialog-capable UI and a non-empty collection: a host confirm dialog,
  title `Reset <collection> and delete all <count> stored memories?` (the
  exact count; `memory` at one), body `Deletes every memory and code summary
  for this project from Qdrant. This cannot be undone.` Accept runs the reset
  and then the existing `cleared: collection pi-mem-… reset` entry; declining
  emits `clear: unchanged (cancelled)`. The default action is cancel (Esc/No);
  nothing auto-dismisses into a commit.
- Empty (or absent) collection: `clear: collection pi-mem-… is already empty`
  and it **stops** — no dialog is ever opened when there is nothing to act on.
- No dialog-capable UI: `error: /qdrant clear all requires interactive UI
  confirmation` — a destructive wipe is never attempted blind (mirrors the
  forget refusal).
- `code` is unchanged: far less destructive, no confirmation, and `clear: no
  code points indexed` already handles the empty case.

Bare `/qdrant index` prints its own usage line plus one line per registered kind,
generated from the kind registry:

```
index: usage — /qdrant index <kind>
       code — Re-index code summaries now
```

Bare `/qdrant settings` (no key/value) prints one multi-line usage message naming
the scope rule and **both** absolute file paths (from `projectSettingsPath` /
`configPath`, never hand-built):

```
settings: usage — /qdrant settings opens the settings screen; /qdrant settings <key> <value> sets a field.
          codeKnowledge and codeScoreThreshold are per project (<projectSettingsPath>);
          the other keys are global (<configPath>).
          this project: codeKnowledge = off (inherited from global); codeScoreThreshold = 0.6 (this project; global: 0.55)
```

The two allowlisted keys (`codeKnowledge`, `codeScoreThreshold`) are the only ones
that write this project's store; the ten other keys keep writing the global
config file. A set against an allowlisted key confirms both layers —
`settings: codeKnowledge = on (this project; global: off)` or `settings:
codeScoreThreshold = 0.6 (this project; global: 0.55)` — and a clear reads
`settings: <key> override cleared (now using global: <g>)` (e.g. `settings:
codeKnowledge override cleared (now using global: off)`). The ten
non-allowlisted keys keep the single-layer clause `settings: <key> updated
(global config; reloaded at runtime)`.

A `codeKnowledge` settings write additionally emits the direction-aware reload
notice (spec §12): switching **on** ends `…the code_memory tool registers on
reload. Run /qdrant index code to index the current session's code right away.`;
switching **off** ends `…the code_memory tool unregisters on reload.`

Writing `mode = own` while pi-blackhole is operational additionally emits one
warning entry — from both the CLI write and the settings form:

```
warning: mode = own while pi-blackhole is installed — both extensions claim session_before_compact; if pi-blackhole cancels compaction, no mode-2 capture happens. mode = auto (or removing pi-blackhole) avoids the conflict.
```

The `/qdrant remember` confirmation is command voice: plain `remembered:`
without echoing the stored point's internal source kind (the memory_save tool
return is the one surface that names it — see agent-tool-results).

### migration-notice

A one-shot session-start entry announcing the `/qdrant-*` → `/qdrant <key>`
rename. It is a `message` entry — nothing failed — and the copy is what the
rule literally does:

```
commands: /qdrant-* is now /qdrant <key> — e.g. /qdrant status, /qdrant search <query>.
          Run /qdrant help for the full list. Shown each session until your first /qdrant command.
```

Two lines, because the entry renderer does not wrap prose and the host
truncates at the terminal edge. Shown on `session_start` until the first
**successful** `/qdrant` dispatch of the session — a failed dispatch (unknown
key, bad arguments) does not set the flag, because that user has
demonstrably not migrated — then never again. The flag lives in
`<agentDir>/pi-qdrant-memory/state.json` (honors `PI_CODING_AGENT_DIR`, same
directory and `0600` discipline as the config, tolerant read: corrupt or
absent means "not shown yet", never a throw). Never emitted in `json`/`print`
sessions (there is no transcript to show it in), never written in headless
sessions (a command cannot be invoked there), and never blocks or throws on
`session_start`.

The `/qdrant forget` confirmation is never a bare count: the dialog message
lists every memory a Yes deletes — one line per hit, `[<type>] <score> —
"<60-char one-line preview>"` — and the search entry above it shows the same
deletion set verbatim. At most five hits are deleted per confirmation; when
further matches exist above the threshold the dialog appends `Only these <n>
closest matches are deleted; other matches above the threshold are left
untouched.` and those matches are neither listed nor touched.

### error

One entry, whole row in the host error slot, text as data:

```
error: <message>
```

Rendered from command failures (including a thrown handler) and from
`/qdrant search`/`/qdrant remember` failures. It is data, not a dialog or a
crash — commands always exit normally with the error as content.

### settings-screen (TUI)

Bare `/qdrant settings` in the interactive TUI mounts pi's own `SettingsList`
modal (the same primitive pi's built-in `/settings` uses) instead of any dialog
sequence — decided from the **live** command ctx, never a cached probe:

| Mode | Surface |
|---|---|
| `ctx.mode === "tui"` (and the host bridge resolved) | the `SettingsList` screen |
| `ctx.hasUI` (RPC, dialog trio available) | the pick → edit → confirm form below |
| otherwise (print/headless, or no dialogs) | the usage message |

The modal is gated on `mode`, not `hasUI`: `ctx.ui.custom` is a silent no-op
under RPC, so mounting there would open nothing and the command would look
dead. If the host bridge has not resolved (plain node, old host) the screen is
unreachable and the form/usage fallbacks take over.

What the screen shows — one row per editable key, in the stable
`SETTING_FIELDS` order (twelve fields):

- **label** is the key, **currentValue** is the **effective** value (env →
  project override → global), so the row shows what is in force, not one
  layer.
- **enum fields** (`mode`, `memoryForget`, `codeKnowledge`) carry a `values`
  list — Enter cycles through them; `codeKnowledge`'s third value is
  `default (inherit global: <g>)`, the clear-override entry, normalised back to
  the reserved `default` token on write.
- **other fields** (numbers, URL/model, secrets) open a one-line value submenu:
  a dim prompt line `<prompt> — current: <value>` above pi-tui's own `Input`,
  confirm/cancel matched through the injected `keybindings` object. The input
  starts **empty** — the current value is shown on the prompt line, never
  prefilled.
- **secrets** (`qdrantApiKey`, `confirm`/`embeddingApiKey` — never the value,
  on any surface): the row shows `set` or `not set`, the prompt reads
  `<key> (clear to remove)`, and an empty committed value clears the key (the
  write path turns it into `null`). The description says `Stored in the global
  config file, never displayed.` Even after a write the row is re-shown as
  `set`/`not set`, because the host copies the typed value into the row before
  the extension gets a say.
- **descriptions** carry scope and rule (`Global. 0–1.`, `Per project. Global:
  off. Takes effect at the next session start.`) and, when an env var masks the
  field, the same env-mask note the confirmations use.
- The list is framed by the host's `DynamicBorder` (as pi's own settings
  overlay does) and closes with a one-line key hint — `<confirm> to change ·
  <cancel> to close`, labelled by the host's own `keyText`. The hint line is
  omitted entirely when `keyText` has not resolved.

Feedback and safety — every change goes through the **same** `setConfigField`
validator and the **same** routing rule as `/qdrant settings <key> <value>`
(allowlisted keys → this project's store, the rest → the global config file),
so the two surfaces cannot diverge:

- **Successful write** → the existing confirmation entries (`settings: <key> =
  <new> (this project; global: <g>)` / `settings: <key> updated (global config;
  reloaded at runtime)` / `settings: <key> override cleared (now using global:
  <g>)`), plus the direction-aware `codeKnowledge` reload notice when the
  effective value actually changed, plus the pi-blackhole conflict warning when
  `mode = own` is set while pi-blackhole is operational.
- **Rejected value** → an `error:` entry **and** the row is rolled back to the
  previous displayed value (mandatory: the host mutates the row before calling
  the extension, so without the rollback the list would display a value that
  was never persisted).
- **Esc anywhere** → the modal closes and emits `settings: unchanged
  (cancelled)` — no silent exit. Feedback entries go out while the modal is up
  and land in the transcript when it closes.

### settings-form (RPC)

Interactive config editing for RPC sessions. Reached from the `/qdrant
settings` command with no arguments when `ctx.hasUI` dialogs exist but the mode
is not `tui` — rpc sets `ctx.hasUI = true` and translates `select`/
`input`/`confirm` into `extension_ui_request`/`extension_ui_response`. Print/
headless contexts without the dialog trio fall back to the usage message.
`/qdrant settings <key> <value>` bypasses the UI entirely. The form displays
the **effective** value (this project's override, else the global value) and
the pick labels also name the layer, so the destination is never ambiguous.

Fixed flow, Esc cancels at any step:

1. **pick** — a select dialog titled `Qdrant Memory — choose a setting to edit`,
   options formatted `<key> = <current value>` plus a scope annotation:
   `codeKnowledge = on (this project; global: off)` for an overridden allowlisted
   key, `qdrantUrl = http://localhost:6333 (global)` when the global layer is the
   one in effect.
2. **edit** — type-aware: `mode` → nested select over `auto | blackhole | own`;
   `memoryForget` → nested select over `off | on`;
   `codeKnowledge` → nested select over `off | on | default (inherit global:
   <g>)`; numeric allowlisted fields → text input titled `<key> (number;
   "default" inherits global: <g>)`; other numeric fields → text input titled
   `<key> (number)` / `<key> (positive number)`; string/null fields → text input,
   in each case with the current value as placeholder.
3. **confirm** — `Save <key>?` with a destination-naming message. Allowlisted
   keys: `<key> = <new> → this project's settings file (global: <g>) (was <old>;
   run /qdrant settings again to edit another field)`. The other keys:
   `<key> = <new> → the global config file (was <old>; run /qdrant settings again
   to edit another field)`.

Reset-to-inherited exists **only** for the two allowlisted fields: the enum
select's `default (inherit global: <g>)` option and a typed `default` at the
numeric prompt both clear this project's override (confirm title `Clear the
project override?`, message `<key> returns to the global value (<g>)`); the
non-allowlisted fields expose **no** clear affordance.

Rules: an empty input cancels that step; invalid values print the same error a
CLI write would and do **not** reach confirm; declining confirm prints
`settings: <key> unchanged (cancelled)`; a successful allowlisted write prints
`settings: <key> = <new> (this project; global: <g>)`, a successful global write
prints `settings: <key> updated (global config; reloaded at runtime)`. Host
chrome owns all dialog visuals.

### agent-tool-results

`memory_save`, `memory_search`, `code_memory`, and `memory_forget` return plain text to the model:
`remembered (remember_tool): <text>`, `already saved: <text>`, `forgotten: <text>`, or `<tool> failed: <reason>` on errors
(`<reason>` is a **bare** reason — the tool name and `failed:` lead appear exactly
once), and for searches the hit-block format:
```
[fact] score=0.84 (2026-09-18T14:20:00.000Z) (source_entry_id=abc)
<full text, verbatim without truncation>
```
Code-memory hits carry a `file:line` source pointer (`[code] score=0.81 (2026-09-18T14:20:00.000Z) (src/render.ts:15)`);
file-level summaries with no line carry the bare path (`[code] score=0.64 (2026-09-18T14:20:00.000Z) (src/qdrant.ts)`) — either
way the model can open the file; `code_memory` covers structure only — its
guidelines pair it with `memory_search` for rationale.

When 0 hits match, `memory_search` distinguishes store state:
`No memories stored yet for this project.` when total count is 0, or
`No memories matched query above scoreThreshold (total stored: <count>).` when memories exist but did not clear the threshold.

These strings feed the LLM (not the human TUI) and are
deliberately **not** chrome-styled; they are out of scope of the entry UI above. The
human-visible search formatting lives in the `search-results` entry, not in tool return
text.

Idempotent-write contract for `memory_save`: the stored point id is derived
from the text (plus source kind and context), **not** from `type`. Re-saving
the same text with a different type upserts over the earlier point instead of
duplicating it.

## Do's and Don'ts

- Do render command output as structured entries (`appendEntry` + entry
  renderer switching on kind), never `sendMessage` — the latter's `display` flag
  gates only rendering, so its content still reaches the LLM context.
- Do attribute output with **structural labels** (`qdrant:`, `embeddings:`,
  `remembered:`, `cleared:`, `settings:`, `error:`, …). Do **not** echo
  `/qdrant: ` or any command-path text prefix — the invoking command line is
  already above.
- Do keep knowledge text **verbatim and unadorned** in every human surface;
  truncate with `…` only in collapsed previews, never when expanded. The
  knowledge is the product.
- Do resolve every color/glyph through the host theme's semantic slots (the
  Colors list); never invent a palette, ANSI code, or emoji color. The 🧠 glyph
  belongs to the footer statusline and the `/qdrant status` / `/qdrant help` block
  headers only.
- Do draw no self-chrome at all: no borders, frames, rules, panels, or
  background fills anywhere, ever. Entries are unboxed text.
- Do use glyphs `✓ ✗ !` to carry state and color to refine; do not put icons on
  confirmations.
- Do make entries expandable only when collapse genuinely hides content (search
  results only) and show a keybinding hint only then. No animation/motion
  anywhere.
- Do surface failures as `error:` rows; never throw into the host, never open a
  dialog from a lifecycle hook, never block a session.
- Do let the settings form be fully Esc-cancellable and confirm writes before
  persisting.
- Don't style or decorate search/remembered content itself; keep it verbatim.
- Don't echo stored points' internal source kinds to humans (`remembered:
  <text>`, never `remembered (remember_tool):`); the memory_save tool return is
  the one surface that names it (agent-tool-results).
