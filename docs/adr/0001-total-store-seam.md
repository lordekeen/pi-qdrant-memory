# One total store seam; the adapter owns collection readiness

## Context

`QdrantLike` mirrors the Qdrant REST surface, so capabilities were added as
optional methods (`deletePointsBySourceKind?`, `deletePointsBySourceEntryIds?`,
`deletePointsByIds?`, `existingPointIds?`) that every caller had to
feature-detect. Collection readiness lived in two places: the client's own
`ensured` memo and a `collectionReady` set threaded through the runtime,
invalidated by hand after a clear.

## Decision

Keep one interface and make every capability required — a store that lacks one
fails the build instead of taking a runtime branch. Readiness is owned solely by
the adapter: `ensureCollection` memoizes, `clearCollection` invalidates.
`collectionReady` is removed from the runtime and tool dependency types.

## Considered options

- **Read and write facets.** Rejected: no adapter varies between them, so the
  split would document a distinction that does not exist.
- **Keep capabilities optional.** Rejected: optionality is what pushed the
  branches into five callers.

## Consequences

Every fake must implement the full surface; write-path tests share
`test/support/memory-store.ts` instead of hand-rolling partial stores.
