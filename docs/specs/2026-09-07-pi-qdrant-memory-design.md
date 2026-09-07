---
title: pi-qdrant-memory — Design Specification
type: design-spec
status: approved-for-implementation
date: 2026-09-07
author: validated via interactive brainstorm with the project owner
scope-boundary: single-spec WRITE task; no code, no scaffolding, no implementation plan
tags: [pi, pi.dev, qdrant, vector-database, semantic-memory, embeddings, pi-blackhole, cross-session]
---

# pi-qdrant-memory — durable conversation knowledge for pi.dev

> Design specification for a pi.dev extension named **pi-qdrant-memory**. This document is the
> authoritative, implementation-ready transcription of a fully validated interactive brainstorm.
> It is self-contained: an implementing team in a full environment (git/node/npm) should be able
> to build the extension from this document alone, using the cited references for grounding.

---

## 1. Executive Summary

Give the pi agent an **always-available, semantic, cross-session / cross-project retrieval layer**
over the project's **durable conversation knowledge** — decisions, rationale, constraints, and
preferences that exist only in chat and would otherwise be lost to context compaction.

The ecosystem is intentionally split across three complementary tools, each owning one slice
(verified against live sources, see [§ 2.2](#22-division-of-labor-verified-against-live-sources)):

| Tool | Owns | Backend | Session scope |
| --- | --- | --- | --- |
| `codegraph` | current code **structure** (exact/graph) | SQLite + FTS5 + graph | per-project |
| `pi-blackhole` | durable decision **capture** | custom typed session entries + pending JSON | per-session lineages |
| **pi-qdrant-memory (this)** | **semantic retrieval** over durable artifacts | Qdrant vector DB (user-provisioned, REST `:6333`) | cross-session / cross-project |

`pi-qdrant-memory` is the missing **semantic, cross-session/cross-project layer**. It is
blackhole-aware:

- **Mode 1 (blackhole present, coexistence):** reads pi-blackhole's durable artifacts (`om.*`
  custom session entries + per-session pending JSON), embeds them, and ingests them into a
  per-project Qdrant collection. It **never** claims the `session_before_compact` hook.
- **Mode 2 (blackhole absent, fallback):** registers its own `session_before_compact` hook and
  captures durable knowledge at compaction time (light distillation or the embed of pi's own
  compaction summary), plus a manual `/qdrant remember` command from the user-facing slash-command
  family (see [§ 5.6](#56-slash-command-surface-pi-tui)).

The agent-facing surface is two tools — **`remember`** (explicit write) and **`memory_search`**
(semantic read) — backed by an automatic safety-net capture path so durable knowledge is recorded
even when the agent never explicitly calls `remember`.

For the human at the TUI, the extension registers a **`/qdrant` slash-command family**
(`status`, `settings`, `remember`, `search`, `clear`, `help`) mirroring pi-blackhole's command
style (see [§ 5.6](#56-slash-command-surface-pi-tui)). `/qdrant settings` opens a TUI form that
edits the single source-of-truth config JSON, and `PI_QDRANT_*` env vars override config at load.

Design choices (full log in [§ 8](#8-decision-log)): embeddings come from a **generic
OpenAI-compatible `/embeddings` endpoint** — by default a local llama.cpp OpenAI-format server
running `nomic-embed-text` (768-dim, no external keys), optionally any hosted OpenAI-compatible
API — with `expectedDimension` guarding the dimension-drift recreate path; one Qdrant collection
per project, named from a stable project id; user-provisioned Qdrant on `localhost:6333` via REST;
config is a single canonical JSON file (TUI-edited, env-overridable); packaged as a proper pi
package (npm/git) with a zero-dependency internal module.

---

## 2. Objective & Scope

### 2.1 Problem statement

pi's working memory is **ephemeral**. When a session is compacted, chat-only knowledge — the
reasoning that led to a decision, the constraints the agent negotiated, the user's stated
preferences, the rationale behind a rejected approach — is either summarized and partially lost or
never captured at all. None of it lives in a file, so file-based tooling (`read`, `grep`, `git`,
`codegraph`) cannot recover it. On a later session (or in another project), the agent effectively
"forgets" durable knowledge it once had.

`pi-qdrant-memory` closes that gap with **semantic retrieval over durable conversation
artifacts**: embed durable knowledge once, store it in a per-project Qdrant collection, and let the
agent query it by meaning on demand — across sessions and across projects.

### 2.2 Division of labor (verified against live sources)

- **`codegraph`** ([github.com/colbymchenry/codegraph](https://github.com/colbymchenry/codegraph))
  → current **code structure** (exact/graph). Backend: SQLite + FTS5 + graph. Deliberately
  **no embeddings**; **no history/decisions capture**; **per-project**.
- **`pi-blackhole`** ([github.com/k0valik/pi-blackhole](https://github.com/k0valik/pi-blackhole))
  → durable decision **capture** via Observer / Reflector / Dropper workers writing **typed custom
  session entries**: `om.observations.recorded` and `om.reflections.recorded`. Entries use
  **12-char hex ids** and carry typed shapes:
  - `Observation { id, content, timestamp, relevance, sourceEntryIds, tokenCount }`
  - `Reflection { id, content, supportingObservationIds, tokenCount }`
  - Per-session artifact: `<sessionId>-pending.json` under
    `~/.pi/agent/pi-blackhole/` (honoring `PI_CODING_AGENT_DIR` override).
  - pi-blackhole **owns the `session_before_compact` hook** and replaces `/compact`. Its retrieval
    is **lexical only** (BM25 / regex recall tool scoped to a single session's lineages); **no
    embeddings**; **no semantic / cross-session query**. `/blackhole-export` is a manual
    cross-session Markdown handoff.
- **THIS EXTENSION** → **semantic retrieval** over blackhole's durable artifacts (Mode 1) or its
  own capture in fallback mode (Mode 2). It is the missing **semantic, cross-session /
  cross-project** layer.

### 2.3 Out of scope (explicitly excluded from design)

| Excluded | Covered by / rationale |
| --- | --- |
| **Code-embedding semantic search** | `codegraph` covers code precision (exact/graph/SQLite+FTS5); code lives in files and is one read away. |
| **Project-doc ingestion** (README / ADR / CHANGELOG) | pi's `read` / `grep` / `git` / `codegraph` cover files directly. |
| **Git-history indexing** | the agent can query `git` directly. |

### 2.4 Rationale for the scope cuts

Pre-indexing content that is **one file-read away** is **anti-pi** (context bloat) and adds
**stale-index maintenance** (files change; an index drifts; someone must keep it fresh). Qdrant's
unique value here is content **not in any file** — conversation-only knowledge. That is the sole
kind of content this extension indexes. The corollary: this extension never re-derives what
file-based tools already answer natively; it is additive, not redundant.

---

## 3. Architecture & Operating Modes (blackhole-aware)

### 3.1 Mode detection at session_start

At `session_start`, the extension detects whether pi-blackhole is loaded:

1. Resolve the agent directory: `PI_CODING_AGENT_DIR` override if set, otherwise
   `~/.pi/agent/`.
2. Check for a **present and valid** pi-blackhole config at
   `~/.pi/agent/pi-blackhole/pi-blackhole-config.json`.
   - *Present and valid* means the file exists, parses as JSON, and contains the keys
     pi-blackhole requires to be operational (its enabled/flag or equivalent active marker).
3. Result:
   - Config present + valid → **Mode 1** (coexistence).
   - Config absent or invalid → **Mode 2** (own capture).

**Mode is also config-overridable**, not only auto-detected. The extension config key `mode`
accepts `auto | blackhole | own` (see [§ 6.2](#62-configuration-file)):

- `auto` → detection above.
- `blackhole` → force Mode 1 regardless of detection (e.g., pi-blackhole config is temporarily
  malformed but the user knows it is installed).
- `own` → force Mode 2 even if pi-blackhole is present (user wants the extension to capture
  independently).

### 3.2 Mode 1 — blackhole present (coexistence)

**Contract:** pi-blackhole owns capture and the `session_before_compact` hook. The extension
**never claims `session_before_compact`** in Mode 1. This is a verified coexistence constraint:
pi-blackhole breaks if another extension claims that hook / the compaction lifecycle — claiming it
would create a load conflict. The extension must not compete with pi-blackhole for the
compaction hook.

Responsibilities in Mode 1:

- **Read** pi-blackhole's durable artifacts:
  - `om.observations.recorded` / `om.reflections.recorded` custom session entries for the current
    and completed sessions (where readable via pi's session API / entry store), and
  - the per-session `<sessionId>-pending.json` files under `~/.pi/agent/pi-blackhole/`.
- **Embed and ingest** each durable artifact into the project's Qdrant collection (see
  [§ 4](#4-data-model-qdrant) and [§ 5.3](#53-auto-safety-net)).
- **Ingest triggers:**
  - `session_start` → catch-up: ingest blackhole artifacts for prior completed sessions so history
    becomes queryable at the start of any session.
  - `session_end` → ingest the current session's artifacts before the session closes.

### 3.3 Mode 2 — blackhole absent (fallback, own capture)

pi-blackhole is not present, so the extension performs its own durable capture:

- **Register its own `session_before_compact` hook** (it is now free to do so — no blackhole
  conflict).
- **At compact time**, capture durable knowledge:
  - perform a **light distillation** of the session into durable-knowledge candidates, or
  - embed **pi's own compaction summary** produced at the compaction boundary.
- **Manual capture** via the `/qdrant remember` slash command (see
  [§ 5.6](#56-slash-command-surface-pi-tui)) for on-demand capture outside the compaction cycle
  (user- or agent-triggered "save what matters from this session now"); in Mode 2 this command is
  also the manual safety-net save.
- **Auto snapshot as a safety net** so that even if a capture at compaction is skipped or fails, an
  earlier automatic snapshot of the session's durable content has already been persisted.

### 3.4 Runtime lifecycle & resource ownership

- Runtime is **in-process** with the pi agent.
- The extension factory **must not start background resources** (no timers, no server sockets, no
  watchers) at factory time — per pi extension docs, background/periodic work is deferred to
  `session_start` and cleaned up at `session_shutdown`.
- Lifecycle outline:
  - `session_start` → mode detection, collection ensure, Mode-1 catch-up ingest or Mode-2 hook
    registration, prompt wiring.
  - session body → `remember` / `memory_search` tools available; auto safety-net capture runs on
    its triggers.
  - `session_shutdown` → stop any background loops, close/flush pending ingest work.

---

## 4. Data Model (Qdrant)

### 4.1 Collection layout — one collection per project

- **One Qdrant collection per project.**
- **Collection name** derives from a **stable project id**:
  - `project_id = sha256(git_root_path)` (first 16 hex chars), mirroring zoo-code's `ws-<sha>`
    scheme (see [`2026-09-06 zoo-code qdrant vector-db deep-dive.md`](docs/research/2026-09-06%20zoo-code%20qdrant%20vector-db%20deep-dive.md:30)).
  - The root is anchored to the **git root** (like pi-blackhole anchors to project/lineage
    identity), not the cwd, so the collection is stable regardless of which subdirectory a session
    starts in.
  - Collection name: `pi-mem-<project_id>` (namespace prefix avoids collisions with any other
    tool's collections on the same Qdrant instance).
- **Moving the project directory ⇒ a new empty collection** (new root hash). Accepted and
  documented behavior — no migration; the old collection simply becomes orphaned and can be
  dropped manually.

### 4.2 Vector configuration

| Property | Value | Notes |
| --- | --- | --- |
| Vectors | **single unnamed vector** | no named-vector multiplexing needed (one embedding per artifact) |
| Dimension | embedding model dimension — **768** for `nomic-embed-text` | must match the configured embedding model |
| Distance | **Cosine** | semantic similarity semantics |
| Storage | **`on_disk: true`** | durable, memory-lean |
| Index | **HNSW** | default params unless a project profile demands tuning |

**Dimension drift ⇒ recreate the collection.** If the configured embedding model's dimension
differs from the collection's vector size at ensure-time, the extension deletes and recreates the
collection (empty). The model-switch cost (re-embedding all artifacts) is **accepted**; this
follows zoo-code prior art, where switching embedding-model dimensionality silently resets the
index ([`2026-09-06 zoo-code qdrant vector-db deep-dive.md`](docs/research/2026-09-06%20zoo-code%20qdrant%20vector-db%20deep-dive.md:32)).

### 4.3 Point payload schema

Each point stores the rendered artifact text plus pointer metadata back to the originating
evidence:

```jsonc
{
  "type": "decision",            // enum, see below
  "text": "Rendered durable content...",
  "project_id": "pi-mem-<16 hex>",
  "session_id": "abc123...",      // optional — present when the artifact names its session
  "source_entry_id": "12charhex", // optional — blackhole observation/reflection id, or own entry id
  "ts": 1720000000000,            // epoch ms (or ISO-8601 string) — capture time of the artifact
  "source_kind": "blackhole_observation"
}
```

- **`type`** ∈ `{decision, fact, constraint, preference, session_summary}`. The classifier is the
  writer (blackhole entry kind, `remember` tool type param, or the Mode-2 distiller).
- **`source_kind`** ∈ `{blackhole_observation, blackhole_reflection, remember_tool, own_capture}`.
  Tells the renderer how to open the originating evidence and what to display.
- **`text`** is stored for **rendering** and **pointers back to evidence** — search results show the
  stored text and let the user/agent jump to the originating session entry.

### 4.4 Payload keyword indexes

Create **keyword payload indexes** on:
- `type`
- `project_id`

Rationale: every search is scoped to the current project (`project_id` filter) and may be
type-filtered (`type`). Indexing these two fields keeps filtered vector search fast. (Full-text
indexes on `text` are deliberately **not** created — lexical retrieval is blackhole's job in its
single-session lineage; this extension is semantic.)

### 4.5 Search

- API: Qdrant **query** API against the project collection.
- Behavior:
  - Vector: the embedded query (single unnamed vector).
  - Filter: `must` on `project_id` (current project); optional `must` on `type` when the caller
    restricts type.
  - `score_threshold`: **per-embedding-model default**. For `nomic-embed-text`, the default is
    **≈ 0.15–0.2**; it may vary by embedding model (see [§ 6.1](#61-embeddings)). This honors the
    zoo-code lesson that nomic-family cosine scores sit well below the generic 0.4 default and
    would otherwise empty the result set
    ([`2026-09-06 zoo-code qdrant vector-db deep-dive.md`](docs/research/2026-09-06%20zoo-code%20qdrant%20vector-db%20deep-dive.md:52)).
  - `limit`: configurable, **default ~10**.
  - HNSW search (`exact: false`).
- Empty result handling: return a clear "no relevant memory found" message; never crash.

---

## 5. Tool Surface & Capture Flow (pi extension API)

### 5.1 `remember` (agent-driven write)

Called by the model when a **durable decision / constraint / preference is settled** in
conversation and should be retained for future sessions.

- **Params:** `{ text, type? }` (session context — project id, session id — is supplied by the
  extension, not the model).
  - `text`: the durable statement to persist (model normalizes to a self-contained, standalone
    form so it reads correctly outside the conversation).
  - `type?`: one of `decision | fact | constraint | preference`; if omitted, default to `decision`.
- **Flow:** embed `text` → **upsert** into the project collection with a **deterministic point id**
  derived from a **content hash** (see [§ 5.4](#54-deterministic-point-ids--deduplication)), so
  re-remembering the same statement is idempotent.
- **Prompt wiring:** the tool is nudged into behavior via `promptSnippet` / `promptGuidelines`
  so the model calls it at decision boundaries (e.g., "when a design choice is finalized or a
  constraint is stated, call `remember`").

### 5.2 `memory_search` (agent-driven read)

Called by the model when it needs **prior decisions** relevant to the current task.

- **Params:** `{ query, type?, limit? }`.
  - `query`: natural-language description of what prior knowledge is needed.
  - `type?`: restrict to a durable-knowledge type.
  - `limit?`: override the configured max results (still capped by `maxResults` config).
- **Flow:** embed query → search the project collection (filter by `project_id`, optional `type`,
  `score_threshold`, `limit`).
- **Result shape** (ranked by score): `{ text, type, ts, source pointer }` where the source pointer
  is the `source_entry_id` / session reference used for verification.
- **Invocation pattern:** mirrors `codegraph_explore` usage — the agent proactively calls it when
  it recognizes it is reasoning about something it may have decided before.

### 5.3 Auto safety net

Durable capture must not depend on the model remembering to call `remember`:

- **Mode 1:** ingest pi-blackhole artifacts at `session_start` (catch-up) and `session_end`
  (current session) — see [§ 3.2](#32-mode-1--blackhole-present-coexistence).
- **Mode 2:** capture at compaction via the registered `session_before_compact` hook (light
  distillation or embed of pi's compaction summary), plus the manual `/qdrant remember` command
  and the auto snapshot — see [§ 3.3](#33-mode-2--blackhole-absent-fallback-own-capture) and
  [§ 5.6](#56-slash-command-surface-pi-tui).
- **Dedupe:** all ingestion paths use the same **deterministic content-hash point ids**, so a
  blackhole artifact ingested at `session_start` and again at `session_end` (or via a later
  catch-up) collapses to one point.

### 5.4 Deterministic point ids & deduplication

- **Point id** = `sha256(canonical_string)` where the canonical string is the normalized artifact
  content joined with its identifying context:
  - `canonical = normalize(text) + "|" + source_kind + "|" + (source_entry_id ?? session_id ?? "")`.
  - `point_id = sha256(canonical).slice(0, 32)` (32 hex chars — a full uint128-compatible Qdrant id).
- Deduplication semantics:
  - Same blackhole artifact re-ingested ⇒ same id ⇒ **overwrite (upsert)**, not duplicate.
  - `remember` called twice with equivalent text ⇒ same id ⇒ idempotent.
  - Different sessions capturing the same decision text via `own_capture` ⇒ differs by
    `session_id`; because `own_capture` distillation may produce near-identical text across
    sessions, the deterministic id keeps these as distinct points only when their session context
    differs — acceptable, and results are still de-noised by `score_threshold`.

### 5.5 Result rendering

- Search results render as **collapsible rows** (mirrors zoo-code's codebase-search UI pattern,
  [`2026-09-06 zoo-code qdrant vector-db deep-dive.md`](docs/research/2026-09-06%20zoo-code%20qdrant%20vector-db%20deep-dive.md:54)).
- Each row shows `type`, score, and a text preview.
- **Clicking a row / following the source pointer opens the originating session entry** for
  verification — via pi-blackhole recall ids where available (`source_entry_id`), otherwise by
  opening the source session. Rendering and verification is the point of storing `text` in the
  payload.

### 5.6 Slash-command surface (pi TUI)

For the human at the TUI, the extension registers a **`/qdrant` command family** via
`pi.registerCommand`, mirroring pi-blackhole's command style (e.g. `/blackhole-export`). The
agent-side tools ([§ 5.1](#51-remember-agent-driven-write) /
[§ 5.2](#52-memory_search-agent-driven-read)) remain the primary consumers of the retrieval
engine; these commands expose the same engine directly to the user:

| Command | Purpose |
| --- | --- |
| `/qdrant status` | Connection health: Qdrant reachable?, embedding server reachable?, active mode (Mode 1 blackhole / Mode 2 own-capture / disabled), current project collection exists + point count. |
| `/qdrant settings` | Opens a TUI settings form (see [§ 6.2](#62-configuration-file)) that reads, edits, and persists the canonical config JSON; changes reload at runtime on save. |
| `/qdrant remember <text>` | Manual capture — the user-facing twin of the `remember` tool ([§ 5.1](#51-remember-agent-driven-write)); in Mode 2 this is also the manual safety-net save ([§ 3.3](#33-mode-2--blackhole-absent-fallback-own-capture)). |
| `/qdrant search <query>` | Manual semantic search — the user-facing twin of the `memory_search` tool ([§ 5.2](#52-memory_search-agent-driven-read)); the agent-side tool remains the primary consumer. |
| `/qdrant clear` | Reset / clear the current project's collection. |
| `/qdrant help` | Inline list of commands (progressive-disclosure friendly). |

No separate top-level `/remember` command is registered — the user-facing manual save is the
`/qdrant remember` subcommand — keeping the surface under the single `/qdrant` family and
consistent with the manual-capture references in [§ 3.3](#33-mode-2--blackhole-absent-fallback-own-capture)
and the executive summary.

---

## 6. Embeddings, Config & Packaging

### 6.1 Embeddings

The embedding client is a **generic OpenAI-compatible `/embeddings` HTTP client** built on Node's
**global `fetch`** (no SDK dependency). It is usable against **any** OpenAI-compatible embeddings
endpoint — it is **not locked to local llama.cpp**:

- **Default / local (the user's setup):** a local llama.cpp server in OpenAI-compatible format
  running `nomic-embed-text` (**768-dim**) — the same model as the user's zoo-code install, so
  dimension and score behavior are already familiar and shared.
- **Also supported:** **Ollama**, or **any hosted OpenAI-compatible embedding API** (OpenAI and
  compatible proxies). Hosted/remote options may require an API key (`embeddingApiKey`).
- **Transport:** Node **global `fetch`** to the configured endpoint's `/embeddings` route.

Config keys controlling embeddings: `embeddingBaseURL`, `embeddingModel`, optional
`embeddingApiKey`, and `expectedDimension` (see [§ 6.2](#62-configuration-file)). The base URL
points at any server exposing an OpenAI-compatible `/embeddings` route (e.g.
`http://localhost:8080/v1` for llama.cpp; the value is user-configurable).

**Dimension consistency is a hard constraint.** The embedding dimension must match the collection's
vector size — `768` by default for `nomic-embed-text`. `expectedDimension` pins the expected
dimension; if unset, the extension **auto-detects** the model's dimension and **warns on drift**. A
hosted model with a **different dimension** triggers the destructive collection-recreate path
(dimension-drift recreate, see [§ 4.2](#42-vector-configuration)) — switching models means
re-embedding all artifacts.

**Per-model `scoreThreshold`.** The default stays tuned to the embedding model in use: for
`nomic-embed-text` it is **≈ 0.15–0.2** (see [§ 4.5](#45-search)) and may vary by model, so the
per-model default should be revisited when `embeddingModel` changes.

### 6.2 Configuration file

The config **JSON file is the single source of truth** — authoritative and portable. Layout
mirrors pi-blackhole's config under its own agent-dir folder.

- **Path:** `<agent-dir>/pi-qdrant-memory/pi-qdrant-memory-config.json`, where `<agent-dir>` is
  `~/.pi/agent` unless `PI_CODING_AGENT_DIR` overrides it (mirroring pi-blackhole's config
  layout).
- **Editing model — never hand-edit the JSON.** `/qdrant settings` (see
  [§ 5.6](#56-slash-command-surface-pi-tui)) opens a pi `ctx.ui` form (select / confirm / input /
  editor) that **reads, edits, and persists back to the same JSON file**, with runtime
  reload-on-save; the file remains canonical and portable.
- **Env-var overrides:** `PI_QDRANT_*` variables are applied **at load**, with precedence
  **global → project → env** (matching pi-blackhole's precedence semantics). Representative names:
  `PI_QDRANT_URL`, `PI_QDRANT_EMBEDDING_BASE_URL`, `PI_QDRANT_EMBEDDING_MODEL`, `PI_QDRANT_MODE` —
  mapping to `qdrantUrl`, `embeddingBaseURL`, `embeddingModel`, and `mode` respectively.

```jsonc
{
  "qdrantUrl": "http://localhost:6333",   // Qdrant REST endpoint
  "qdrantApiKey": null,                    // optional; null / omitted when unauthenticated
  "embeddingBaseURL": "http://localhost:8080/v1",  // any OpenAI-compatible /embeddings endpoint
  "embeddingModel": "nomic-embed-text",
  "embeddingApiKey": null,             // optional; hosted OpenAI-compatible APIs only
  "expectedDimension": 768,            // must match collection vector dimension (nomic = 768)
  "scoreThreshold": 0.18,                  // per-model default ≈0.15–0.2 for nomic
  "maxResults": 10,                        // default search limit
  "mode": "auto"                           // auto | blackhole | own
}
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `qdrantUrl` | string | `http://localhost:6333` | Qdrant REST base URL (see [§ 6.3](#63-packaging--runtime)). |
| `qdrantApiKey` | string \| null | `null` | Optional Qdrant API key for secured Qdrant instances. |
| `embeddingBaseURL` | string | (see above) | Any **OpenAI-compatible `/embeddings` endpoint**; llama.cpp local default, Ollama / hosted APIs supported. |
| `embeddingModel` | string | `nomic-embed-text` | Embedding model id; determines dimension. |
| `embeddingApiKey` | string \| null | `null` | Optional API key for hosted OpenAI-compatible embedding APIs; not needed for local llama.cpp. |
| `expectedDimension` | number | `768` | Expected embedding dimension (nomic-embed-text = 768); guards the dimension-drift recreate path ([§ 4.2](#42-vector-configuration)); auto-detected with warn-on-drift if unset. |
| `scoreThreshold` | number | `0.18` | Per-model default; honors nomic ≈0.15–0.2, may vary by model (see [§ 6.1](#61-embeddings)). |
| `maxResults` | number | `10` | Default `limit` for `memory_search`. |
| `mode` | enum | `auto` | `auto` (detect) \| `blackhole` (force Mode 1) \| `own` (force Mode 2). |

If the config file is absent, defaults apply (embedded in code) so the extension runs zero-config.

### 6.3 Packaging & runtime

- **pi package** (npm/git distribution): `package.json` declares the pi extension contract:
  ```jsonc
  {
    "name": "pi-qdrant-memory",
    "pi": { "extensions": [ ... ] }
  }
  ```
- **Zero-dependency internal module:** uses only Node's **global `fetch`** (Qdrant REST +
  embedding endpoint) and **`crypto`** (sha256 hashing / deterministic ids). No runtime package
  dependencies to install or reconcile.
- **Auto-load fallback:** for quickstart, the extension may also be auto-loaded from
  `.pi/extensions/` (drop-in folder), in addition to the packaged install path.
- **Runtime:** in-process; **no background resources started from the extension factory** — all
  work is deferred to `session_start` and torn down at `session_shutdown` (per pi docs).
- **Networking notes:**
  - Qdrant is reached over **REST at `:6333`** (gRPC is `:6334`; REST is the documented
    transport for this extension). If `qdrantUrl` has no port, follow standard behavior
    (default http port) — the shipped default includes `:6333` explicitly.
  - Embedding server is separate from Qdrant; both must be reachable for writes/searches.

---

## 7. Error Handling & Testing

### 7.1 Error handling & graceful degradation

- **Unreachable Qdrant or embedding server ⇒ graceful degradation.** Tools return a clear,
  actionable message (e.g., "Qdrant is not reachable at `http://localhost:6333` — start it or
  check the config"), **never crash the session**, and never block the agent's core loop.
- **Retries / backoff on writes:** ingest and `remember` upserts retry transient failures with
  backoff (bounded attempts); a hard failure is surfaced via error log, not thrown into the
  session.
- **Mode-2 capture failures must not break pi compaction.** The capture path is
  **fire-and-forget + error log**: if distillation/embed/upsert fails at the compaction hook, the
  failure is logged and compaction proceeds normally. Compaction is owned by the agent; the
  extension must never be the reason compaction stalls or fails.
- **No-embedding-server case:** because retrieval requires embeddings, reads also degrade with a
  clear message when the embedding server is down; the session continues to operate with its other
  tools.

### 7.2 Testing matrix (full implementation environment)

| Area | Cases |
| --- | --- |
| **URL parsing matrix** | `qdrantUrl` normalization: bare host, host:port, http/https, path prefix, trailing slash, invalid URL → clear error. |
| **Collection create / dimension-recreate** | ensure creates collection with correct single-vector config (dim 768, Cosine, on_disk, HNSW); existing matching dim → no-op; mismatched dim (e.g., 768 → 384) → delete + recreate. |
| **Embedding + upsert request shape** | `/v1/embeddings` request body shape; point id derivation; payload schema fields; `upsert` with `wait: true`. |
| **Search request + payload filters** | query API shape; `project_id` must-filter; optional `type` filter; `score_threshold` + `limit`; result mapping to `{text, type, ts, source pointer}`. |
| **Dedupe ids** | same content + same source → same id (no duplicate on re-upsert); `remember` idempotency. |
| **Mode detection** | pi-blackhole config present/valid/absent/invalid → Mode 1 vs Mode 2; explicit `mode: blackhole|own` override honored. |
| **Blackhole artifact parsing** | parse `om.observations.recorded` / `om.reflections.recorded` and `<sessionId>-pending.json` against the **documented `om.*` entry schema** — see [§ A](#appendix-a--blackhole-om-entry-schema-for-parsing). |

---

## 8. Decision Log

Key design choices made during the brainstorm, with the considered alternative and the
consequence.

| # | Decision | Context / alternative rejected | Consequence |
| --- | --- | --- | --- |
| D1 | **Division of labor:** `codegraph` = code structure; `pi-blackhole` = durable capture; **this extension = semantic retrieval** (the missing semantic, cross-session/cross-project layer). | Building a general-purpose "index everything" memory tool. | Each tool owns a crisp slice; no duplication of code-indexing or lexical recall; verified against live sources. |
| D2 | **One collection per project**, named from a stable project id = `sha256(git root)`, `pi-mem-<16 hex>`. | One global collection with project payload filter; per-session collections. | Simple isolation & cleanup; moving a project dir ⇒ new empty collection (accepted). Mirrors zoo-code `ws-<sha>`. |
| D3 | **Cut project-doc ingestion** (README / ADRs / CHANGELOG). | Full workspace knowledge base. | Pre-indexing file-readable content is anti-pi (context bloat) + stale-index maintenance; pi read/grep/git/codegraph cover files. |
| D4 | **Cut code-embedding semantic search and git-history indexing.** | All-in-one memory backend. | `codegraph` covers code precision; git is queryable directly; keeps scope to conversation-only knowledge (Qdrant's unique value). |
| D5 | **Hybrid capture:** explicit `remember` tool **plus** an auto safety net (Mode 1 blackhole ingest / Mode 2 compaction capture). | Rely on agent-initiated `remember` alone. | Durable knowledge is recorded even when the agent never calls `remember`; dedupe via content-hash ids. |
| D6 | **Two tools:** `remember` (agent-driven write) + `memory_search` (agent-driven read). | Single combined tool; user-facing UI. | Small, model-idiomatic surface mirroring `codegraph_explore` usage; no dedicated user UI beyond result rows. |
| D7 | **Blackhole-aware modes:** Mode 1 (present) reads blackhole artifacts and **never claims `session_before_compact`**; Mode 2 (absent) registers the hook for own capture. | Always own the compaction hook. | Verified coexistence constraint honored — blackhole breaks if another ext claims that hook/compaction; fallback keeps full function without blackhole. |
| D8 | **`nomic-embed-text`, 768-dim**, via local llama.cpp OpenAI-format server, Node global fetch. | Hosted embedding APIs (extra keys/cost); other local models. | Zero external keys; dimension fixed at 768; same model as the user's zoo-code install; per-model score default ≈0.15–0.2. |
| D9 | **User-provisioned Qdrant on `localhost:6333` via REST** (default URL; API key optional). | In-process/embedded vector store; Qdrant Edge in-process; gRPC. | Standard, well-documented Qdrant surface; user runs/starts Qdrant. REST chosen as the documented transport for this extension. Qdrant Edge is noted as a future in-process option, not designed here. |
| D10 | **pi package** (npm/git; `package.json` → `"pi": { "extensions": [...] }`), zero-dependency internal module, `.pi/extensions/` auto-load fallback, in-process runtime. | Vendor into pi core; external service process. | Proper extension lifecycle; no runtime deps; factory starts no background resources (defer to `session_start`, cleanup `session_shutdown`). |
| D11 | **Single unnamed vector, Cosine, `on_disk`, HNSW; dimension drift ⇒ recreate collection.** | Named/multi vectors; hybrid sparse+dense. | Matches the one-embedding-per-artifact need; model-switch cost (re-embed) accepted, per zoo-code prior art. |
| D12 | **Deterministic content-hash point ids for dedupe** across all ingest paths. | Random UUIDs per upsert. | Re-ingestion and repeated `remember` collapse to one point; idempotent writes. |
| D13 | **Config model: JSON canonical + TUI editor + env overrides.** `<agent-dir>/pi-qdrant-memory/pi-qdrant-memory-config.json` is the single source of truth (authoritative, portable, never hand-edited); `/qdrant settings` opens a `ctx.ui` form that reads/edits/persists it with runtime reload-on-save; `PI_QDRANT_*` env vars apply at load with precedence global → project → env. | Hand-edited INI / env-only configuration; config not stored in a portable file. | One canonical, portable artifact; the TUI form prevents hand-edit errors; env vars provide per-deployment overrides. |
| D14 | **Embeddings = generic OpenAI-compatible `/embeddings` endpoint** via global fetch — local llama.cpp running `nomic-embed-text` (768-dim) by default, with Ollama / any hosted OpenAI-compatible API optional — plus `expectedDimension` (768 default; auto-detect with warn-on-drift) and optional `embeddingApiKey`. | Locked to local llama.cpp; dimension implicit in the model choice. | Any OpenAI-compatible embedding server works (hosted models optional, key-gated); a different-dimension model triggers the destructive collection-recreate path (dimension-drift recreate, [§ 4.2](#42-vector-configuration)). |

---

## 9. References & Grounding

- **pi.dev (extensions / packages / compaction):**
  [pi.dev](https://pi.dev) — the extension contract (`"pi": { "extensions": [...] }`),
  `promptSnippet` / `promptGuidelines` wiring, `session_before_compact`, `session_start` /
  `session_shutdown` lifecycle, and the `.pi/extensions/` auto-load convention are per pi's
  documented extension/packages/compaction guidance recorded during validation. (See verification
  note below re: exact deep doc URLs.)
- **codegraph:** [github.com/colbymchenry/codegraph](https://github.com/colbymchenry/codegraph)
  (docs/repo) — exact/graph code structure, SQLite+FTS5, deliberately no embeddings.
- **pi-blackhole:** [github.com/k0valik/pi-blackhole](https://github.com/k0valik/pi-blackhole)
  (repo/docs/source) — Observer/Reflector/Dropper capture, `om.observations.recorded` /
  `om.reflections.recorded`, `Observation`/`Reflection` shapes, 12-char hex ids,
  `<sessionId>-pending.json`, `session_before_compact` ownership, `/compact` and
  `/blackhole-export`, lexical-only recall.
- **Zoo-code Qdrant deep-dive (prior art, in-repo read-only):**
  [`docs/research/2026-09-06 zoo-code qdrant vector-db deep-dive.md`](docs/research/2026-09-06%20zoo-code%20qdrant%20vector-db%20deep-dive.md:1)
  — `ws-<sha>` collection naming, single/dim-drift recreate, per-model score thresholds (nomic
  ≈ 0.15), payload keyword indexes, `localhost:6333`, REST transport details.
- **Qdrant server facts (in-repo read-only):**
  [`references/qdrant/README.md`](references/qdrant/README.md:1) and
  [`references/qdrant/src/startup.rs`](references/qdrant/src/startup.rs:1) — REST on `:6333`,
  gRPC on `:6334`; collections/points/payloads; named & single vectors; HNSW; payload filtering;
  snapshots; server-side inference under [`src/common/inference`](references/qdrant/src/common/inference);
  Qdrant Edge in-process option (noted as a future option, not designed).

### Verification date & sources note

Facts in this spec were verified on **2026-09-06 / 2026-09-07** against: the in-repo read-only
deep-dive [`docs/research/2026-09-06 zoo-code qdrant vector-db deep-dive.md`](docs/research/2026-09-06%20zoo-code%20qdrant%20vector-db%20deep-dive.md:1)
(git HEAD `4140c2c83`, three cross-verified research agents); the in-repo read-only
[`references/qdrant`](references/qdrant/README.md:1) Qdrant server tree; and the live
`codegraph` / `pi-blackhole` repositories. This authoring environment is offline (no git/node/npm)
and has no internet access, so the exact deep pi.dev documentation URLs were recorded as
conceptual references during the validation brainstorm; the implementing team should confirm the
canonical pi.dev doc URLs when they run in the full environment. Design content — the subject of
this document — is fully specified and does not depend on those URLs.

---

## Appendix A — Blackhole `om.*` entry schema (for parsing)

Parsing targets in Mode 1. Fields marked *recorded* are present in the source as documented;
parse defensively (missing optional fields tolerated, invalid entries logged and skipped).

**Custom session entry kinds**

- `om.observations.recorded` → `Observation`
- `om.reflections.recorded` → `Reflection`

**Observation**

```jsonc
{
  "id": "12-char-hex",
  "content": "text of the observation",
  "timestamp": "ISO-8601 or epoch ms",
  "relevance": 0.0,                 // number; parse-tolerant of null/missing
  "sourceEntryIds": ["12-char-hex"], // ids this observation derives from (may be empty)
  "tokenCount": 123                 // parse-tolerant of null/missing
}
```

**Reflection**

```jsonc
{
  "id": "12-char-hex",
  "content": "text of the reflection",
  "supportingObservationIds": ["12-char-hex"],
  "tokenCount": 123
}
```

**Per-session pending artifact**

- Path: `~/.pi/agent/pi-blackhole/<sessionId>-pending.json` (honors `PI_CODING_AGENT_DIR`).
- Contents: pending (not-yet-dropped) observations/reflections for one session, keyed by session.

**Mapping to points**

| Blackhole artifact | `source_kind` | `type` suggestion | `source_entry_id` | `session_id` |
| --- | --- | --- | --- | --- |
| `Observation` | `blackhole_observation` | derived from content (default `fact`) | `observation.id` | artifact's session |
| `Reflection` | `blackhole_reflection` | derived from content (default `decision`) | `reflection.id` | artifact's session |
