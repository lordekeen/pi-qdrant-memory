# pi-qdrant-memory

Semantic, cross-session/cross-project retrieval over durable conversation knowledge for pi.dev, backed by Qdrant.

Complements the ecosystem: `codegraph` = current code structure (exact/graph); `pi-blackhole` = durable decision
capture (lexical recall); **this extension = semantic retrieval** over that durable knowledge.

- **`remember`** (agent tool) — persist a durable decision/constraint/preference.
- **`memory_search`** (agent tool) — semantic search of prior durable knowledge.
- **`/qdrant`** command family — `status`, `settings`, `remember`, `search`, `clear`, `help`.
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
(honors `PI_CODING_AGENT_DIR`). The file is canonical and portable — edit it via `/qdrant settings`, not by
hand. If absent, the defaults below apply (zero-config run).

| Key | Default | Meaning |
| --- | --- | --- |
| `qdrantUrl` | `http://localhost:6333` | Qdrant REST base URL |
| `qdrantApiKey` | `null` | Optional Qdrant API key |
| `embeddingBaseURL` | `http://localhost:8080/v1` | OpenAI-compatible `/embeddings` endpoint |
| `embeddingModel` | `nomic-embed-text` | Embedding model id |
| `embeddingApiKey` | `null` | Optional key for hosted embedding APIs |
| `expectedDimension` | `768` | Embedding dimension; dimension drift recreates the collection |
| `scoreThreshold` | `0.18` | Search score threshold (per-model; nomic ≈ 0.15–0.2) |
| `maxResults` | `10` | Default `memory_search` limit |
| `mode` | `auto` | `auto` detect \| `blackhole` force Mode 1 \| `own` force Mode 2 |

Env overrides at load, precedence defaults → file → env:
`PI_QDRANT_URL`, `PI_QDRANT_API_KEY`, `PI_QDRANT_EMBEDDING_BASE_URL`, `PI_QDRANT_EMBEDDING_MODEL`,
`PI_QDRANT_EMBEDDING_API_KEY`, `PI_QDRANT_EXPECTED_DIMENSION`, `PI_QDRANT_SCORE_THRESHOLD`,
`PI_QDRANT_MAX_RESULTS`, `PI_QDRANT_MODE`.

## Commands

`/qdrant status` — connection health + active mode + collection point count.
`/qdrant settings [key value]` — persist a config field (TUI settings form is a future shell on the same
`writeConfig` path).
`/qdrant remember <text>` — manual durable save.
`/qdrant search <query>` — manual semantic search.
`/qdrant clear` — reset the current project's collection.
`/qdrant help` — this list.

## Agent tools

- `remember(text, type?)` — persist a durable decision/constraint/preference. Type defaults to `decision`.
- `memory_search(query, type?, limit?)` — semantic search of prior durable knowledge (limit capped by `maxResults`).

## Modes

- **Mode 1 (pi-blackhole present, coexistence):** reads pi-blackhole's pending durable artifacts
  (`<agent-dir>/pi-blackhole/*-pending.json`) and ingests them at `session_start` (catch-up) and
  `session_shutdown`. It **never** claims the `session_before_compact` hook.
- **Mode 2 (pi-blackhole absent):** claims `session_before_compact` and captures pi's own compaction
  summary (from the `session_compact` event) as a `session_summary` point — fire-and-forget so capture can
  never stall compaction. `/qdrant remember` is the manual safety net.

An early-session auto snapshot (spec §3.3 safety net) is not yet wired: it needs mid-session content
distillation access this extension does not currently have, so Mode 2's safety nets are the compaction
capture and `/qdrant remember`.

## Data model (summary)

One Qdrant collection per project, named `pi-mem-<16 hex of sha256(git root)>`; single unnamed vector,
Cosine, `on_disk`, HNSW. Points carry `{ type, text, project_id, session_id?, source_entry_id?, ts,
source_kind }`; keyword payload indexes on `type` and `project_id`. Deterministic point ids
(`sha256(normalized text | source_kind | context)`) make every write idempotent.

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
