# AGENTS.md — working in pi-qdrant-memory

Guidance for coding agents (and humans) making changes to this repository.
Read [README.md](./README.md) for the product, [DESIGN.md](./DESIGN.md) for the
extension's UI/interaction contract, and `docs/specs/` (design + implementation
plan + plan review) for the original intent and decision log.

## What this is

A **pi.dev extension** (TypeScript, no build step) giving the pi agent semantic,
cross-session/cross-project retrieval over durable conversation knowledge. It
embeds knowledge text into a per-project Qdrant collection and exposes it to the
agent via two tools (`memory_save`, `memory_search`) and to the human via the
`/qdrant-*` command set.

## Commands (run these before claiming anything works)

```bash
npm run typecheck        # tsc --noEmit (strict, erasableSyntaxOnly)
npm test                 # node --test test/**/*.test.ts  (unit; no services needed)
npm run test:smoke       # opt-in live E2E — needs Qdrant + an embeddings server + QDRANT_MEMORY_SMOKE=1
```

`npm test` must be green and `npm run typecheck` clean before you commit. Do not
skip the typecheck: `erasableSyntaxOnly` + `verbatimModuleSyntax` catch real
runtime issues that tests miss. The smoke test is skipped by default; run it only
when you change ingest/search/embedding paths and have both servers up.

## Non-negotiables (project invariants)

1. **Zero runtime dependencies.** Only Node built-ins (`node:fs`, `node:http`,
   …) and what pi's loader aliases for extensions at runtime. In practice that
   means: tool `parameters` are plain JSON-Schema objects (no TypeBox import),
   and TUI components come from `@earendil-works/pi-tui` via a **lazy dynamic
   import** (see `src/pi-tui.d.ts` — the ambient shim exists so `tsc` passes
   without the package installed; pi aliases it at runtime, mirroring pi-ketch).
   Do not add an npm dependency without a strong reason and a note in README.
2. **Erasable TypeScript only.** No enums, no parameter properties, no
   namespaces, no `experimentalDecorators`. `verbatimModuleSyntax` means type-only
   imports must use `import type`. Relative imports carry the `.ts` extension
   (`import { x } from "./y.ts"`).
3. **No output via `sendMessage`.** Slash-command output goes through
   `pi.appendEntry` + a registered entry renderer — visible in the TUI, excluded
   from the LLM context. `sendMessage`'s `display` flag only gates rendering; the
   content still reaches the model. (This was a real bug; see git history.)
4. **Unique single-token commands.** Every command is `/qdrant-<verb>` with no
   subcommand parsing — pi resolves the first token as the command name. Do not
   introduce `"/qdrant status"`-style multi-token names.
5. **Idempotent writes.** Point ids are deterministic content hashes
   (`src/ids.ts`). Re-ingesting the same artifact is a no-op. Keep it that way.
6. **Graceful degradation.** Unreachable Qdrant or embeddings must produce a
   reportable error, never a crash or a thrown lifecycle handler.
7. **No background resources in the factory.** All network/lifecycle work happens
   on `session_start` / compaction events / `session_shutdown` handlers.

## Architecture map

