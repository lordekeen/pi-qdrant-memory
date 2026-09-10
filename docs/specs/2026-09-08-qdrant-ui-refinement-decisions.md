# /qdrant-* UI Refinement — Decision Log

Status: **Superseded** — the approved contract was folded into `DESIGN.md`
(2026-09-08). Kept as the rationale record (notably the `/qdrant: ` prefix
reversal in decisions #2/#9). The implementation plan lives in
`2026-09-08-qdrant-ui-refinement-plan.md`.

## Decisions locked in the grill (log)

1. **Direction** — change the personality: visibly first-class TUI output, but
   restrained. No overdesigning.
2. **Invariants kept** — verbatim knowledge text · errors as data rows · colors
   only via host theme tokens (no invented palette) · footer statusline
   unchanged · single-token command names & entry-only output channel unchanged.
   **Reversed during the grill (commit this to memory):** the old `/qdrant: `
   text-echo prefix is dropped — the transcript already shows the invoking
   `/qdrant-*` line, so echoing `/qdrant: ` in output is redundant command-echo
   (see #9).
3. **Law dropped** — the "flat / no boxes / no borders / no emphasis ever" rule.
4. **Scope** — every human-facing surface: `status`, `search`, `help`,
   `remember`/`clear`/`settings` confirmations, settings dialogs. Tool return
   strings (`memory_save` / `memory_search`) stay plain LLM text — unchanged.
5. **Method** — contract-first: this draft → approved `DESIGN.md` → impl plan →
   code + tests.
6. **Chrome language** — hybrid: one bg panel (status) · expandable entries
   (search, status detail) · semantic color + glyphs · no rules/borders/frames.
7. **Overdesign vetoes (encoded as rules)** — only status gets a bg panel;
   confirmations carry no icons; expand + keybinding hints only where content is
   genuinely hidden; no rules/headers in small outputs; no animation/motion.
8. **Per-type color is permitted** (the one multi-color element) — see §Search.
9. **No `/qdrant: ` text prefix anywhere in output.** Attribution comes from
   inner structural labels (`remembered:`, `cleared:`, `settings:`, `error:`,
   `memory:`, `qdrant:`, `embeddings:`, …), the status card's bg, and the
   command line directly above the block. Slashes are input grammar; output is
   not a command. Sibling extensions stamp via chrome + labels, not a text echo.
10. **Search granularity** — one entry per query, not per hit.

## Personality (replaces the old "calm & chrome-free" identity)

Still terminal-native and calm at rest: **content-first chrome**. Color, glyphs,
a single panel, and expand-on-demand are used only where they buy at-a-glance
scanning or hide real detail — never as decoration. Every color/glyph resolves
through the pi host theme; the extension invents no palette, font, or spacing.
Output never echoes its own command path (`/qdrant-*`) as a text prefix.

## Entry-channel changes (implementation seam)

Today `io.print(text)` → one `appendEntry` per call, renderer wraps the raw
string in a bare `Text`. Under the new contract:

- Command output becomes **structured entries**: `appendEntry(kind, payload)`
  where `kind ∈ { status-card, search-results, message, error }` and the single
  registered renderer switches on `kind`, building a `Text`/`Box` with the
  `theme` the renderer receives.
- The renderer already receives `(entry, { expanded }, theme)`; expansion +
  keybinding hints come from pi (verify exact trigger + `keyHint` id at impl).
- Structural labels are composed at payload-build time (no `/qdrant: ` echo);
  bare plain-text rows (hit bodies, expanded detail) carry no labels.
- Pure renderer functions stay unit-testable without pi-tui (as today: lazy
  import; renderer returns `undefined` → pi skips the row in tests).

## Per-surface contracts

### `/qdrant-status` — the one background panel

One entry. **Collapsed** (default), a compact card; bg fill via a host theme bg
token. Rows share a label column (`label:` bold/dim, value default); first row
is the mode line:

```
memory: mode1                 ← bold label; value follows
qdrant: ✓ reachable · 47 points
embeddings: ✓ reachable
```

Variants: `✗ NOT reachable` (error token) on the failing subsystem;
`! collection pi-mem-… missing` (warning token). Glyph carries state; color
refines (pi-processes convention).

**Expanded** appends genuinely-hidden detail rows (no bg on these):

```
collection: pi-mem-<hex>
qdrant url: http://localhost:6333
model: nomic-embed-text @ http://localhost:8080/v1
dimension: 768 · threshold: 0.15 · maxResults: 5
```

(No API keys ever displayed; presence not implied.)
Collapsed shows one `keyHint` ("enter to expand") since detail is hidden.
If no host bg token resolves at runtime, the card degrades to plain rows —
never a crash.

### `/qdrant-search` — one expandable entry per query

**Collapsed** (default):

```
3 results · top [fact] 0.87   (enter to expand)
```

- Colored per-type tag on the "top" hit; count plain.
- Only rendered expandable when hits exist (all content hidden → hint is legit).

**Expanded** — every hit, verbatim, never truncated:

```
[decision] 0.92 (source_entry_id=…)
<full text, verbatim>

[fact] 0.87 (session_id=…)
<full text, verbatim>
```

- Type tag color map (the permitted per-type element): `decision` → accent,
  `fact` → success, `constraint` → warning, `preference` → dim,
  `session_summary` → muted. Semantic tokens only.
- Score + pointer plain/dim; text default, verbatim (200-char truncation +
  ellipsis applies **only** to the collapsed "top" preview, never expanded).
- Blank line between hits; no rules.
- Zero hits → one plain line: `No relevant memory found.` (no icon, not
  expandable).
- Failure → `error:` row (see below). Note: `memory_search` (tool path) keeps
  today's plain `renderHits` text unchanged — this contract is the command path
  only.

### `/qdrant-help` — one entry, aligned, no rules

Rows below a bold `commands` title align command names (padded column) with dim
descriptions. No grouping, no rules, no icons.

### Confirmations (`/qdrant-remember`, `/qdrant-clear`, `/qdrant-settings` writes)

One plain one-line entry each. No icons, no color beyond default text; label dim
optional:

```
remembered (remember_tool): <verbatim text>
cleared: collection pi-mem-… reset
settings: scoreThreshold updated (reloaded at runtime)
settings: scoreThreshold unchanged (cancelled)
```

### Errors

One entry: `error: <message>`, whole row in the host error token. Rendered as
data — never a crash/dialog. (Today a thrown handler error is appended via a
raw unprefixed catch; unify it through the same channel so it gets the `error:`
lead.)

### Settings dialog flow (`ctx.ui`)

Host chrome owns visuals — unchanged. Copy tweaks only where they conflict with
the new terms (title/confirm strings already align; no change expected).

## Open points to confirm at review

1. Exact bg token for the card — resolve at impl from host theme; fallback
   defined above. OK?
2. Per-type palette above (decision→accent …) — confirm or redline hues.
3. Truncation threshold for the collapsed "top" preview stays 200 chars?

## Test/impl ripple (for the plan)

- Handler-output tests asserting `/qdrant: ` strings change with the prefix
  drop.
- New structured entry kind(s) + renderer switch; pure render functions stay
  testable without pi-tui (renderer returns `undefined` under plain node).
- `renderHits` (tool path, LLM text) is untouched.
