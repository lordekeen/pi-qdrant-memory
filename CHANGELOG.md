# Changelog

All notable changes to this project are documented in this file. Versions
follow [semantic versioning](https://semver.org/); releases are cut
automatically from [conventional commits](https://www.conventionalcommits.org/)
by [release-please](.github/workflows/release-please.yml).

## [0.2.1](https://github.com/lordekeen/pi-qdrant-memory/compare/v0.2.0...v0.2.1) (2026-09-11)


### Bug Fixes

* raise default codeScoreThreshold from 0.4 to 0.55 ([5123222](https://github.com/lordekeen/pi-qdrant-memory/commit/51232229d8a05660b52fdbb8b111efe5532dd53f))
* show the file path for file-level code summaries ([22be140](https://github.com/lordekeen/pi-qdrant-memory/commit/22be140dd4a606302ce914c5a3739ebdfafcd9fb))
* tool errors name the invoked tool exactly once ([b973c08](https://github.com/lordekeen/pi-qdrant-memory/commit/b973c08f13745cdb3014929c357e005480e9d4a1))

## [0.2.0](https://github.com/lordekeen/pi-qdrant-memory/compare/v0.1.0...v0.2.0) (2026-09-11)


### Features

* batch embeddings for code-memory sync (phase 3) ([c410f74](https://github.com/lordekeen/pi-qdrant-memory/commit/c410f74b6e47acfd6211a5bbb7d5d725c88228ce))
* code_memory tool, index-code command, sync wiring, flip notice (phase 6) ([afbe85b](https://github.com/lordekeen/pi-qdrant-memory/commit/afbe85b7f456c2f56eaced0faeb73943f1243fc6))
* code-memory config groundwork (phase 1) ([292ec77](https://github.com/lordekeen/pi-qdrant-memory/commit/292ec7798a1eaf414dce36c0fe7d9f3aa4611255))
* code-memory sync engine (phase 5) ([a89ae3d](https://github.com/lordekeen/pi-qdrant-memory/commit/a89ae3d2677f77552a199a81b8812baeb936e299))
* qdrant surface for code-memory sync (phase 2) ([a02d6ac](https://github.com/lordekeen/pi-qdrant-memory/commit/a02d6acd6e871c323f2933b5670d2a808630221c))
* standalone structural code extractor (phase 4) ([561fe86](https://github.com/lordekeen/pi-qdrant-memory/commit/561fe86bfe5c44b716cbecf2cd2ef4dc104a276d))


### Bug Fixes

* code sync deleted every point it had just written ([4c483de](https://github.com/lordekeen/pi-qdrant-memory/commit/4c483dee458c1432e87f2e3bf8a45c0e8bd77456))
* code-memory review fixes (live-verified defects) ([c8a4f95](https://github.com/lordekeen/pi-qdrant-memory/commit/c8a4f950e55b9858121bd90552e13953824e79fa))
* mark pi-bundled peers optional; regenerate lockfile ([bb1541e](https://github.com/lordekeen/pi-qdrant-memory/commit/bb1541ec01ced62634c0a1171f13b2aa09bf8242))
* sync lockfile with peerDependencies; make renderer-seam test env-agnostic ([012176d](https://github.com/lordekeen/pi-qdrant-memory/commit/012176d81457edbbe2eee3fa8f2e49259396d97e))

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