| File | Role |
| --- | --- |
| `src/index.ts` | Entry (factory default export). `wireApi()` registers tools, `/qdrant-*` commands, and mode-dependent lifecycle hooks over a structural `WireApi`; the real `factory` adapts the pi `ExtensionAPI` into that seam (commands → entries, `ctx.ui` capture, entry renderer, lazy pi-tui). |
| `src/handlers.ts` | Slash-command handlers (status/settings/remember/search/clear/help) + `runSettingsForm` (interactive `ctx.ui` flow). All IO via `HandlerIO` (live getters over the runtime); output is `emit(e)` — one structured `OutEntry` per command.
| `src/out.ts` | Typed entry-output model: `OutEntry` builders, `renderOut` (single source of content + style roles), `outText` (plain projection). Pure — no pi imports, fully unit-tested.
| `src/config.ts` | `DEFAULTS`, `loadConfig` (defaults → file → env precedence), `writeConfigFile`, `isConfigMode`, `setConfigField` (shared validation, CLI + form). |
| `src/mode.ts` | Runtime mode resolution: `detectBlackhole`, `resolveMode` (mode1 = blackhole present; mode2 = own capture), `agentDirFromEnv`. |
| `src/project.ts` | `projectIdFrom` — hashes the nearest git root realpath → `pi-mem-<16hex>`. |
| `src/qdrant.ts` | `QdrantClient` (REST) + `QdrantLike` interface (test seam). |
| `src/embeddings.ts` | `EmbeddingClient` — OpenAI-compatible `/embeddings`, dimension checks. |
| `src/ids.ts` | `normalizeText`, `contentHash`, `pointId` (deterministic ids). |
| `src/blackhole.ts` | Read pi-blackhole pending artifacts (Mode 1) — `parseOmEntry`, `readPendingArtifacts`. |
| `src/ingest.ts` | `ingestItems` batch upsert + `artifactToIngestItem`. |
| `src/tools-core.ts` | `rememberLogic`, `memorySearchLogic` — shared by tools and commands; take `ToolDeps` (no output channel). Code queries (`type: "code"`) search at `codeScoreThreshold`. |
| `src/capture.ts` | Mode 2: `captureAtCompaction` (compaction summary → session_summary point), `autoSnapshot`. |
| `src/codescan.ts` | Standalone structural code extractor (opt-in, zero-dep): repo walk + per-language line matchers → deterministic per-symbol/per-file summaries. |
| `src/code-sync.ts` | `syncCodeKnowledge` — scan → Qdrant snapshot (file_path→file_sha) → per-file diff → delete-by-file_path → batched embed/upsert. Never throws; Qdrant is the cache. |
| `src/render.ts` | Tool-path text blocks (`renderHits` + `sourcePointer`), LLM-facing — deliberately outside the entry UI. |
| `src/entry-render.ts` | Lazy pi-tui renderer: maps an `OutEntry` (via `renderOut` roles) to one multi-line `Text` + `keyHint` (only collapsed search summaries expand). No Box/card machinery — status renders unboxed like every entry. `RendererOptions.TextCtor` is the unit-test seam. |
| `src/deps.ts` | `makeRuntime` (assembles cfg + clients + handlers IO), `applyConfig` (hot reload after settings writes). |
| `src/types.ts` | Shared types: `Config`, `MemoryType`, `SourceKind`, `PointPayload`, `SearchHit`, `RuntimeDeps`, `ToolDeps`. |
| `src/pi-tui.d.ts` | Ambient types for the lazy `@earendil-works/pi-tui` import. |
| `src/pi-coding-agent.d.ts` | Ambient types for the lazy `@earendil-works/pi-coding-agent` import (`keyHint`). |
| `test/*.test.ts` | One test file per module, `node:test` + `node:assert/strict`. `integration.smoke.test.ts` is opt-in. |
| `docs/specs/` | Original design doc, implementation plan, plan review. |

## Wiring pattern (when you add a feature)

- **Adding a tool**: define it in `wireApi` (`src/index.ts`) with plain
  JSON-Schema `parameters`, `promptSnippet`, and `promptGuidelines`; put the logic
  in `tools-core.ts` (typed against `ToolDeps` — never the full `RuntimeDeps`) so
  tools and commands share it. Feature-gated tools (`code_memory`, gated on
  `cfg.codeKnowledge`) register conditionally and are session-fixed exactly like
  lifecycle hooks — a mid-session settings flip takes effect on reload, and the
  settings output says so.
- **Adding a command**: add a single-token def to the `commands` array in
  `wireApi` (name `qdrant-<verb>`, `execute(args: string)`), implement the
  handler in `handlers.ts`, emit one structured entry through `io.emit(...)`
  (builders + role rules live in `src/out.ts`; DESIGN.md owns the strings), add
  it to `helpHandler`, register a test in `test/handlers.test.ts` and assert
  registration in `test/index.test.ts` and `test/factory.test.ts`.
- **Changing config**: update `Config` in `types.ts`, `DEFAULTS`+`loadConfig`
  precedence in `config.ts`, and `SETTING_FIELDS` in `handlers.ts` so the form
  covers it. Validation goes in `setConfigField` — CLI and form share it.
