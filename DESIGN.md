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
`/qdrant-status` and `/qdrant-help` blocks so
they read as branded panels. Output never echoes its own command path
(`/qdrant-*`) as a text prefix: the invoking command line already sits above the
block, and each entry carries its own structural labels. The branded element is
the brain glyph `🧠`, used only as the memory header mark.

## Colors

The extension owns no color. Every color an agent needs is resolved by the
**pi host theme**; never hard-code a color, ANSI code, or emoji color inside this
extension's output. Richer output is expressed purely through the host's
semantic slots as exposed to entry renderers (`theme.fg` / `theme.bold`):

- **success** — the `✓` glyph and healthy lines in `/qdrant-status`.
- **warning** — the `!` glyph, "collection does not exist yet", terminating-ish
  states.
- **error** — the `✗` glyph, "NOT reachable" lines, and every `error:` row.
- **accent / success / warning / dim / muted** — the per-memory-type tags in
  search results (`decision`→accent, `fact`→success, `constraint`→warning,
  `preference`→dim, `session_summary`→muted).
- **bold** — the `commands` title in `/qdrant-help`. Nothing else is bold.

Glyphs are limited to `✓ ✗ !` (state carries meaning, color refines) and `…` for
truncation. The `🧠` glyph is the sole permitted emoji: it marks the memory
header, used in the footer statusline and as the first glyph of the
`/qdrant-status` and `/qdrant-help` block headers — never elsewhere.

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
3. **Settings form** — host dialogs, always walked in the fixed order
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
- The `/qdrant-status` and `/qdrant-help` blocks open with the shared
  `🧠 Memory: <mode> (<collection>)` header — the footer-status string without
  its `({points})` segment.
- Search results are expandable entries: a collapsed summary line, with the full
  verbatim text behind an Enter-to-expand gesture.
- Do not add borders, box-drawing frames, horizontal rules, or background fills
  anywhere — every entry is unboxed text.

## Shapes

None. Every entry — `/qdrant-status` included — is unboxed text rendered by the
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
  after every successful write (`memory_save`, `/qdrant-remember`, the mode2
  compaction capture) and after `/qdrant-clear`. When the collection does not
  exist yet the count is `0`; when Qdrant is unreachable the header drops the
  `({points})` segment entirely — the statusline is best-effort and never
  blocks a tool result, command, or lifecycle handler.
- `mode` is the resolved runtime mode label: `mode1` (pi-blackhole present,
  ingest its artifacts) or `mode2` (own compaction capture). Re-resolved live
  on every repaint, so a `/qdrant-settings mode` change is reflected without a
  restart (lifecycle hook wiring itself is fixed at session start).
- `collection` is the project collection id (`pi-mem-<16 hex>`).
- Set on `session_start`, never cleared mid-session by the extension — the host
  owns footer teardown. Best-effort — never throw if the footer is unavailable.
- The entry headers of `/qdrant-status` and `/qdrant-help` use the same string
  **without** the `({points})` segment (see status / commands below) — the
  status block already reports the point count on its own qdrant row.

### status (`/qdrant-status`)

One entry, one plain always-visible text block — the same minimal shape as
`/qdrant-help` and every message. No card, no background fill, no
collapse/expand, no `/qdrant: ` prefix anywhere. It opens with the shared
memory header (the footer-status string), then the subsystem rows, then config
detail in one label column:

```
🧠 Memory: mode2 (pi-mem-abc)
qdrant: ✓ reachable · 47 points
embeddings: ✓ reachable
qdrant url: http://localhost:6333
model: nomic-embed-text @ http://localhost:8080/v1
dimension: 768 · threshold: 0.15 · maxResults: 5
```

State variants on the subsystem rows — the glyph carries the class, the color
refines it:

- healthy: `✓` in the success slot.
- `✗ NOT reachable` — error slot (subsystem down/unreachable).
- `! collection pi-mem-… does not exist yet` — warning slot (fresh project or
  after `/qdrant-clear`).

Never display API keys or imply their presence. Status shows the same rows
whether or not the host marks the entry expanded — nothing is hidden behind a
gesture.

### commands (`/qdrant-help`)

One entry, the same minimal block shape. Opens with the shared memory header,
then a bold `commands` title and aligned rows — command in plain text,
description dim, column aligned to the longest command + 2:

```
🧠 Memory: mode1 (pi-mem-<hex>)
commands
/qdrant-status    connection health + active mode + collection status
```

### search-results (`/qdrant-search`)

One entry per query. **Collapsed** (default) is a single summary line ending in
a preview of the top hit's text:

```
2 results · top [constraint] 0.91 · Score thresholds are shared…   (enter to expand)
```

- The per-type tag on the "top" hit is colored per the Colors map; count and
  score are plain/dim.
- The preview shows the top hit's text — default-colored and unadorned
  (verbatim invariant) — truncated at 200 chars with `…` when longer. This is
  the one truncation the extension ever does; expanding never truncates.
- Only expandable when hits exist (the preview hides the rest of every hit, so
  the hint is legitimate).

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

One plain one-line entry each — `/qdrant-remember`, `/qdrant-clear`, and
`/qdrant-settings` writes/declines. No icons, no color beyond default text (the
leading label may be dimmed):

```
remembered: <verbatim text>
cleared: collection pi-mem-… reset
settings: scoreThreshold updated (reloaded at runtime)
settings: scoreThreshold unchanged (cancelled)
```

The `/qdrant-remember` confirmation is command voice: plain `remembered:`
without echoing the stored point's internal source kind (the memory_save tool
return is the one surface that names it — see agent-tool-results).

### error

One entry, whole row in the host error slot, text as data:

```
error: <message>
```

Rendered from command failures (including a thrown handler) and from
`/qdrant-search`/`/qdrant-remember` failures. It is data, not a dialog or a
crash — commands always exit normally with the error as content.

### settings-form

Interactive config editing. Only reachable from the `/qdrant-settings` command
with no arguments, and only when `ctx.ui` dialogs exist (interactive TUI).
`/qdrant-settings <key> <value>` bypasses the UI entirely.

Fixed flow, Esc cancels at any step:

1. **pick** — a select dialog titled `Qdrant Memory — choose a setting to edit`,
   options formatted `<key> = <current value>` (e.g. `mode = auto`,
   `scoreThreshold = 0.15`).
2. **edit** — type-aware: `mode` → nested select over `auto | blackhole | own`;
   numeric fields → text input titled `<key> (number)` / `<key> (positive
   number)` with the current value as placeholder; string/null fields → text
   input with the current value as placeholder.
3. **confirm** — `Save <key>?` with message `<key> = <new> (was <old>; run
   /qdrant-settings again to edit another field)`.

Rules: an empty input cancels that step; invalid values print the same error a
CLI write would and do **not** reach confirm; declining confirm prints
`settings: <key> unchanged (cancelled)`; a successful write prints
`settings: <key> updated (reloaded at runtime)`. Host chrome owns all dialog
visuals.

### agent-tool-results

`memory_save` and `memory_search` return plain text to the model: `remembered
(remember_tool): <text>` or `memory_search failed: <reason>` on errors, and for
searches the same plain hit-block format as today. These strings feed the LLM
(not the human TUI) and are deliberately **not** chrome-styled; they are out of
scope of the entry UI above. The human-visible search formatting lives in the
`search-results` entry, not in tool return text.

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
  belongs to the footer statusline only.
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
