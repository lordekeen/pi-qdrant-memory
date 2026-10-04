# The write path never throws and never logs; failures are report data

## Context

Remember, blackhole ingest, compaction capture and code sync each
re-implemented the same embed → ensure → invalidate → upsert protocol,
including the delete-before-upsert ordering whose violation caused the code-sync
data-loss bug. Error handling was per path too: some threw, all logged
path-specific sentences, and results took three different shapes.

## Decision

One module (`src/writes.ts`, `applyWrites`) owns the protocol and reports
failures as data; it never throws and never logs. Callers keep their own
`console.error` sentences and result shapes (`ToolResult`, `attempted/ingested`,
`SyncResult`). Two deliberate deviations from the obvious order: ensure runs
after the first successful embed (a failed embed must never create or recreate a
collection), and a whole-file batch embeds all-or-nothing (a half-replaced file
would leave its new sha advertised while summaries are missing, so the next sync
would skip it forever).

## Considered options

- **One writer per path.** Rejected: the invariant is the shared part, and four
  copies are how the data-loss bug stayed hidden.
- **Log inside the module.** Rejected: the path-specific sentences ("will retry
  next sync" vs "ingest skipped") carry real meaning, and output is the
  callers' business.

## Consequences

The graceful-degradation invariant holds for lifecycle ingest by construction:
there is no throwing path to catch. A caller that wants to log does so from the
report.
