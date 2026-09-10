# pi-qdrant-memory

Semantic, cross-session/cross-project retrieval over durable conversation knowledge for pi.dev, backed by Qdrant.

Complements the ecosystem: `codegraph` = current code structure (exact/graph); `pi-blackhole` = durable decision
capture (lexical recall); **this extension = semantic retrieval** over that durable knowledge.

- **`memory_save`** (agent tool) — persist a durable decision/constraint/preference.
- **`memory_search`** (agent tool) — semantic search of prior durable knowledge.
- **`code_memory`** (agent tool, opt-in) — semantic search of indexed code-structure summaries
  (enabled via `codeKnowledge: "on"`; see [Code memory](#code-memory-opt-in)).
- **`/qdrant-*`** command set — `qdrant-status`, `qdrant-settings`, `qdrant-remember`, `qdrant-search`, `qdrant-clear`, `qdrant-help`,
  plus `qdrant-index-code` when code memory is on.
  Each is a unique single-token pi command (no subcommand parsing): `/qdrant-status`, `/qdrant-settings <key> <value>`, …
- Mode-aware: with pi-blackhole installed it ingests blackhole's durable artifacts; without it, it captures
  pi's own compaction summary as a `session_summary`.

All writes are idempotent (deterministic content-hash point ids). Unreachable Qdrant/embeddings degrade
gracefully — tools report the problem and never crash the session.

## Install

```bash
pi install npm:pi-qdrant-memory   # or: pi install git:github.com/<you>/pi-qdrant-memory
```

Quickstart (no package publish): drop `src/index.ts` into `.pi/extensions/`.

Runtime is in-process; no background resources are started by the factory (all lifecycle work happens on
`session_start` / compaction events / `session_shutdown`).

## Prerequisites

- Node >= 22.19 (native TypeScript type-stripping).
- A running Qdrant server — default `http://localhost:6333` (REST).
- An OpenAI-compatible `/embeddings` endpoint — default a local llama.cpp OpenAI-format server running
  `nomic-embed-text` (768-dim). Ollama or any hosted OpenAI-compatible API also work (set `embeddingApiKey`).

## Config

Single source of truth: `~/.pi/agent/pi-qdrant-memory/pi-qdrant-memory-config.json`
(honors `PI_CODING_AGENT_DIR`). The file is canonical and portable — edit it via `/qdrant-settings`, not by
hand. If absent, the defaults below apply (zero-config run).

| Key | Default | Meaning |
| --- | --- | --- |
| `qdrantUrl` | `http://localhost:6333` | Qdrant REST base URL |
| `qdrantApiKey` | `null` | Optional Qdrant API key |
| `embeddingBaseURL` | `http://localhost:8080/v1` | OpenAI-compatible `/embeddings` endpoint |
| `embeddingModel` | `nomic-embed-text` | Embedding model id |
| `embeddingApiKey` | `null` | Optional key for hosted embedding APIs |
| `expectedDimension` | `768` | Embedding dimension (positive integer); dimension drift recreates the collection |
| `scoreThreshold` | `0.18` | Search score threshold, 0–1 (per-model; nomic ≈ 0.15–0.2) |
| `maxResults` | `10` | Default `memory_search` limit |
| `mode` | `auto` | `auto` detect \| `blackhole` force Mode 1 \| `own` force Mode 2 |
| `codeKnowledge` | `off` | `on` enables structural code summaries + the `code_memory` tool (next session) |
| `codeScoreThreshold` | `0.4` | Score threshold for `code_memory` searches, 0–1 |

Env overrides at load, precedence defaults → file → env:
`PI_QDRANT_URL`, `PI_QDRANT_API_KEY`, `PI_QDRANT_EMBEDDING_BASE_URL`, `PI_QDRANT_EMBEDDING_MODEL`,
`PI_QDRANT_EMBEDDING_API_KEY`, `PI_QDRANT_EXPECTED_DIMENSION`, `PI_QDRANT_SCORE_THRESHOLD`,
`PI_QDRANT_MAX_RESULTS`, `PI_QDRANT_MODE`, `PI_QDRANT_CODE_KNOWLEDGE`, `PI_QDRANT_CODE_SCORE_THRESHOLD`.

## Commands

`/qdrant-status` — connection health + active mode + collection point count.
`/qdrant-settings <key> <value>` — persist a config field (`mode`, `codeKnowledge`, `embeddingBaseURL`, `embeddingModel`,
`expectedDimension`, `scoreThreshold`, `codeScoreThreshold`, `maxResults`). Bare `/qdrant-settings` prints usage.
`/qdrant-remember <text>` — manual durable save.
`/qdrant-search <query>` — manual semantic search.
`/qdrant-index-code` — re-index code summaries now (only when `codeKnowledge: on`).
`/qdrant-clear` — reset the current project's collection.

The config file stores API keys and is written with owner-only permissions
(`0600`).

## Statusline

While a session is active the extension shows a footer status entry:
`🧠 Memory (N): <mode> (<collection>)` — `N` is the number of memories stored
in the project collection, refreshed at session start and after every
successful save/clear. When Qdrant is unreachable the count is omitted.
`/qdrant-help` — this list.

## Agent tools

- `memory_save(text, type?)` — persist a durable decision/constraint/preference. Type defaults to `decision`.
- `memory_search(query, type?, limit?)` — semantic search of prior durable knowledge (limit capped by `maxResults`).
- `code_memory(query, limit?)` *(opt-in)* — semantic search of indexed code-structure summaries.

The tools carry always-on prompt guidance (via `promptSnippet`/`promptGuidelines`): the model is nudged to call
`memory_save` when a decision/constraint/preference settles (with concise, self-contained statements, without
re-recording what auto-capture covers) and to call `memory_search` when resuming prior work or before re-deciding.
No companion skill is needed for the core loop — the guidance ships with the tools.

## Code memory (opt-in)

With `codeKnowledge: "on"`, the extension scans the repo at `session_start` (fire-and-forget) and
indexes **structural summaries** of top-level definitions — exported functions/classes/types,
Python defs, per-file anchors — as `code` points in the same collection. Zero dependencies: the
extractor is built in; no external indexer is used.

- **Freshness:** payloads carry `file_path` + `file_sha`; unchanged files are skipped,
  changed files are deleted-and-replaced, vanished files are cleaned up. `/qdrant-index-code`
  forces a resync.
- **Retrieval:** the `code_memory` tool (registered only while enabled) searches code summaries
  at `codeScoreThreshold`; `memory_search` never returns code hits.
- **Mid-session flips** take effect at the next session start (the settings output reminds
  you); only indexing can be run immediately via `/qdrant-index-code`.

## Modes

- **Mode 1 (pi-blackhole present, coexistence):** reads pi-blackhole's pending durable artifacts
  (`<agent-dir>/pi-blackhole/*-pending.json`) and ingests them at `session_start` (catch-up) and
  `session_shutdown`. It **never** claims the `session_before_compact` hook.
- **Mode 2 (pi-blackhole absent):** claims `session_before_compact` and captures pi's own compaction
  summary (from the `session_compact` event) as a `session_summary` point — fire-and-forget so capture can
  never stall compaction. `/qdrant-remember` is the manual safety net.

An early-session auto snapshot (spec §3.3 safety net) is not yet wired: it needs mid-session content
distillation access this extension does not currently have, so Mode 2's safety nets are the compaction
capture and `/qdrant-remember`.

## Data model (summary)

One Qdrant collection per project, named `pi-mem-<16 hex of sha256(git root)>`; single unnamed vector,
Cosine, `on_disk`, HNSW. Points carry `{ type, text, project_id, session_id?, source_entry_id?, ts,
source_kind }` plus code-provenance fields on code points (`file_path`, `file_sha`, `symbol`,
`start_line`, `end_line`); keyword payload indexes on `source_kind` and `file_path`.
Deterministic point ids (`sha256(normalized text | source_kind | context)`) make every write idempotent.

## Development

Zero runtime npm dependencies (Node global `fetch` + `crypto` only). TypeScript is erasable-syntax only and
runs directly via Node's type stripping — no build step.

```bash
npm test          # node --test over test/**/*.test.ts
npm run typecheck # tsc --noEmit (needs devDependencies installed)
```

Opt-in end-to-end smoke test (requires real Qdrant on `:6333` and an OpenAI-compatible embeddings server):
`QDRANT_MEMORY_SMOKE=1 npm run test:smoke`. Server endpoints are overridable via `QDRANT_MEMORY_URL`,
`QDRANT_MEMORY_EMBED_URL`, `QDRANT_MEMORY_EMBED_MODEL`, and `QDRANT_MEMORY_EMBED_DIM`.
