---
name: Qdrant Memory
description: >-
  Visual & interaction identity for the pi-qdrant-memory extension inside the
  pi.dev host terminal. A calm, terminal-native surface with content-first
  chrome: one themed status card, expandable search results, semantic host-theme
  color and glyphs, host-chrome dialogs for settings, and no command-echo text
  prefixes. All presentation (colors, type, radius, spacing) is deliberately
  delegated to the pi host theme.
omitted:
  - section: colors
    reason: "The host pi theme owns every color. This extension adds no palette: it references host semantic slots only (success/warning/error/accent/muted/dim + one bg slot for the status card) plus the footer 🧠 glyph."
  - section: typography
    reason: "Host monospace only. The extension introduces no weights beyond theme.bold for two structural labels (status mode line, help title) and no sizes or cases."
  - section: rounded
    reason: "No custom shapes beyond the single status card, whose corners are the host's own; dialogs use host chrome."
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
fast, and every visual device — color, a glyph, the single status card,
expand-on-demand — exists to buy at-a-glance scanning or to hide real detail,
never as decoration. The extension draws no borders, frames, rules, or layouts
of its own; the only "panel" anywhere is the one background card in
`/qdrant-status`. Output never echoes its own command path (`/qdrant-*`) as a
text prefix: the invoking command line already sits above the block, and each
entry carries its own structural labels. The branded element is the brain glyph
`🧠`, used only as the statusline mark.

## Colors

The extension owns no color. Every color an agent needs is resolved by the
**pi host theme**; never hard-code a color, ANSI code, or emoji color inside this
extension's output. Richer output is expressed purely through the host's
semantic slots as exposed to entry renderers (`theme.fg` / `theme.bold`):

- **success** — the `✓` glyph and healthy lines in the status card.
- **warning** — the `!` glyph, "collection does not exist yet", terminating-ish
  states.
- **error** — the `✗` glyph, "NOT reachable" lines, and every `error:` row.
- **accent / success / warning / dim / muted** — the per-memory-type tags in
  search results (`decision`→accent, `fact`→success, `constraint`→warning,
  `preference`→dim, `session_summary`→muted).
- **bold** — the status card's mode label and the help title. Nothing else is
  bold.
- **one background slot** — the status card's fill, resolved from the host theme
  (slot name verified at implementation; if no slot resolves, the card degrades
  to plain rows — never a crash, never a hard-coded color).

Glyphs are limited to `✓ ✗ !` (state carries meaning, color refines) and `…` for
truncation. The `🧠` glyph is the sole permitted emoji and only in the footer
statusline — never inline in output.

## Typography

Delegated to the host: **monospace, single weight except the two bold labels
above, no decoration**. All text this extension emits is *content*, not chrome:

- No italic, underline, caps, or colorization invented by the extension beyond
  the semantic slots listed under Colors.
- Do not use markdown emphasis inside command output; entries render verbatim.
- Structural structure comes from **leading labels and prefixes** (see
  Components) which are plain text like `remembered:` and `mode:`.

## Layout

The extension produces three kinds of surface, all hosted by pi:

1. **Structured transcript entries** — one entry per logical unit of output
   (`appendEntry` + a registered entry renderer that switches on entry kind).
   Entries are visible in the TUI transcript and absent from the LLM context.
2. **Footer status** — a single statusline entry, format
   `🧠 Memory: <mode> (<collection>)`, set once at session start; the host owns
   footer teardown.
3. **Settings form** — host dialogs, always walked in the fixed order
   **pick → edit → confirm**. One field per invocation; never more than three
   dialogs per command.

Long values are truncated by the host at the terminal edge, never by the
extension choosing a width — except the explicit collapsed-preview ellipsis
(`…` at 200 chars) defined in the search component.

## Elevation & Depth

**Flat by design, with one depth cue.** Visual hierarchy comes from lead-in
labels, glyphs, collapse/expand, and — once per `/qdrant-status` — the card's
background fill:

