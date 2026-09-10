# Changelog

All notable changes to this project are documented in this file. Versions
follow [semantic versioning](https://semver.org/); releases are cut
automatically from [conventional commits](https://www.conventionalcommits.org/)
by [release-please](.github/workflows/release-please.yml).

## [0.1.0] - 2026-09-10

### Added

- `memory_save` / `memory_search` agent tools over a per-project Qdrant
  collection, with deterministic content-hash point ids (idempotent writes).
- Mode 1 (pi-blackhole pending-artifact ingest at session start/shutdown) and
  Mode 2 (own compaction-summary capture), auto-detected or forced via config.
- `/qdrant-status`, `/qdrant-settings` (interactive form + CLI), `/qdrant-remember`,
  `/qdrant-search`, `/qdrant-clear`, `/qdrant-help` — structured TUI entries,
  never LLM-context output.
- Footer statusline: `🧠 Memory (N): <mode> (<collection>)` with live mode
  resolution and repaint on every successful save/clear.
- Hot config reload on settings writes; graceful degradation everywhere
  (bounded requests, typed error statuses, best-effort statusline).
- Zero runtime dependencies; pi-bundled `@earendil-works/*` modules consumed
  via lazy dynamic imports.
