# pi-qdrant-memory Plan — Review & Findings

- **Document reviewed:** [`2026-09-07-pi-qdrant-memory-plan.md`](2026-09-07-pi-qdrant-memory-plan.md:1)
- **Companion spec:** [`2026-09-07-pi-qdrant-memory-design.md`](2026-09-07-pi-qdrant-memory-design.md:1)
- **Review scope:** full plan (2,669 lines), cross-checked against the design doc for mode/capture semantics and spec-coverage claims.
- **Environment note:** findings were evaluated against Windows 11 (PowerShell), the current workspace OS.

---

## Verdict

The plan is architecturally strong: a clean red/green TDD loop, small single-responsibility modules, a single shared contract ([`RuntimeDeps`](2026-09-07-pi-qdrant-memory-plan.md:91), [`QdrantLike`](2026-09-07-pi-qdrant-memory-plan.md:111)), and consistent graceful-degradation rules. It is **not executable end-to-end as written**: at least five tests fail against the provided implementations, the extension entry point is a non-functional stub, and several tests are POSIX-only and fail on Windows. These must be fixed before handing the plan to an executor.

## Strengths

- Clear goal, architecture, and tech-stack header; the spec is linked as authoritative ([line 11](2026-09-07-pi-qdrant-memory-plan.md:11)).
- Consistent per-task TDD flow: failing test → run → implement → re-run → commit.
- A single cross-module contract keeps everything testable without pi or live servers.
- Degradation rules stated once and carried through (never-throw paths in [`ingestItems()`](2026-09-07-pi-qdrant-memory-plan.md:1475) and [`captureAtCompaction()`](2026-09-07-pi-qdrant-memory-plan.md:1870)).

---

## Blocking issues

### B1. [`ensureCollection()`](2026-09-07-pi-qdrant-memory-plan.md:935) can never handle a 404 — its "created" test fails

[`request()`](2026-09-07-pi-qdrant-memory-plan.md:916) throws [`QdrantError`](2026-09-07-pi-qdrant-memory-plan.md:929) on any non-OK response. [`ensureCollection()`](2026-09-07-pi-qdrant-memory-plan.md:936) only inspects a `status === "error"` body *after* a successful GET. Qdrant returns HTTP 404 for a missing collection, so the GET throws before the create branch runs.

The test ["ensureCollection creates on 404"](2026-09-07-pi-qdrant-memory-plan.md:817) mocks a 404 (`ok: false`), so it rejects instead of returning `"created"`. The stated interface ("if 404 → PUT create", [line 783](2026-09-07-pi-qdrant-memory-plan.md:783)) and the implementation are contradictory; Task 6 Step 4's "PASS (6 tests)" is therefore wrong.

**Suggested fix:** make `request()` optionally not throw on 404 (e.g., a `requestOr404` variant), or catch [`QdrantError`](2026-09-07-pi-qdrant-memory-plan.md:929) in the GET path and treat 404 as "not exists" before falling through to the create branch.

### B2. [`listPendingFiles()`](2026-09-07-pi-qdrant-memory-plan.md:1312) returns the corrupt file too — Task 8 test fails

The test writes both `sess1-pending.json` (valid) and `sess2-pending.json` (`"not json"`) and asserts `files.length === 1` ([line 1215](2026-09-07-pi-qdrant-memory-plan.md:1215)). The implementation filters purely by the `-pending.json` suffix ([line 1315](2026-09-07-pi-qdrant-memory-plan.md:1315)), so both files match and the length is 2. Corrupt-file tolerance is implemented in [`readPendingArtifacts()`](2026-09-07-pi-qdrant-memory-plan.md:1321), not in the listing — the test asserts the wrong function's contract.

**Suggested fix:** either drop the corrupt file from the test fixture, or change the assertion to `2` and keep the corruption tolerance where it belongs (in the reader).

### B3. [`wireApi()`](2026-09-07-pi-qdrant-memory-plan.md:2379) cleanup is a no-op, but its test asserts removal

The returned cleanup function's body is empty ([lines 2463–2468](2026-09-07-pi-qdrant-memory-plan.md:2463)), while the fake `api.on` accumulates handlers. The test ["cleanup removes handlers"](2026-09-07-pi-qdrant-memory-plan.md:2286) asserts `events["session_before_compact"].length === 0`, which cannot pass. The plan acknowledges the stub but ships a test that contradicts it.

**Suggested fix:** have the structural [`WireApi`](2026-09-07-pi-qdrant-memory-plan.md:2359) `on()` return an unsubscribe function and make the fake `on` remove handlers; the cleanup closure then calls each unsubscribe.

### B4. The default [`factory()`](2026-09-07-pi-qdrant-memory-plan.md:2471) is non-functional

It never calls [`makeRuntime()`](2026-09-07-pi-qdrant-memory-plan.md:2317) or [`wireApi()`](2026-09-07-pi-qdrant-memory-plan.md:2379); `readConfig` returns an `as never` placeholder and the body ends with `void` statements ([lines 2476–2485](2026-09-07-pi-qdrant-memory-plan.md:2476)). As shipped, installing the extension registers no tools, commands, or hooks. The self-review frames this as intentional, but it means Task 13 does not produce a working extension — it defers the only non-unit-covered piece to "later," contradicting the plan's "thin but complete" goal.

