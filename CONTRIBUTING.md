# Contributing to pi-qdrant-memory

Thanks for wanting to contribute! This extension is a small, dependency-light pi
package — the whole point is that it stays easy to review, test, and reason
about. Please read [AGENTS.md](./AGENTS.md) (project invariants + architecture
map) and [DESIGN.md](./DESIGN.md) (UI/interaction contract) before changing code.
[README.md](./README.md) covers install, config, and the user-facing surface.

## Environment

- **Node >= 22.19** (native TypeScript type-stripping — no build step, no
  bundler). We develop on Node ≥ 24.
- **No runtime dependencies.** You should be able to `npm ci` with just
  `typescript` and `@types/node` as dev dependencies.
- For **live testing** you need:
  - a running **Qdrant** server (default `http://localhost:6333`, REST), and
  - an **OpenAI-compatible `/embeddings`** endpoint. The repo defaults to a local
    llama.cpp OpenAI-format server; on the dev machine that is
    `http://localhost:8081/v1` with model `nomic-embed-text-v1.5:Q8` (768-dim).
    Any compatible endpoint works — set `embeddingBaseURL` / `embeddingModel` /
    `embeddingApiKey` / `expectedDimension` accordingly.

The **unit tests need none of that** — they inject fakes. Only the opt-in smoke
test talks to real services.

## Setting up

```bash
git clone <repo-url> pi-qdrant-memory && cd pi-qdrant-memory
npm ci
npm run typecheck
npm test
```

### Live-testing inside pi

Install the local checkout so changes apply on `/reload` without re-installing:

```bash
pi install /absolute/path/to/pi-qdrant-memory   # records the path; loads live from the repo
```

Then in a pi session:

- `/qdrant-help` — command list
- `/qdrant-status` — health + mode + collection
- `/qdrant-settings` — interactive settings form (bare) or
  `/qdrant-settings <key> <value>` (direct write)
- `/qdrant-remember <text>` / `/qdrant-search <query>` — manual store/search
- `/qdrant-clear` — reset the current project's collection

The agent tools `memory_save` and `memory_search` are what most users exercise.

Notes for live testing:

- Command output renders through pi **entries** (visible, not in the model
  context). If you don't see output, check that the entry renderer registered —
  output is *not* sent via `sendMessage`.
- If your pi runs `pi-permission-system`, the new tools prompt for approval until
  allowlisted. Local dev allowlist:
  `"memory_search": "allow"`, `"memory_save": "allow"` in
  `~/.pi/agent/extensions/pi-permission-system/config.json`.
- Keep an eye on the footer: `🧠 Memory: mode1 (pi-mem-…)` means pi-blackhole was
  detected (Mode 1); `mode2` means own compaction capture.

### Smoke test (live E2E)

Only when you touched embedding/ingest/search paths **and** both servers are up:

```bash
QDRANT_MEMORY_SMOKE=1 \
  QDRANT_MEMORY_URL=http://localhost:6333 \
  QDRANT_MEMORY_EMBED_URL=http://localhost:8081/v1 \
  QDRANT_MEMORY_EMBED_MODEL=nomic-embed-text-v1.5:Q8 \
  QDRANT_MEMORY_EMBED_DIM=768 \
  npm run test:smoke
```

(`npm run test:smoke` itself sets `QDRANT_MEMORY_SMOKE=1`.) The smoke test reads
its **own** `QDRANT_MEMORY_*` env namespace to build throwaway clients — those
are independent of the extension's runtime `PI_QDRANT_*` envs and must be set
here to retarget the smoke run away from its file defaults (`:8080/v1`,
`nomic-embed-text`). The values above match the dev machine's live stack.

The smoke test remembers a phrase and searches it back with a paraphrased query.
It cleans up after itself. All other tests must stay green **without** servers.

## Making a change

1. Check for a task/todo item first; if the change is user-visible, confirm the
   intent (a short design note in the issue or PR helps).
2. Make small, focused commits (imperative present tense; optional
   `feat: / fix: / refactor: / docs: / test: / ui:` prefix).
3. **Run `npm run typecheck` and `npm test` and see them pass** before asking for
   review — no exceptions (the repo's `erasableSyntaxOnly` config makes
   typecheck a real gate).
4. Update the docs that describe what you changed:
   - behavior/commands/config → `README.md`
   - output text, prefixes, dialogs, flows → `DESIGN.md`
   - invariants/architecture → `AGENTS.md` (rarely)
5. When the change is ready, open a PR with a description that states the
   problem, the fix, and how it was verified (paste the test/typecheck output).

## Coding standards (the short version)

Full detail in `AGENTS.md`. The rules that matter most:

- **Zero runtime dependencies** — Node built-ins only; plain JSON-Schema tool
  parameters; lazy `@earendil-works/pi-tui` import guarded by the ambient shim in
  `src/pi-tui.d.ts`.
- **Erasable TypeScript** — no enums/parameter properties/namespaces; `import
  type` for types; relative imports use the `.ts` extension.
- **Single-token `/qdrant-*` commands** — no subcommand parsing.
- **Output via entries, never `sendMessage`** — keeps command output out of the
  LLM context.
- **Idempotent, deterministic point ids** and **graceful degradation** when
  Qdrant/embeddings are unreachable.
- One test file per module (`test/<module>.test.ts`) using `node:test` and
  `node:assert/strict`; fake the IO seams, keep mocks structural.

## Reporting issues / asking questions

This repository is developed locally and not yet published to a public forge.
Until it has a canonical home:

- File issues against the repository where this checkout lives (or wherever the
  maintainer points you).
- Good issues include: reproduction steps, expected vs actual behavior, the
  `/qdrant-status` output, and the pi version (`pi --version`).

## License

The project is MIT-licensed in intent; a `LICENSE` file will be added when the
repository gets its public home. Until then, ask the maintainer before
redistributing code outside this checkout.