- Each logical line begins with a stable label (`mode: `, `qdrant: `,
  `embeddings: `, `remembered: `, `cleared: `, `settings: `, `error: `,
  `commands`) so a reader can scan vertically.
- Search results are expandable entries: a collapsed summary line, with the full
  verbatim text behind an Enter-to-expand gesture.
- Do not add borders, box-drawing frames, horizontal rules, or background fills
  except the one status card.

## Shapes

One shape only: the **status card** — a background-filled block in
`/qdrant-status`, using the host theme's bg slot and corner radius. Everything
else is unboxed text inside entries. Dialogs use pi's built-in chrome. The
extension never draws its own boxes, dividers, borders, or highlight regions
beyond that single card.

## Components

The atoms below are content-and-behavior contracts. Reproduce the exact strings,
glyphs, and flows; apply no styling beyond the slots named here.

### footer-status

The statusline entry shown while a session is active.

- Content: `🧠 Memory: {mode} ({collection})`.
- `mode` is the resolved runtime mode label: `mode1` (pi-blackhole present,
  ingest its artifacts) or `mode2` (own compaction capture).
- `collection` is the project collection id (`pi-mem-<16 hex>`).
- Set on `session_start`, never cleared mid-session by the extension — the host
  owns footer teardown. Best-effort — never throw if the footer is unavailable.

### status-card (`/qdrant-status`)

One entry. **Collapsed** (default): a compact background card whose rows share a
label column (label styled `bold` for the mode line, plain elsewhere; value in
default text). No `/qdrant: ` prefix anywhere.

```
memory: mode1
qdrant: ✓ reachable · 47 points
embeddings: ✓ reachable
```

State variants on the subsystem rows — the glyph carries the class, the color
refines it:

- healthy: `✓` in the success slot.
- `✗ NOT reachable` — error slot (subsystem down/unreachable).
- `! collection pi-mem-… does not exist yet` — warning slot (fresh project or
  after `/qdrant-clear`).

**Expanded** (Enter; the entry shows one `keyHint` "to expand" while collapsed
because the detail below is genuinely hidden) appends config detail rows in the
same label column, no background emphasis beyond the card already present:

```
collection: pi-mem-<hex>
qdrant url: http://localhost:6333
model: nomic-embed-text-v1.5 @ http://localhost:8081/v1
dimension: 768 · threshold: 0.15 · maxResults: 5
```

Never display API keys or imply their presence. If the host bg slot does not
resolve at runtime, render the same rows as plain text — never throw.

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

## Do's and Don'ts

- Do render command output as structured entries (`appendEntry` + entry
  renderer switching on kind), never `sendMessage` — the latter's `display` flag
  gates only rendering, so its content still reaches the LLM context.
- Do attribute output with **structural labels** (`mode:`, `qdrant:`,
  `remembered:`, `settings:`, `error:`, …). Do **not** echo `/qdrant: ` or any
  command-path text prefix — the invoking command line is already above.
- Do keep knowledge text **verbatim and unadorned** in every human surface;
  truncate with `…` only in collapsed previews, never when expanded. The
  knowledge is the product.
- Do resolve every color/glyph through the host theme's semantic slots (the
  Colors list); never invent a palette, ANSI code, or emoji color. The 🧠 glyph
  belongs to the footer statusline only.
- Do limit self-drawn chrome to the **one** status card and its bg slot; no
  borders, frames, rules, or extra panels anywhere, ever.
- Do use glyphs `✓ ✗ !` to carry state and color to refine; do not put icons on
  confirmations.
- Do make entries expandable only when collapse genuinely hides content, and
  show a keybinding hint only then. No animation/motion anywhere.
- Do surface failures as `error:` rows; never throw into the host, never open a
  dialog from a lifecycle hook, never block a session.
- Do let the settings form be fully Esc-cancellable and confirm writes before
  persisting.
- Don't style or decorate search/remembered content itself; keep it verbatim.
- Don't draw the status card's bg from anything but a host theme token, and
  degrade gracefully (plain rows) if none resolves.