**Suggested fix:** complete the factory body — `makeRuntime(...)` then `wireApi(...)`, keeping the cleanup reference for `session_shutdown` — with the pi [`ExtensionAPI`](2026-09-07-pi-qdrant-memory-plan.md:2167) field names confirmed against the installed package before commit.

### B5. Windows path-literal assertions fail on this environment (Tasks 2 and 7)

[`configPath()`](2026-09-07-pi-qdrant-memory-plan.md:379) and [`blackholeConfigPath()`](2026-09-07-pi-qdrant-memory-plan.md:1093) use [`join()`](2026-09-07-pi-qdrant-memory-plan.md:380), which emits backslashes on Windows. The tests assert forward-slash strings ([config test line 309](2026-09-07-pi-qdrant-memory-plan.md:309), [mode test line 1036](2026-09-07-pi-qdrant-memory-plan.md:1036)), so both fail on Windows 11.

**Suggested fix:** assert against [`join()`](2026-09-07-pi-qdrant-memory-plan.md:380)-produced paths (e.g., compare to `join(...)` in the test) or use `path.normalize` on both sides, rather than hardcoding separators.

---

## Significant functional/design gaps

### G1. `remember` and `memory_search` never ensure the collection exists

[`rememberLogic()`](2026-09-07-pi-qdrant-memory-plan.md:1684) and [`memorySearchLogic()`](2026-09-07-pi-qdrant-memory-plan.md:1704) call [`upsert()`](2026-09-07-pi-qdrant-memory-plan.md:957)/[`search()`](2026-09-07-pi-qdrant-memory-plan.md:961) directly with no [`ensureCollection()`](2026-09-07-pi-qdrant-memory-plan.md:935). In Mode 2 a fresh project has no collection until the first compaction capture (which does go through [`ingestItems()`](2026-09-07-pi-qdrant-memory-plan.md:1475)). The first `/qdrant remember` and first `memory_search` after install will therefore 404.

**Suggested fix:** route `remember` through [`ensureAndGet()`](2026-09-07-pi-qdrant-memory-plan.md:1466) (or ensure on the search path, accepting that an empty collection is a valid "no results" outcome).

### G2. Compaction capture uses a hardcoded summary and the wrong session id

[`compactHandler`](2026-09-07-pi-qdrant-memory-plan.md:2431) passes the literal `"session compacted"` as the summary and `rt.agentDir` as `sessionId` ([line 2437](2026-09-07-pi-qdrant-memory-plan.md:2437)). The spec requires embedding pi's actual compaction summary from the event payload ([§3.3](2026-09-07-pi-qdrant-memory-design.md:172)). Using `agentDir` as the session id means every session in a project produces the same canonical point id (same text + same context id per the canonical rule at [line 23](2026-09-07-pi-qdrant-memory-plan.md:23)), so deterministic dedupe collapses all cross-session summaries into one point.

**Suggested fix:** read the summary text and session id from the compaction event payload, and fall back to a real session identifier rather than `agentDir`.

### G3. [`autoSnapshot()`](2026-09-07-pi-qdrant-memory-plan.md:1890) is dead code

Task 11 defines it as the spec's "safety net" ([§3.3](2026-09-07-pi-qdrant-memory-design.md:178)), but nothing in Task 13 wires it into the session lifecycle — [`sessionStart`](2026-09-07-pi-qdrant-memory-plan.md:2443) only ingests in Mode 1, and Mode 2 only registers the compact hook. The safety-net requirement is unimplemented.

**Suggested fix:** wire an early-session snapshot in Mode 2, or explicitly document why it is deferred and remove the misleading claim that it is "used earlier in the session."

### G4. `memory_search` execute params use `type?: never`

The tool schema declares a five-value enum ([line 2410](2026-09-07-pi-qdrant-memory-plan.md:2410)), but the `execute` signature is `{ query: string; type?: never; limit?: number }` ([line 2415](2026-09-07-pi-qdrant-memory-plan.md:2415)). This will not typecheck and contradicts the declared schema.

**Suggested fix:** type the parameter as `MemoryType` (or the narrower four/five-value union matching the enum).

### G5. Missing devDependencies for the typecheck path

[`tsconfig.json`](2026-09-07-pi-qdrant-memory-plan.md:175) sets `"types": ["node"]`, and multiple modules use `NodeJS.ProcessEnv` ([`config.ts`](2026-09-07-pi-qdrant-memory-plan.md:393), [`mode.ts`](2026-09-07-pi-qdrant-memory-plan.md:1123), [`deps.ts`](2026-09-07-pi-qdrant-memory-plan.md:2320)), but Task 1's [`package.json`](2026-09-07-pi-qdrant-memory-plan.md:145) declares no `devDependencies`. `npm run typecheck` (Task 14 Step 3) cannot pass without `typescript` and `@types/node`.