- **Changing output text**: consult `DESIGN.md` first (exact strings, glyphs,
  role slots, collapse/expand, error rows). Content + per-line roles go in
  `src/out.ts` (`renderOut` is the single source of truth and is unit-tested
  without pi-tui); `src/entry-render.ts` only maps roles → host-theme slots.

## Environment & config for tests

Config file: `~/.pi/agent/pi-qdrant-memory/pi-qdrant-memory-config.json`
(honors `PI_CODING_AGENT_DIR`). Env overrides: `PI_QDRANT_URL`,
`PI_QDRANT_API_KEY`, `PI_QDRANT_EMBEDDING_BASE_URL`, `PI_QDRANT_EMBEDDING_MODEL`,
`PI_QDRANT_EMBEDDING_API_KEY`, `PI_QDRANT_EXPECTED_DIMENSION`,
`PI_QDRANT_SCORE_THRESHOLD`, `PI_QDRANT_MAX_RESULTS`, `PI_QDRANT_MODE`.

Unit tests never need servers: they inject fake `embed`/`QdrantLike` and a fake
`WireApi`. Only the smoke test needs real Qdrant (default `:6333`) and an
OpenAI-compatible embeddings endpoint (defaults `:8080/v1`, `nomic-embed-text`,
768-dim — point `QDRANT_MEMORY_EMBED_*` at any equivalent server).

## Testing conventions

- One test file per module; pure logic tested directly with fake IO.
- `wireApi` is tested through a fake `WireApi` (registration, lifecycle hooks,
  cleanup).
- `factory` is tested against a minimal fake of the real pi `ExtensionAPI`
  (tools/commands registered, entries+renderer used for output, hooks wired).
- Human-visible output is asserted on the fake's entry/message list.
- Behavior that touches `ctx.ui` (settings form) is tested through a scripted
  `SettingsUI` fake (happy path, Esc-cancel, invalid input, declined confirm).
- Prefer behavior tests over mock-heavy tests; keep mocks structural.

## Definition of done

1. `npm run typecheck` clean, `npm test` fully green (no new skips unless
   intentional + documented).
2. New behavior has tests; changed output strings are reflected in any test that
   asserts them.
3. README (commands/config/tools) and DESIGN.md (output/flows) updated when the
   human-facing surface changes.
4. If a bug is fixed, the commit message says what was wrong and why the fix is
   right (the `display:false` → entries fix is the canonical example).

## Commit conventions

Small, focused commits. Imperative present-tense subject; optional
`feat: / fix: / refactor: / docs: / test: / ui:` prefix. One logical change per
commit. Commit only after typecheck+tests pass (see `verification-before-completion`).

## Releasing

Two workflows in `.github/workflows/`: `release-please.yml` (automatic) and
`publish-manual.yml` (on demand). Publishing is **staged**: CI submits the
version without 2FA, a maintainer approves with 2FA, and only then is it live.

1. `release-please` maintains a release PR from conventional commits (version
   bump + `CHANGELOG.md`).
2. Merging that PR creates the GitHub release and tag — **the merge alone does
   not publish to npm**; nothing is live yet.
3. Creating the release triggers the `publish` job, which stages the new
   version with `npm stage publish` (no 2FA in CI).
4. A maintainer approves with 2FA — `npm stage approve <stage-id>`, or
   npmjs.com -> Staged Packages tab -> Approve — and only then is it live.

- `NPM_TOKEN` (repo secret) is a **staging-capable granular token** — correct
  and intentional. Do not "fix" it into a direct-publish token; staging is the
  intended flow, not a workaround.
- The publish job must run on **Node 24**: `npm stage publish` needs npm CLI
  >= 11.15.0, and Node 22 bundles npm 10.x (Node 24 bundles npm 11.x).
- `manual-publish` (`gh workflow run manual-publish`) stages the current `main`
  version on demand — that is how 0.2.0 was staged.
- Before claiming a release shipped: `npm view pi-qdrant-memory version` must
  show the new version. A successful staging run is not a publish.
- General mechanics (staged publishing, version floors, GitHub Actions
  failures): the `npm-release-automation` skill.
