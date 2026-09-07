---
name: Qdrant Memory
description: >-
  Visual & interaction identity for the pi-qdrant-memory extension inside the
  pi.dev host terminal. A quiet, plain-text, terminal-native surface: one brain
  glyph in the footer, "/qdrant: " prefixed command-output rows, and host-chrome
  dialogs for settings. All presentation (colors, type, radius, spacing) is
  deliberately delegated to the pi host theme.
omitted:
  - section: colors
    reason: "The host pi theme owns every color. This extension adds no palette: it only references host semantics (default text, error) and one emoji glyph (🧠)."
  - section: typography
    reason: "Host monospace only. All extension output is plain text — no weights, sizes, or cases are introduced."
  - section: rounded
    reason: "No custom shapes: entries are unboxed text rows; dialogs use host chrome."
  - section: spacing
    reason: "No layout tokens: output is a sequence of full-width transcript rows; spacing is the host chat layout."
  - section: components
    reason: "Atoms carry no styling tokens. Their content and interaction contract lives in prose (Components section) so agents reproduce exact strings, prefixes, and flows."
---

## Overview

**Qdrant Memory** is a pi extension that stores and recalls durable conversation
knowledge (decisions, facts, constraints, preferences, session summaries) as
embeddings in a per-project Qdrant collection. Its UI is *terminal-native and
quiet*: it lives entirely inside the pi transcript and footer, renders nothing
unless the user asks or something breaks, and never draws attention during normal
operation.

The personality is **calm and precise** — a tool that behaves like a well-behaved
CLI verb, not an app. Output is unadorned plain text that reads as fast as a grep
result. The only branded element anywhere is the brain glyph `🧠`, used as the
statusline mark to signal "memory is present and healthy."

## Colors

The extension owns no color. Every color an agent might need is resolved by the
**pi host theme**; never hard-code a color, ANSI code, or emoji color inside this
extension's output.

The semantic roles this surface relies on, all inherited from the host:

- **Default text** — all informational output (status lines, remembered/search
  results, confirmations).
- **Error** — the `error:` prefix rows and any failure message. Rendered through
  normal text output (plain), not styling; the host's error affordances apply if
  a channel provides them (e.g. `ctx.ui.notify` `"error"` level).
- **The 🧠 glyph** is the sole permitted chromatic element, and only in the
  footer statusline — never inline in output rows.

## Typography

Delegated to the host: **monospace, single weight, no decoration**. All text this
extension emits is *content*, not chrome:

- No bold, italic, underline, caps, or colorization of words inside rows.
- Do not invent markdown emphasis inside command output; output is rendered
  verbatim.
- The only typographic structure is **leading labels and prefixes** (see
  Components), which are plain text like `/qdrant: ` and `mode:`.

## Layout

The extension produces three kinds of surface, all hosted by pi:

1. **Command-output rows** — one row per logical line, in the chat transcript,
   each prefixed `/qdrant: `. Multi-line content (e.g. the help list, a search
   hit block) may be one row carrying newlines; the host wraps at terminal width.
2. **Footer status** — a single statusline entry, format
   `🧠 Memory: <mode> (<collection>)` (e.g. `🧠 Memory: mode1 (pi-mem-abc123…)`),
   set once at session start; the host owns footer teardown.
3. **Settings form** — host dialogs, always walked in the fixed order
   **pick → edit → confirm**. One field per invocation; never more than three
   dialogs per command.

Long values are truncated by the host at the terminal edge, never by the
extension choosing a width.

## Elevation & Depth

**None — flat by design.** Visual hierarchy comes from *lead-in prefixes and
line structure*, not elevation:

- Each output line begins with a stable label (`/qdrant: `, `mode: `, `qdrant: `,
  `embeddings: `, `settings: `) so a reader can scan vertically.
- Search results are blocks of plain lines (`[type] score=…` header line, then
  the text), separated by the transcript's own row spacing.
- Do not add borders, background fills, or box-drawing frames.

## Shapes

No custom shapes. Entries are unboxed text rows with no border or corner radius;
dialogs use pi's built-in chrome. The extension never draws its own boxes,
dividers, or highlight regions.

## Components

The atoms below are content-and-behavior contracts. Reproduce the exact strings
and flows; apply no styling tokens.

### footer-status

The statusline entry shown while a session is active.

- Content: `🧠 Memory: {mode} ({collection})`.
- `mode` is the resolved runtime mode label: `mode1` (pi-blackhole present,
  ingest its artifacts) or `mode2` (own compaction capture).
- `collection` is the project collection id (`pi-mem-<16 hex>`).
- Set on `session_start`, never cleared mid-session by the extension — the host
  owns footer teardown. Best-effort — never
  throw if the footer is unavailable.

### command-output-entry

The unit of slash-command output (`/qdrant-status`, `/qdrant-help`, …). Rendered
via `pi.appendEntry` + a registered entry renderer so it is **visible in the
transcript and absent from the LLM context**.

- Prefix: every *first* line of a logical message is `"/qdrant: "` (e.g.
  `/qdrant: mode: mode1`).
- Info rows: label-led plain text (`mode: …`, `qdrant: reachable, collection …
  has N points`, `embeddings: reachable (model @ url)`, `remembered
  (remember_tool): <text>`, `cleared: collection … reset`).
- Search results: a hit block starts `[{type}] score={n} ({pointer or "no source
  pointer"})` then the memory text on the following line(s).
- Failure rows: `error: <message>`; the command exits normally with the error as
  *data* — never a crash, never a dialog.

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
`settings: <key> updated (reloaded at runtime)`.

### agent-tool-results

`memory_save` and `memory_search` return plain text to the model: `remembered
(remember_tool): <text>` or `memory_search failed: <reason>` on errors, and for
searches the same hit-block format as `command-output-entry`. No UI is drawn for
tool calls.

## Do's and Don'ts

- Do render every slash-command output line with the `/qdrant: ` prefix.
- Do keep all output **plain text** — no colors, weights, emoji (except the
  statusline 🧠), borders, or markdown decoration.
- Do surface failures as `error:` text rows; never throw into the host, never
  open a dialog from a lifecycle hook, never block a session.
- Do remember that command output belongs in **entries** (`appendEntry` +
  entry renderer), never `sendMessage` — the latter's `display` flag gates only
  rendering, so it still reaches the LLM context.
- Do let the settings form be fully Esc-cancellable and confirm writes before
  persisting.
- Don't invent a palette, font, or spacing scale — the pi host theme owns them.
- Don't draw boxes, dividers, or custom chrome.
- Don't style or decorate search/remembered content; the knowledge text is the
  product and must stay verbatim and unadorned.