**Suggested fix:** add `typescript` and `@types/node` as `devDependencies` in Task 1 (consistent with the plan's own "typescript as an optional dev-only tool" note).

### G6. `IngestItem.payload` type mismatch

The Module Map interface specifies `Omit<PointPayload, "text" | "source_kind"> & { source_kind: SourceKind }` ([line 1369](2026-09-07-pi-qdrant-memory-plan.md:1369)), while the implementation uses `Omit<PointPayload, "text"> & { source_kind: SourceKind }` ([line 1457](2026-09-07-pi-qdrant-memory-plan.md:1457)) — and `source_kind` is already in `PointPayload`, so the intersection is redundant.

**Suggested fix:** align the two definitions and drop the redundant intersection.

---

## Minor issues

- **Task 10 test count** says "PASS (7 + 2 tests)" ([line 1751](2026-09-07-pi-qdrant-memory-plan.md:1751)), but `tools-core.test.ts` contains six tests ([lines 1569–1630](2026-09-07-pi-qdrant-memory-plan.md:1569)), not seven.
- **Task 12 "Consumes" list** includes `loadConfig`, `configPath`, `projectIdFrom`, `detectBlackhole`, `resolveMode`, `agentDirFromEnv` ([line 1931](2026-09-07-pi-qdrant-memory-plan.md:1931)), but [`handlers.ts`](2026-09-07-pi-qdrant-memory-plan.md:2037) imports none of `loadConfig`/`configPath`/`projectIdFrom`/`agentDirFromEnv`.
- **`node:fetch`** is described as a built-in module ([line 18](2026-09-07-pi-qdrant-memory-plan.md:18)); there is no `node:fetch` — it is the global `fetch`.
- **[`clearCollection()`](2026-09-07-pi-qdrant-memory-plan.md:982)** deletes the collection rather than wiping points; combined with G1, a `/qdrant clear` leaves the project unable to search or remember until an ingest re-creates it.
- **`test:smoke` script** uses POSIX `ENV=1 node …` syntax ([line 2642](2026-09-07-pi-qdrant-memory-plan.md:2642)) and will not run in cmd/PowerShell as written.
- **`statusHandler` test isolation** depends on real filesystem state at the hardcoded `/tmp/agent` path via [`detectBlackhole()`](2026-09-07-pi-qdrant-memory-plan.md:2066).
- **Handlers test fake** reuses `written` for the `clearCollection` side effect ([line 1970](2026-09-07-pi-qdrant-memory-plan.md:1970)), conflating config writes with clear calls — passing, but confusing.

---

## Test-count audit

| Task | Tests written | Plan's claimed count | Status |
| --- | --- | --- | --- |
| 1 | 1 | 1 | OK |
| 2 | 6 | 6 | 1 will fail on Windows (path literal) |
| 3 | 4 | 4 | OK |
| 4 | 5 | 5 | OK |
| 5 | 4 | 4 | OK |
| 6 | 6 | 6 | 1 fails (B1, 404 path) |
| 7 | 7 | 7 | 1 will fail on Windows (path literal) |
| 8 | 5 | 5 | 1 fails (B2, pending-file count) |
| 9 | 3 | 3 | OK |
| 10 | 6 + 2 | 7 + 2 | count off by one |
| 11 | 5 | 5 | OK |
| 12 | 6 | 6 | OK |
| 13 | 2 + 4 | 6 (implied) | 1 fails (B3, cleanup) |
| 15 | 1 (skipped) | 1 (skipped) | OK |

---

## Prioritized remediation checklist

- [ ] B1 — make the collection GET tolerate 404 so [`ensureCollection()`](2026-09-07-pi-qdrant-memory-plan.md:935) reaches the create branch.
- [ ] B2 — reconcile the Task 8 pending-file count (fix the fixture or the assertion).
- [ ] B3 — make [`wireApi()`](2026-09-07-pi-qdrant-memory-plan.md:2379) cleanup actually unsubscribe (and update the fake `on`).
- [ ] B4 — complete the [`factory()`](2026-09-07-pi-qdrant-memory-plan.md:2471) body so the extension registers tools/commands/hooks.
- [ ] B5 — replace hardcoded POSIX path assertions with [`join()`](2026-09-07-pi-qdrant-memory-plan.md:380)-based expectations.
- [ ] G1 — ensure the collection in the `remember`/`memory_search` paths.
- [ ] G2 — wire the real compaction summary + session id from the event payload.
- [ ] G3 — wire [`autoSnapshot()`](2026-09-07-pi-qdrant-memory-plan.md:1890) into the lifecycle or document its deferral.
- [ ] G4 — fix the `memory_search` `type?: never` signature.
- [ ] G5 — add `typescript`/`@types/node` devDependencies.
- [ ] G6 — align `IngestItem.payload` between module map and implementation.
- [ ] Correct Task 10's test count and Task 12's "Consumes" list; fix the `node:fetch` wording and the Windows `test:smoke` script.
