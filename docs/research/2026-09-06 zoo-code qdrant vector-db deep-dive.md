---
type: session-handoff
date: 2026-09-06
project: zoo-code
tags: [zoo-code, qdrant, vector-database, code-index, embeddings, roo-code, codebase-search]
---

# Session Note — Zoo-Code: how Qdrant / the vector database works

Read-only codebase deep dive (no code changed). Repo: `/home/jhonny/Sources/Zoo-Code` (Roo-Code–style VS Code extension fork, Zoo-Code-Org/Zoo-Code), verified against `git HEAD` `4140c2c83`. Findings produced by three parallel research agents (Qdrant-client internals / indexing write-path / search read-path); all claims cross-verified against the clean working tree.

## What this feature is

Opt-in **codebase memory / semantic code search** under `src/services/code-index/`. Three stages:

1. **Index** the workspace: parse source files into AST-based code chunks, embed each chunk with a chosen embedding model, store vectors in **Qdrant** — one isolated collection per workspace.
2. **Keep fresh**: a file watcher incrementally re-embeds/deletes chunks as you edit.
3. **Serve search**: an agent-callable `codebase_search` tool embeds the query and retrieves nearest chunks (file, line range, code text, cosine score) as model context — a semantic complement to the regex-based `search_files` tool.

Qdrant is **one backend**. Alternative provider **semble** downloads a small Rust binary that embeds *and* stores/indexes vectors itself — completely bypasses Qdrant (see [[#Semble]]). Everything else = the Qdrant path.

## The vector-store seam

- **Interface** `src/services/code-index/interfaces/vector-store.ts`: `IVectorStore` (`initialize`, `upsertPoints`, `search`, `deletePointsByFilePath/MultipleFilePaths`, `clearCollection`, `deleteCollection`, `collectionExists`, `hasIndexedData`, `markIndexingComplete/Incomplete`). Point shape: `{ id, vector: number[], payload: { filePath, codeChunk, startLine, endLine, … } }`.
- **Only production implementation**: `QdrantVectorStore` in `src/services/code-index/vector-store/qdrant-client.ts` (684 lines) wrapping `@qdrant/js-client-rest ^1.14.0` (`src/package.json:469`).

## Qdrant schema, in Qdrant terms

- **Connection** (`qdrant-client.ts:27–88`): user URL or bare hostname normalized (`parseQdrantUrl`/`parseHostname`); client built host-based with explicit port (**443 if https, else 80**), optional `prefix` from a URL path, optional `apiKey`, custom `User-Agent: Zoo-Code`. No timeouts/retries on the client — retries live one layer up (3 attempts, exponential backoff, `constants/index.ts:46`).
- **Collection per workspace** (`:80–83`): name = `ws-` + first 16 hex of `sha256(workspacePath)`. Moving the workspace folder ⇒ brand-new empty collection.
- **Creation** (`initialize`, `:149–219`): vector size = embedding-model dimension, distance **Cosine**, `on_disk: true`, HNSW `m: 64, ef_construct: 512`. Unreachable Qdrant treated as “collection doesn't exist”; failures wrapped in localized *“Failed to connect to Qdrant vector database. Please ensure Qdrant is running and accessible at {{url}}…”* (`src/i18n/locales/en/embeddings.json:32`).
- **Dimension drift → destructive recreate** (`:222–295`): vector size mismatch ⇒ Qdrant **deletes and recreates the collection** (verify-deletion + sleep). Switching embedding-model dimensionality silently resets the index.
- **Payload keyword indexes** (`:298–336`): on `type` and `pathSegments.0`…`pathSegments.4` — only **5 path-segment levels indexed**; deeper directory filters still work but unaccelerated.
- **Points** (`upsertPoints`, `:338–383`): payload carries `filePath` (relative), `codeChunk`, `startLine`, `endLine`, `segmentHash`; the client splits `filePath` into `pathSegments: {"0":…, "1":…}`. One `upsert(…, { wait: true })` per batch — batching (60 segments, configurable) is the caller's job.
- **Index-complete bookkeeping** (`:587–683`) — Qdrant collections carry no user metadata, so completion state lives in a **sentinel point**: deterministic `uuidv5("__indexing_metadata__", fixed-namespace)` with a **zero vector** and payload `{ type: "metadata", indexing_complete: bool, started_at/completed_at }`. `hasIndexedData()` falls back to `points_count > 0` for backward compatibility when no sentinel exists. Every search excludes it via `must_not: type = metadata`, so the zero vector never pollutes top-k.
- **Search** (`:399–469`): newer `client.query` API with server-side `score_threshold` (minScore, default **0.4**), `limit` (default **50**), `hnsw_ef: 128, exact: false`, `with_payload` restricted to result fields. Directory filtering = per-segment **keyword equality** on `pathSegments.0..N` (`must` clauses), not a string-prefix match; `"." / "./" / ""` ⇒ no filter. Only malformed payloads (missing fields) are post-filtered.
- **Deletes** (`:478–543`): filter-delete matching `pathSegments`; multiple paths OR'd via `should`. Deletes deliberately non-throwing (errors logged). `clearCollection` = match-all delete; `deleteCollection` = REST endpoint (used by “Clear index” and config-driven re-indexes).
- **Tests as docs**: `vector-store/__tests__/qdrant-client.spec.ts` (1783 lines) mocks `@qdrant/js-client-rest` and locks in URL-parsing matrix (~20 cases), collection create / size-mismatch-recreate (incl. 2048→768), `pathSegments` enrichment, full search request shape + metadata-exclusion + directory filters, and constants wiring. Notably **untested**: the `markIndexingComplete`/`hasIndexedData` sentinel lifecycle and the delete/clear REST filters.

## Data in: the indexing (write) path

- **Entry**: per-workspace singleton `CodeIndexManager` (`manager.ts:36`) created at extension activation per workspace folder (`extension.ts:198–215`); if enabled + configured + workspace-enabled, indexing starts automatically in the background. Webview messages drive start/stop/clear/toggle (`webviewMessageHandler.ts:2999–3340`).
- **Full scan** (`orchestrator.ts`, `processors/scanner.ts`): files discovered via ripgrep `listFiles` (honors `.gitignore`), filtered by `.rooignore`, extension allowlist, 1 MB file cap, and a **sha256 content-hash cache** (`cache-manager.ts` → `<globalStorage>/roo-index-cache-<sha>.json`) that skips unchanged files.
- **Chunking** (`processors/parser.ts`): tree-sitter AST captures per function/class node → `CodeBlock` (min 50 chars; nodes over ~1150 chars descended into children or line-chunked). Markdown and fallback extensions chunk by lines. Deterministic `segmentHash` per block.
- **Embed + upsert** (`scanner.ts:389–471`): batches of 60 blocks at concurrency 10 → embedder (openai/ollama/gemini/mistral/bedrock/openrouter/openai-compatible/vercel-ai-gateway) → point `id = uuidv5(segmentHash, namespace)` → `upsertPoints`. Modified files have stale points deleted by path first; vanished files get delete-by-path.
- **Incremental** (`processors/file-watcher.ts`): `vscode.FileSystemWatcher` debounces edits; create → embed+upsert, change → delete-then-re-upsert, delete → delete-by-path. ⚠️ Watcher point IDs derive from `absPath:start_line` (not the scanner's `segmentHash`) and omit `segmentHash` — delete-by-path still cleans up, but latent duplicate risk.
- **State machine**: `Standby | Indexing | Indexed | Error | Stopping` (`state-manager.ts`), streamed to UI as `indexingStatusUpdate`. Only telemetry event: `CODE_INDEX_ERROR`.
- **Config changes**: any provider / API-key / base-URL / model-dimension / Qdrant-URL change ⇒ `doesConfigChangeRequireRestart` (`config-manager.ts:303–448`) true ⇒ services recreated + full re-index (collection recreation included).

## Data out: semantic search (read path)

- **`search-service.ts`**: gates on feature enabled/configured and state `Indexed` **or `Indexing`** (search during indexing allowed), embeds the query, then `vectorStore.search(vector, prefix, minScore, maxResults)`. Effective threshold priority: user setting → per-model profile score (ollama `nomic-embed-code` = 0.15; most = 0.4) → default 0.4; max results → default 50. Failures set state `Error` + telemetry.
- **`codebase_search` tool** (`src/core/tools/CodebaseSearchTool.ts`, schema in `prompts/tools/native-tools/codebase_search.ts`): params `{ query, path? }` — **no limit param** (maxResults from config). Belongs to the `read` tool group and is **removed from the model's tool list** whenever the feature is disabled/unconfigured/uninitialized (`filter-tools-for-mode.ts`). Empty results → literal text *"No relevant code snippets found…"*; otherwise `{filePath, score, startLine, endLine, codeChunk}` results are announced (`task.say("codebase_search_result", …)`) and pushed as a formatted text block for the model. **No lexical/grep fallback in-code** — regex `search_files` remains as the alternative.
- **UI**: search is **agent-driven only** — no user search box. `CodeIndexPopover` (`webview-ui/src/components/chat/CodeIndexPopover.tsx`) is a misnomer: it's the settings+status popover opened from the `Database` icon badge in the chat input toolbar (`IndexingStatusBadge.tsx`). Tool results render as collapsible rows; clicking one posts `openFile` with `line: startLine`.

## Settings

Not a SettingsView page — everything lives in the chat popover: enable toggle, provider select, per-provider key/base-URL/model, Qdrant URL + API key (hidden when semble selected), min-score (0–1) and max-results (10–200) sliders, per-workspace and auto-enable toggles. Persisted in VS Code globalState `codebaseIndexConfig` (`packages/types/src/codebase-index.ts`; defaults `DEFAULT_SEARCH_MIN_SCORE = 0.4`, `DEFAULT_SEARCH_RESULTS = 50`); `codeIndexQdrantApiKey` stored as a **secret**. Default Qdrant URL: `http://localhost:6333`.

## Semble

`SembleProvider` (`src/services/code-index/semble/provider.ts`) manages a **downloaded Rust binary** (`SEMBLE_VERSION v0.4.1`, `semble-downloader.ts:31`, SHA-verified from Zoo-Code-Org/sembleexec GitHub releases). Semble **embeds AND stores/indexes vectors itself** — no Qdrant, no API keys; indexes on-the-fly per `semble search` call, keeping its own on-disk cache; `startIndexing`/`stopIndexing` are near no-ops.

## Operational notes / gotchas

- **No in-repo Qdrant run guide** — no docker/compose anywhere; settings UI and error strings only say “ensure Qdrant is running and accessible”; “Learn more” links to external `https://docs.zoocode.dev/features/experimental/codebase-indexing`. Users must provision Qdrant themselves (or pick semble for zero-infra local indexing).
- Bare `http://host` (no port) resolves to **port 80**, not 6333 — the default works only because the config string includes `:6333`.
- Switching embedding models of a different dimension **silently wipes and rebuilds** the collection.
- The sentinel metadata point counts toward `points_count`, so a collection containing only the marker reports `hasIndexedData() === true`.
- Scanner vs watcher use **different point-ID schemes** (segmentHash-UUID vs path:start_line-UUID) — latent duplicate risk.
- The `qdrant` entry in `src/assets/marketplace/mcps.yml:2278` is a **separate thing**: a bundled Qdrant *MCP server* (“semantic memory layer”, mcp-server-qdrant) for users to add as an MCP tool — unrelated to the built-in code-index feature.

## Suggested reading order

`interfaces/vector-store.ts` → `vector-store/qdrant-client.ts` (+ its 1783-line spec) → `service-factory.ts:151` → `orchestrator.ts`/`scanner.ts` (write) → `search-service.ts` + `CodebaseSearchTool.ts` (read) → `CodeIndexPopover.tsx` (UX/settings).
