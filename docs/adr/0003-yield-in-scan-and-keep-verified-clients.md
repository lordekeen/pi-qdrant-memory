# The code scan yields; a client that still points at the same store is kept

## Context

Two hot paths paid for work nobody could observe.

`scanRepo` walked the repo and matched every line synchronously, and
`session_start` starts the code sync on every session. The scan was therefore a
single synchronous block on the host's event loop — measured at 514 ms of
main-thread starvation for a repo at `MAX_FILES` (2000 files). In pi that loop
is also the TUI loop, so enabling `codeKnowledge` froze the session-start
render for the whole scan.

Separately, `ensureCollection` memoizes verified collections on the client
instance, but `buildClients` constructed a new `QdrantClient` on every
`applyConfig`, which runs on every `session_start` and after every settings
write. In production no Qdrant seam is injected, so the memo was discarded each
time and the first operation of every session re-verified the collection — a
`GET` plus two payload-index `PUT`s (9.9 ms measured against a local Qdrant,
against 0.003 ms for a memo hit).

## Decision

**The scan is async by contract.** `scanRepo` returns a `Promise`, the file walk
awaits `readdir`/`lstat`, and the content pass yields via `setImmediate` after
each `SCAN_YIELD_BYTES` (96 KB) burst. Per-file extraction lives in a pure
`scanFileContent` so the burst cost bounds the pause. Measured with
`monitorEventLoopDelay` on 2000 files: peak lag 4.1 ms (max) / 1.0 ms (mean),
down from a whole-scan block. Since the scan is fire-and-forget background work,
the added wall time is invisible while the stall was not.

**A reload keeps the Qdrant client when `url` and `apiKey` are unchanged.**
`resolveQdrant` returns the previous client if its connection identity (recorded
in a `WeakMap` keyed on the client) still matches the config; a changed url or
apiKey rebuilds, because the old client would talk to the wrong store. The
`EmbeddingClient` is stateless and is still rebuilt every time.

**Not changed:** the two payload-index `PUT`s on a cold ensure. They run after
the `GET` in the same path that creates a collection, so gating them on
`created`/`recreated` would leave a collection created by an earlier version
unindexed, and payloads carry no version field to repair it. They are
idempotent and now cost at most one cold ensure per session.

## Considered options

- **A worker thread for the scan.** Rejected for now: it removes the stall too,
  but adds serialization and a lifecycle/teardown surface for a fire-and-forget
  task. Revisit if scan wall time becomes a problem.
- **Deferring the session-start sync to the first `code_memory` call.**
  Rejected: it changes the statusline's "syncing" affordance and makes the first
  query pay a cold sync.
- **Gating `createPayloadIndexes` on create/recreate.** Rejected: it trades one
  cheap idempotent request for a silent unindexed-collection failure mode.
- **Reusing the client keyed on the `RuntimeDeps` object.** Rejected: a test
  fixture can collide with a field, and a `WeakMap` keyed on the client keeps
  the record with the thing it describes.

## Consequences

- `scanRepo`'s async signature is deliberate. A synchronous variant reintroduces
  the stall; this ADR is the reason, not a preference.
- `applyConfig` no longer rebuilds every client slice from scratch. Anything
  that needs a fresh Qdrant client (or a clean readiness memo) must change the
  connection or construct its own client.
- Clients injected through `resolvedIO` are still preserved verbatim (OI-002),
  and `resolveQdrant` is never consulted for them.
- Both behaviors are covered in `test/deps.test.ts` (via a `globalThis.fetch`
  stub, so the production client path is what gets asserted) and
  `test/codescan.test.ts`.
