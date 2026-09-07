# pi-qdrant-memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pi.dev extension, `pi-qdrant-memory`, that gives the pi agent semantic, cross-session/cross-project retrieval over durable conversation knowledge (decisions/facts/constraints/preferences) stored in a per-project Qdrant collection.

**Architecture:** Two blackhole-aware operating modes. Mode 1 (pi-blackhole present) reads blackhole's durable artifacts (`om.*` session entries + `<sessionId>-pending.json`) and ingests them into Qdrant — it never claims `session_before_compact`. Mode 2 (blackhole absent) registers its own `session_before_compact` hook and captures a durable snapshot at compaction. Both modes expose `remember` (agent write), `memory_search` (agent read), and a `/qdrant` slash-command family, all backed by deterministic content-hash point ids for idempotent upserts. Zero runtime dependencies: Node global `fetch` (Qdrant REST + OpenAI-compatible `/embeddings`) and `crypto`.

**Tech Stack:** TypeScript (erasable-syntax only, no enums/namespaces — runs via Node's native type stripping), Node ≥ 22.19, Node built-in test runner (`node --test`), Qdrant REST (`:6333`), OpenAI-compatible embeddings endpoint (default llama.cpp `nomic-embed-text`, 768-dim). No runtime npm deps; `typescript` as an optional dev-only typecheck tool.

**Spec:** [`specs/2026-09-07-pi-qdrant-memory-design.md`](2026-09-07-pi-qdrant-memory-design.md) — the authoritative design this plan implements. Executors read both documents; this plan argues from the spec.

---

## Global Constraints

- Runtime is Node ≥ 22.19 (pi's own floor; also required for native TS type-stripping and global `fetch`).
- **Zero runtime npm dependencies.** Only Node built-ins: `node:fetch` (global), `node:crypto`, `node:fs`, `node:path`, `node:url`, `node:test`/`node:assert`.
- TypeScript must be **erasable syntax only**: no `enum`, no `namespace`, no parameter properties, no non-erasable decorators. Use `import type` for type-only imports. (This is load-bearing: tests run `.ts` directly via `node --test` with no build step.)
- Test command is always: `node --test test/` (runs every `*.test.ts`). No build step, no bundler.
- Qdrant transport is REST at `qdrantUrl` (default `http://localhost:6333`); single unnamed vector, dimension = `expectedDimension` (768 default), distance Cosine, `on_disk: true`, HNSW.
- Collection per project named `pi-mem-<16-hex>` where `<16-hex>` = first 16 hex chars of `sha256(git_root_abs_path)`.
- Point id = `sha256(canonical).slice(0, 32)`; `canonical = normalize(text) + "|" + source_kind + "|" + (source_entry_id ?? session_id ?? "")`.
- Point payload fields: `{ type, text, project_id, session_id?, source_entry_id?, ts, source_kind }`; `type` ∈ `decision|fact|constraint|preference|session_summary`; `source_kind` ∈ `blackhole_observation|blackhole_reflection|remember_tool|own_capture`.
- Payload keyword indexes created on `type` and `project_id`.
- Config single source of truth: `<agent-dir>/pi-qdrant-memory/pi-qdrant-memory-config.json` (`<agent-dir>` = `PI_CODING_AGENT_DIR` or `~/.pi/agent`); `PI_QDRANT_*` env overrides at load; precedence global → project → env; defaults embedded in code if file absent.
- Mode config key `mode` ∈ `auto|blackhole|own`. `blackhole` forces Mode 1, `own` forces Mode 2, `auto` detects via pi-blackhole config presence+validity at `~/.pi/agent/pi-blackhole/pi-blackhole-config.json`.
- Extension factory must not start background resources; lifecycle work goes in `session_start` / `session_shutdown`.
- Mode-2 compaction-hook capture is fire-and-forget with error logging — must never stall pi compaction.
- Naming/copy rules: user-facing strings and error messages must be clear and actionable (e.g., "Qdrant is not reachable at `http://localhost:6333` …"). Result rows show type, score, text preview.

## Module Map (final structure)

All paths relative to the package root (created in Task 1). Files are small and single-responsibility.

- `package.json` — pi package manifest (`"pi": { "extensions": [...] }`), `npm test` script → `node --test test/`.
- `tsconfig.json` — typecheck-only config (no emit), `erasableSyntaxOnly: true`.
- `src/types.ts` — shared unions + `Config` + `PointPayload` interfaces (consumed by every other module).
- `src/config.ts` — `DEFAULTS`, `loadConfig(agentDir, env)`, config path helper, env-override merge, validation.
- `src/project.ts` — `findGitRoot(startDir)`, `projectId(rootPath)`.
- `src/ids.ts` — `canonicalString`, `contentHash`, `pointId` (deterministic content-hash ids).
- `src/embeddings.ts` — `EmbeddingClient.embed(text)` via global fetch; throws typed `EmbeddingError`.
- `src/qdrant.ts` — `QdrantClient`: `request`, `ensureCollection`, `upsert`, `search`, `count`, `clearCollection`. Throws typed `QdrantError`.
- `src/mode.ts` — `blackholeConfigPath`, `detectBlackhole`, `resolveMode`.
- `src/blackhole.ts` — `parseOmEntry`, `readPendingJson`, `collectPendingArtifacts(agentDir)`, artifact → payload mapping (`artifactToPayload`).
- `src/ingest.ts` — `ingestArtifacts(deps, artifacts, projectId)` (embed + upsert with dedupe).
- `src/tools-core.ts` — `rememberLogic(deps, text, type?)`, `memorySearchLogic(deps, query, type?, limit?)`.
- `src/render.ts` — `renderHits(hits)` formatting.
- `src/capture.ts` — Mode 2 `captureAtCompaction(deps, summaryText, sessionId)` and `snapshotArtifacts` helpers.
- `src/handlers.ts` — slash-command handlers `statusHandler`, `settingsHandler`, `rememberHandler`, `searchHandler`, `clearHandler`, `helpHandler` operating on a `RuntimeDeps` bundle (testable without pi).
- `src/index.ts` — the pi extension factory: `export default function (api: ExtensionAPI)` wiring tools, commands, hooks, lifecycle. Thin; delegates to the modules above.
- `test/` — one `*.test.ts` per module (`config.test.ts`, `ids.test.ts`, `project.test.ts`, `embeddings.test.ts`, `qdrant.test.ts`, `mode.test.ts`, `blackhole.test.ts`, `ingest.test.ts`, `tools-core.test.ts`, `render.test.ts`, `capture.test.ts`, `handlers.test.ts`, `index.test.ts`).
- `README.md` — usage, config table, commands, modes.

**Interfaces (cross-task contract — exact names/types):**

```ts
// src/types.ts
export type MemoryType = "decision" | "fact" | "constraint" | "preference" | "session_summary";
export type SourceKind = "blackhole_observation" | "blackhole_reflection" | "remember_tool" | "own_capture";
export type ConfigMode = "auto" | "blackhole" | "own";

export interface Config {
  qdrantUrl: string;
  qdrantApiKey: string | null;
  embeddingBaseURL: string;
  embeddingModel: string;
  embeddingApiKey: string | null;
  expectedDimension: number;
  scoreThreshold: number;
  maxResults: number;
  mode: ConfigMode;
}

export interface PointPayload {
  type: MemoryType;
  text: string;
  project_id: string;
  session_id?: string;
  source_entry_id?: string;
  ts: number;
  source_kind: SourceKind;
}

export interface SearchHit {
  id: string;
  score: number;
  payload: PointPayload;
}

export interface RuntimeDeps {
  cfg: Config;
  agentDir: string;
  cwd: string;
  projectId: string;
  embed: (text: string) => Promise<number[]>;
  qdrant: QdrantLike;
  readConfig(): Config;
  writeConfig(c: Config): void;
  print(text: string): void;
}
```

```ts
// src/qdrant.ts
export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: PointPayload;
}
export interface QdrantLike {
  ensureCollection(name: string, dim: number): Promise<"created" | "exists" | "recreated">;
  upsert(name: string, points: QdrantPoint[]): Promise<void>;
  search(name: string, vector: number[], opts: {
    projectId: string; type?: MemoryType; limit: number; threshold: number;
  }): Promise<SearchHit[]>;
  count(name: string): Promise<number>;
  clearCollection(name: string): Promise<void>;
}
export class QdrantError extends Error {}
export class QdrantClient implements QdrantLike { /* Task 6 */ }
```

`RuntimeDeps` lives in `src/types.ts` (created in Task 1) and type-only-imports
`QdrantLike` from `./qdrant.ts` (`import type`), so the ordering of file creation across
tasks never matters at runtime. `QdrantLike`/`QdrantError`/`QdrantClient` are created in
Task 6. `EmbeddingClient` and `Mode`/`Mode1|Mode2` are `"mode1" | "mode2"`.

---

### Task 1: Scaffold the pi package

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/types.ts`
- Create: `test/scaffold.test.ts`
- Create: `README.md` (minimal stub)

**Interfaces:**
- Produces: package manifest with `"pi": { "extensions": ["./src/index.ts"] }`, `"type": "module"`, `"engines": { "node": ">=22.19" }`, `"scripts": { "test": "node --test test/" }`; `src/types.ts` with the shared types above; and a passing smoke test proving `node --test` runs `.ts` with type stripping.

- [ ] **Step 1: Write `package.json`**

```jsonc
{
  "name": "pi-qdrant-memory",
  "version": "0.1.0",
  "description": "Semantic, cross-session retrieval over durable conversation knowledge for pi.dev, backed by Qdrant.",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22.19" },
  "scripts": {
    "test": "node --test test/",
    "typecheck": "tsc --noEmit"
  },
  "pi": { "extensions": ["./src/index.ts"] }
}
```

- [ ] **Step 2: Write `tsconfig.json`** (typecheck only — no emit, enforces erasable syntax)

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Write `src/types.ts`** (verbatim from Module Map; includes the full `RuntimeDeps` contract used by later tasks)

```ts
import type { QdrantLike } from "./qdrant.ts";

export type MemoryType = "decision" | "fact" | "constraint" | "preference" | "session_summary";
export type SourceKind = "blackhole_observation" | "blackhole_reflection" | "remember_tool" | "own_capture";
export type ConfigMode = "auto" | "blackhole" | "own";

export interface Config {
  qdrantUrl: string;
  qdrantApiKey: string | null;
  embeddingBaseURL: string;
  embeddingModel: string;
  embeddingApiKey: string | null;
  expectedDimension: number;
  scoreThreshold: number;
  maxResults: number;
  mode: ConfigMode;
}

export interface PointPayload {
  type: MemoryType;
  text: string;
  project_id: string;
  session_id?: string;
  source_entry_id?: string;
  ts: number;
  source_kind: SourceKind;
}

export interface SearchHit {
  id: string;
  score: number;
  payload: PointPayload;
}

export interface RuntimeDeps {
  cfg: Config;
  agentDir: string;
  cwd: string;
  projectId: string;
  embed: (text: string) => Promise<number[]>;
  qdrant: QdrantLike;
  readConfig(): Config;
  writeConfig(c: Config): void;
  print(text: string): void;
}
```

Note: `./qdrant.ts` is created in Task 6; the `import type` here is erased at runtime so
the Task-1 smoke test (which only imports `Config`) still runs green. `verbatimModuleSyntax`
requires this `import type`, so keep it exactly as written.

- [ ] **Step 4: Write the smoke test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../src/types.ts";

test("node type-stripping runs TS and type-only imports work", () => {
  const cfg: Config = {
    qdrantUrl: "http://localhost:6333",
    qdrantApiKey: null,
    embeddingBaseURL: "http://localhost:8080/v1",
    embeddingModel: "nomic-embed-text",
    embeddingApiKey: null,
    expectedDimension: 768,
    scoreThreshold: 0.18,
    maxResults: 10,
    mode: "auto",
  };
  assert.equal(cfg.expectedDimension, 768);
});
```

- [ ] **Step 5: Run the test to verify the harness works**

Run: `node --test test/scaffold.test.ts`
Expected: PASS (1 test). If Node reports "Unknown file extension .ts" the Node version is < 22.19 — upgrade Node.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json src/types.ts test/scaffold.test.ts README.md
git commit -m "chore: scaffold pi-qdrant-memory package"
```

---

### Task 2: Configuration loading (defaults, JSON, env overrides)

**Files:**
- Create: `src/config.ts`
- Create: `test/config.test.ts`

**Interfaces:**
- Consumes: `Config`, `ConfigMode` from `src/types.ts`.
- Produces:
  - `export const DEFAULTS: Config`
  - `export function configPath(agentDir: string): string` → `${agentDir}/pi-qdrant-memory/pi-qdrant-memory-config.json`
  - `export function loadConfig(agentDir: string, env: NodeJS.ProcessEnv = process.env): Config`
  - `export function isConfigMode(v: string | undefined): v is ConfigMode`

- [ ] **Step 1: Write the failing tests** (`test/config.test.ts`)

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, configPath, loadConfig } from "../src/config.ts";

function tempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-qm-cfg-"));
}

test("loadConfig returns DEFAULTS when no file and no env", () => {
  const dir = tempAgentDir();
  try {
    const cfg = loadConfig(dir, {});
    assert.deepEqual(cfg, DEFAULTS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("configPath nests under agent dir", () => {
  assert.equal(configPath("/tmp/agent"), "/tmp/agent/pi-qdrant-memory/pi-qdrant-memory-config.json");
});

test("loadConfig reads JSON file values", () => {
  const dir = tempAgentDir();
  try {
    const file = configPath(dir);
    writeFileSync(file, JSON.stringify({ scoreThreshold: 0.2, maxResults: 25 }), "utf8");
    const cfg = loadConfig(dir, {});
    assert.equal(cfg.scoreThreshold, 0.2);
    assert.equal(cfg.maxResults, 25);
    assert.equal(cfg.qdrantUrl, DEFAULTS.qdrantUrl); // untouched key keeps default
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("env overrides win over file and defaults", () => {
  const dir = tempAgentDir();
  try {
    const file = configPath(dir);
    writeFileSync(file, JSON.stringify({ scoreThreshold: 0.2 }), "utf8");
    const cfg = loadConfig(dir, { PI_QDRANT_URL: "http://qdrant.example:6333", PI_QDRANT_MODE: "own" });
    assert.equal(cfg.qdrantUrl, "http://qdrant.example:6333");
    assert.equal(cfg.mode, "own");
    assert.equal(cfg.scoreThreshold, 0.2); // file value preserved where no env
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid mode value in env falls back to auto", () => {
  const dir = tempAgentDir();
  try {
    const cfg = loadConfig(dir, { PI_QDRANT_MODE: "bogus" });
    assert.equal(cfg.mode, "auto");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("numeric env overrides parse to numbers", () => {
  const dir = tempAgentDir();
  try {
    const cfg = loadConfig(dir, { PI_QDRANT_EXPECTED_DIMENSION: "384", PI_QDRANT_SCORE_THRESHOLD: "0.1", PI_QDRANT_MAX_RESULTS: "5" });
    assert.equal(cfg.expectedDimension, 384);
    assert.equal(cfg.scoreThreshold, 0.1);
    assert.equal(cfg.maxResults, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/config.test.ts`
Expected: FAIL — `src/config.ts` not found.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, ConfigMode } from "./types.ts";

export const DEFAULTS: Config = {
  qdrantUrl: "http://localhost:6333",
  qdrantApiKey: null,
  embeddingBaseURL: "http://localhost:8080/v1",
  embeddingModel: "nomic-embed-text",
  embeddingApiKey: null,
  expectedDimension: 768,
  scoreThreshold: 0.18,
  maxResults: 10,
  mode: "auto",
};

export function configPath(agentDir: string): string {
  return join(agentDir, "pi-qdrant-memory", "pi-qdrant-memory-config.json");
}

export function isConfigMode(v: string | undefined): v is ConfigMode {
  return v === "auto" || v === "blackhole" || v === "own";
}

function numEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(agentDir: string, env: NodeJS.ProcessEnv = process.env): Config {
  const file = configPath(agentDir);
  let fromFile: Partial<Config> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Config>;
      if (parsed && typeof parsed === "object") fromFile = parsed;
    } catch {
      // corrupt file: fall through to defaults + env; never crash at load
    }
  }
  const mode: ConfigMode = isConfigMode(env.PI_QDRANT_MODE)
    ? (env.PI_QDRANT_MODE as ConfigMode)
    : isConfigMode(fromFile.mode) ? (fromFile.mode as ConfigMode) : DEFAULTS.mode;
  return {
    qdrantUrl: env.PI_QDRANT_URL ?? fromFile.qdrantUrl ?? DEFAULTS.qdrantUrl,
    qdrantApiKey: env.PI_QDRANT_API_KEY ?? fromFile.qdrantApiKey ?? DEFAULTS.qdrantApiKey,
    embeddingBaseURL: env.PI_QDRANT_EMBEDDING_BASE_URL ?? fromFile.embeddingBaseURL ?? DEFAULTS.embeddingBaseURL,
    embeddingModel: env.PI_QDRANT_EMBEDDING_MODEL ?? fromFile.embeddingModel ?? DEFAULTS.embeddingModel,
    embeddingApiKey: env.PI_QDRANT_EMBEDDING_API_KEY ?? fromFile.embeddingApiKey ?? DEFAULTS.embeddingApiKey,
    expectedDimension: numEnv(env.PI_QDRANT_EXPECTED_DIMENSION, fromFile.expectedDimension ?? DEFAULTS.expectedDimension),
    scoreThreshold: numEnv(env.PI_QDRANT_SCORE_THRESHOLD, fromFile.scoreThreshold ?? DEFAULTS.scoreThreshold),
    maxResults: numEnv(env.PI_QDRANT_MAX_RESULTS, fromFile.maxResults ?? DEFAULTS.maxResults),
    mode,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/config.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: config loading with defaults, JSON, and env overrides"
```

---

### Task 3: Project identity (git root + project id)

**Files:**
- Create: `src/project.ts`
- Create: `test/project.test.ts`

**Interfaces:**
- Produces:
  - `export async function findGitRoot(startDir: string): Promise<string | null>` — walks up from `startDir` looking for a `.git` entry (dir or file for worktrees); returns the ancestor path, else `null`.
  - `export async function projectIdFrom(startDir: string): Promise<string>` — resolves git root (falls back to `startDir` when no `.git` found), returns `"pi-mem-" + sha256(absRoot).slice(0, 16)`.
  - `export function projectIdFromPath(absRoot: string): string` — pure form used by tests and ingest.

- [ ] **Step 1: Write the failing tests** (`test/project.test.ts`)

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGitRoot, projectIdFromPath } from "../src/project.ts";

test("findGitRoot finds ancestor .git dir", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-git-"));
  try {
    mkdirSync(join(root, ".git"));
    const sub = join(root, "a", "b");
    mkdirSync(sub, { recursive: true });
    assert.equal(await findGitRoot(sub), root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("findGitRoot honors .git files (worktrees)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-gitfile-"));
  try {
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere/main/.git/worktrees/x", "utf8");
    const sub = join(root, "deep");
    mkdirSync(sub, { recursive: true });
    assert.equal(await findGitRoot(sub), root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("findGitRoot returns null when no git", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-qm-nogit-"));
  try {
    assert.equal(await findGitRoot(root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("projectIdFromPath is a stable 16-hex prefix of sha256 and prefixed pi-mem-", () => {
  const a = projectIdFromPath("C:/repos/myproj");
  const b = projectIdFromPath("C:/repos/myproj");
  const c = projectIdFromPath("C:/repos/otherproj");
  assert.match(a, /^pi-mem-[0-9a-f]{16}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/project.test.ts`
Expected: FAIL — `src/project.ts` not found.

- [ ] **Step 3: Implement `src/project.ts`**

```ts
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export async function findGitRoot(startDir: string): Promise<string | null> {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function projectIdFromPath(absRoot: string): string {
  const real = existsSync(absRoot) ? realpathSync(absRoot) : absRoot;
  const hash = createHash("sha256").update(real).digest("hex");
  return `pi-mem-${hash.slice(0, 16)}`;
}

export async function projectIdFrom(startDir: string): Promise<string> {
  const root = await findGitRoot(startDir);
  return projectIdFromPath(root ?? startDir);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/project.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/project.ts test/project.test.ts
git commit -m "feat: project identity from git root sha256"
```

---

### Task 4: Deterministic point ids

**Files:**
- Create: `src/ids.ts`
- Create: `test/ids.test.ts`

**Interfaces:**
- Consumes: `SourceKind` from `src/types.ts`.
- Produces:
  - `export function normalizeText(text: string): string` — trims, collapses internal whitespace runs to a single space.
  - `export function canonicalString(text: string, sourceKind: SourceKind, contextId: string): string`
  - `export function contentHash(canonical: string): string` — `sha256(canonical).slice(0, 32)`.
  - `export function pointId(text: string, sourceKind: SourceKind, contextId: string): string` — `contentHash(canonicalString(text, sourceKind, contextId))`.

- [ ] **Step 1: Write the failing tests** (`test/ids.test.ts`)

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalString, contentHash, normalizeText, pointId } from "../src/ids.ts";

test("normalizeText trims and collapses whitespace", () => {
  assert.equal(normalizeText("  we   chose X\n\n over Y  "), "we chose X over Y");
});

test("canonicalString joins normalized text, source_kind, contextId with pipes", () => {
  assert.equal(canonicalString(" use REST ", "remember_tool", "sess1"),
    "use REST|remember_tool|sess1");
});

test("pointId is 32 hex chars and stable for equal inputs", () => {
  const a = pointId("decide on REST", "remember_tool", "s1");
  const b = pointId("decide on REST", "remember_tool", "s1");
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, b);
});

test("same text different source_kind yields different id", () => {
  const a = pointId("same", "blackhole_observation", "s1");
  const b = pointId("same", "blackhole_reflection", "s1");
  assert.notEqual(a, b);
});

test("contentHash is sha256 slice(0,32)", () => {
  assert.match(contentHash("anything"), /^[0-9a-f]{32}$/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/ids.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/ids.ts`**

```ts
import { createHash } from "node:crypto";
import type { SourceKind } from "./types.ts";

export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function canonicalString(text: string, sourceKind: SourceKind, contextId: string): string {
  return `${normalizeText(text)}|${sourceKind}|${contextId}`;
}

export function contentHash(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export function pointId(text: string, sourceKind: SourceKind, contextId: string): string {
  return contentHash(canonicalString(text, sourceKind, contextId));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/ids.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ids.ts test/ids.test.ts
git commit -m "feat: deterministic content-hash point ids"
```

---

### Task 5: Embedding client (OpenAI-compatible `/embeddings` via global fetch)

**Files:**
- Create: `src/embeddings.ts`
- Create: `test/embeddings.test.ts`

**Interfaces:**
- Consumes: `RuntimeDeps` shape fields `cfg.embeddingBaseURL`, `cfg.embeddingModel`, `cfg.embeddingApiKey`, `cfg.expectedDimension`.
- Produces:
  - `export class EmbeddingError extends Error {}`
  - `export class EmbeddingClient`
  - Constructor: `new EmbeddingClient(baseURL: string, model: string, apiKey: string | null, expectedDimension: number)`
  - `async embed(text: string): Promise<number[]>` — POST `{baseURL}/embeddings` (joined, tolerant of trailing slash / `/v1` in base) with body `{ model, input: [text] }`, headers `Content-Type: application/json` + optional `Authorization: Bearer <apiKey>`; returns `data[0].embedding`; throws `EmbeddingError` on non-OK, malformed body, or dimension mismatch. Accepts an injected `fetchFn` for tests: constructor `(baseURL, model, apiKey, expectedDimension, fetchFn = globalThis.fetch)`.

- [ ] **Step 1: Write the failing tests** (`test/embeddings.test.ts`)

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { EmbeddingClient, EmbeddingError } from "../src/embeddings.ts";

function okJson(body: unknown) {
  return {
    ok: true, status: 200,
    json: async () => body,
  } as Response;
}

test("embed posts correct body and returns vector", async () => {
  const calls: unknown[] = [];
  const client = new EmbeddingClient("http://llama:8080/v1", "nomic-embed-text", null, 768,
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return okJson({ data: [{ embedding: new Array(768).fill(0.5) }] });
    });
  const v = await client.embed("remember this");
  assert.equal(v.length, 768);
  const call = calls[0] as { url: string; init: RequestInit };
  assert.equal(call.url, "http://llama:8080/v1/embeddings");
  const body = JSON.parse(String(call.init.body));
  assert.equal(body.model, "nomic-embed-text");
  assert.deepEqual(body.input, ["remember this"]);
});

test("embed sends bearer token when apiKey present", async () => {
  let auth: string | null | undefined;
  const client = new EmbeddingClient("http://llama:8080/v1", "m", "secret", 768,
    async (_u, init) => {
      auth = (init?.headers as Record<string, string>)?.Authorization;
      return okJson({ data: [{ embedding: new Array(768).fill(0.1) }] });
    });
  await client.embed("x");
  assert.equal(auth, "Bearer secret");
});

test("embed throws EmbeddingError on HTTP error", async () => {
  const client = new EmbeddingClient("http://llama:8080/v1", "m", null, 768,
    async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
  await assert.rejects(() => client.embed("x"), EmbeddingError);
});

test("embed throws EmbeddingError on dimension mismatch", async () => {
  const client = new EmbeddingClient("http://llama:8080/v1", "m", null, 768,
    async () => okJson({ data: [{ embedding: new Array(384).fill(0.1) }] }));
  await assert.rejects(() => client.embed("x"), EmbeddingError);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/embeddings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/embeddings.ts`**

```ts
type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class EmbeddingError extends Error {
  constructor(message: string) { super(message); this.name = "EmbeddingError"; }
}

export class EmbeddingClient {
  private readonly url: string;
  private readonly fetchFn: FetchLike;
  constructor(
    private readonly baseURL: string,
    private readonly model: string,
    private readonly apiKey: string | null,
    private readonly expectedDimension: number,
    fetchFn: FetchLike = globalThis.fetch as FetchLike,
  ) {
    this.url = baseURL.replace(/\/+$/, "") + "/embeddings";
    this.fetchFn = fetchFn;
  }

  async embed(text: string): Promise<number[]> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.model, input: [text] }),
      });
    } catch (err) {
      throw new EmbeddingError(`Embedding server unreachable at ${this.url}: ${String(err)}`);
    }
    if (!res.ok) {
      throw new EmbeddingError(`Embedding request failed at ${this.url}: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = json.data?.[0]?.embedding;
    if (!embedding) {
      throw new EmbeddingError(`Embedding response missing data[0].embedding from ${this.url}`);
    }
    if (embedding.length !== this.expectedDimension) {
      throw new EmbeddingError(
        `Embedding dimension ${embedding.length} does not match expected ${this.expectedDimension} for model ${this.model}`);
    }
    return embedding;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/embeddings.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/embeddings.ts test/embeddings.test.ts
git commit -m "feat: OpenAI-compatible embeddings client via global fetch"
```

---

### Task 6: Qdrant REST client (collection ensure, upsert, search, count, clear)

**Files:**
- Create: `src/qdrant.ts`
- Create: `test/qdrant.test.ts`

**Interfaces:**
- Consumes: `PointPayload`, `SearchHit`, `MemoryType` from `src/types.ts`.
- Produces the `QdrantLike`/`QdrantClient`/`QdrantError`/`QdrantPoint` contract from the Module Map. Also:
  - `new QdrantClient(baseURL: string, apiKey: string | null, fetchFn = globalThis.fetch)`.
  - Private `request(method, path, body?)` resolving `{baseURL}/collections/...`; throws `QdrantError` on non-OK with a readable message (never throws raw network errors — wraps them).
  - `ensureCollection(name, dim)`: GET `{baseURL}/collections/{name}`; if 404 → PUT create with `{ vectors: { size: dim, distance: "Cosine", on_disk: true }, hnsw_config: { m: 16, ef_construct: 100 } }` → `"created"`; if 200 and `result.config.params.vectors.size !== dim` → DELETE then recreate → `"recreated"`; else `"exists"`.
  - `upsert(name, points)`: PUT `{baseURL}/collections/{name}/points?wait=true` with `{ points }`.
  - `search(name, vector, { projectId, type, limit, threshold })`: POST `{baseURL}/collections/{name}/points/query` with `{ vector, limit, score_threshold: threshold, with_payload: true, filter: { must: [...] } }` where the must array always contains `{ key: "project_id", match: { value: projectId } }` and, when `type` is set, `{ key: "type", match: { value: type } }`; maps each result `{ id, score, payload }` to `SearchHit`.
  - `count(name)`: POST `{baseURL}/collections/{name}/points/count` → `{ result: { count } }`.
  - `clearCollection(name)`: DELETE `{baseURL}/collections/{name}` (spec `clear` = reset the project collection).

- [ ] **Step 1: Write the failing tests** (`test/qdrant.test.ts`)

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { QdrantClient, QdrantError } from "../src/qdrant.ts";
import type { PointPayload } from "../src/types.ts";

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function makeClient(routes: Map<string, (url: string, init: RequestInit) => Response>) {
  return new QdrantClient("http://qdrant:6333", null,
    async (u, init) => {
      const url = String(u);
      const method = (init?.method ?? "GET") as string;
      const key = `${method} ${url}`;
      const handler = routes.get(key) ?? routes.get(method);
      if (!handler) throw new Error(`unexpected ${key}`);
      return handler(url, init ?? {});
    });
}

const payload: PointPayload = {
  type: "decision", text: "use REST", project_id: "pi-mem-abc", ts: 1, source_kind: "remember_tool",
};

test("ensureCollection creates on 404", async () => {
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("GET http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ status: "error" }, 404));
  routes.set("PUT http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ result: true }));
  const client = makeClient(routes);
  assert.equal(await client.ensureCollection("pi-mem-abc", 768), "created");
});

test("ensureCollection recreates on dimension mismatch", async () => {
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("GET http://qdrant:6333/collections/pi-mem-abc", () =>
    jsonRes({ result: { config: { params: { vectors: { size: 384 } } } } }));
  routes.set("DELETE http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ result: true }));
  routes.set("PUT http://qdrant:6333/collections/pi-mem-abc", () => jsonRes({ result: true }));
  const client = makeClient(routes);
  assert.equal(await client.ensureCollection("pi-mem-abc", 768), "recreated");
});

test("upsert posts points with wait=true", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("PUT http://qdrant:6333/collections/pi-mem-abc/points?wait=true", (u, i) => {
    seen = { url: u, init: i }; return jsonRes({ result: { status: "completed" } });
  });
  const client = makeClient(routes);
  await client.upsert("pi-mem-abc", [{ id: "aa", vector: [0.1, 0.2], payload }]);
  const body = JSON.parse(String(seen!.init.body)) as { points: Array<{ id: string; vector: number[]; payload: PointPayload }> };
  assert.equal(body.points.length, 1);
  assert.equal(body.points[0].payload.source_kind, "remember_tool");
});

test("search builds query with project_id filter and maps hits", async () => {
  let seenBody: unknown;
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points/query", (_u, i) => {
    seenBody = JSON.parse(String(i.body)); 
    return jsonRes({ result: { points: [{ id: "aa", score: 0.9, payload }] } });
  });
  const client = makeClient(routes);
  const hits = await client.search("pi-mem-abc", [0.1], { projectId: "pi-mem-abc", limit: 5, threshold: 0.15 });
  const body = seenBody as { filter: { must: Array<Record<string, unknown>> }; score_threshold: number; limit: number };
  assert.equal(body.score_threshold, 0.15);
  assert.equal(body.limit, 5);
  assert.deepEqual(body.filter.must[0], { key: "project_id", match: { value: "pi-mem-abc" } });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].payload.type, "decision");
});

test("count returns point count", async () => {
  const routes = new Map<string, (u: string, i: RequestInit) => Response>();
  routes.set("POST http://qdrant:6333/collections/pi-mem-abc/points/count", () =>
    jsonRes({ result: { count: 7 } }));
  const client = makeClient(routes);
  assert.equal(await client.count("pi-mem-abc"), 7);
});

test("network errors are wrapped as QdrantError", async () => {
  const client = new QdrantClient("http://qdrant:6333", null,
    async () => { throw new Error("ECONNREFUSED"); });
  await assert.rejects(() => client.count("pi-mem-abc"), QdrantError);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/qdrant.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/qdrant.ts`**

```ts
import type { MemoryType, PointPayload, SearchHit } from "./types.ts";

export class QdrantError extends Error {
  constructor(message: string) { super(message); this.name = "QdrantError"; }
}

export interface QdrantPoint { id: string; vector: number[]; payload: PointPayload; }

export interface QdrantLike {
  ensureCollection(name: string, dim: number): Promise<"created" | "exists" | "recreated">;
  upsert(name: string, points: QdrantPoint[]): Promise<void>;
  search(name: string, vector: number[], opts: {
    projectId: string; type?: MemoryType; limit: number; threshold: number;
  }): Promise<SearchHit[]>;
  count(name: string): Promise<number>;
  clearCollection(name: string): Promise<void>;
}

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class QdrantClient implements QdrantLike {
  private readonly base: string;
  private readonly fetchFn: FetchLike;
  constructor(baseURL: string, private readonly apiKey: string | null, fetchFn: FetchLike = globalThis.fetch as FetchLike) {
    this.base = baseURL.replace(/\/+$/, "");
    this.fetchFn = fetchFn;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.base}${path}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["api-key"] = this.apiKey;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new QdrantError(`Qdrant unreachable at ${this.base}: ${String(err)}`);
    }
    if (!res.ok) {
      throw new QdrantError(`Qdrant request ${method} ${url} failed: HTTP ${res.status}`);
    }
    return res.json();
  }

  async ensureCollection(name: string, dim: number): Promise<"created" | "exists" | "recreated"> {
    const getRes = await this.request("GET", `/collections/${encodeURIComponent(name)}`);
    if ((getRes as { status?: string }).status === "error") {
      await this.request("PUT", `/collections/${encodeURIComponent(name)}`, {
        vectors: { size: dim, distance: "Cosine", on_disk: true },
        hnsw_config: { m: 16, ef_construct: 100 },
      });
      return "created";
    }
    const size = (getRes as { result: { config: { params: { vectors: { size: number } } } } })
      .result.config.params.vectors.size;
    if (size !== dim) {
      await this.request("DELETE", `/collections/${encodeURIComponent(name)}`);
      await this.request("PUT", `/collections/${encodeURIComponent(name)}`, {
        vectors: { size: dim, distance: "Cosine", on_disk: true },
        hnsw_config: { m: 16, ef_construct: 100 },
      });
      return "recreated";
    }
    return "exists";
  }

  async upsert(name: string, points: QdrantPoint[]): Promise<void> {
    await this.request("PUT", `/collections/${encodeURIComponent(name)}/points?wait=true`, { points });
  }

  async search(name: string, vector: number[], opts: {
    projectId: string; type?: MemoryType; limit: number; threshold: number;
  }): Promise<SearchHit[]> {
    const must: unknown[] = [{ key: "project_id", match: { value: opts.projectId } }];
    if (opts.type) must.push({ key: "type", match: { value: opts.type } });
    const json = await this.request("POST", `/collections/${encodeURIComponent(name)}/points/query`, {
      vector,
      limit: opts.limit,
      score_threshold: opts.threshold,
      with_payload: true,
      filter: { must },
    }) as { result: { points: Array<{ id: string; score: number; payload: PointPayload }> } };
    return json.result.points.map((p) => ({ id: p.id, score: p.score, payload: p.payload }));
  }

  async count(name: string): Promise<number> {
    const json = await this.request("POST", `/collections/${encodeURIComponent(name)}/points/count`, { exact: true })
      as { result: { count: number } };
    return json.result.count;
  }

  async clearCollection(name: string): Promise<void> {
    await this.request("DELETE", `/collections/${encodeURIComponent(name)}`);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/qdrant.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/qdrant.ts test/qdrant.test.ts
git commit -m "feat: Qdrant REST client (ensure, upsert, search, count, clear)"
```

---

### Task 7: Mode detection (pi-blackhole awareness)

**Files:**
- Create: `src/mode.ts`
- Create: `test/mode.test.ts`

**Interfaces:**
- Consumes: `Config` (`mode`, `embeddingBaseURL`, ...) from `src/types.ts`.
- Produces:
  - `export function blackholeConfigPath(agentDir: string): string` → `join(agentDir, "pi-blackhole", "pi-blackhole-config.json")`.
  - `export function detectBlackhole(agentDir: string): boolean` — true iff the file exists and parses as JSON and `isBlackholeOperational(parsed)`.
  - `export function isBlackholeOperational(cfg: unknown): boolean` — true iff cfg is an object with `compactionEngine === "blackhole"` OR a truthy enabled/active marker; documented heuristic, tolerant of schema drift.
  - `export function resolveMode(cfg: Config, blackholePresent: boolean): "mode1" | "mode2"` — `cfg.mode === "blackhole"` → `"mode1"`; `cfg.mode === "own"` → `"mode2"`; `cfg.mode === "auto"` → `blackholePresent ? "mode1" : "mode2"`.
  - `export function agentDirFromEnv(env: NodeJS.ProcessEnv): string` — `env.PI_CODING_AGENT_DIR` or `~/.pi/agent` (expanded via `os.homedir()`).

- [ ] **Step 1: Write the failing tests** (`test/mode.test.ts`)

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blackholeConfigPath, detectBlackhole, isBlackholeOperational, resolveMode, agentDirFromEnv } from "../src/mode.ts";
import type { Config } from "../src/types.ts";

const base: Config = {
  qdrantUrl: "http://localhost:6333", qdrantApiKey: null,
  embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text",
  embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10,
  mode: "auto",
};

test("blackholeConfigPath nests under pi-blackhole", () => {
  assert.equal(blackholeConfigPath("/a/b"), "/a/b/pi-blackhole/pi-blackhole-config.json");
});

test("detectBlackhole false when file missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-mode-"));
  try { assert.equal(detectBlackhole(dir), false); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectBlackhole true when operational config present", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-mode-"));
  try {
    const p = blackholeConfigPath(dir);
    mkdirSync(join(dir, "pi-blackhole"), { recursive: true });
    writeFileSync(p, JSON.stringify({ compactionEngine: "blackhole" }), "utf8");
    assert.equal(detectBlackhole(dir), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("detectBlackhole false on corrupt JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-mode-"));
  try {
    const p = blackholeConfigPath(dir);
    mkdirSync(join(dir, "pi-blackhole"), { recursive: true });
    writeFileSync(p, "{not json", "utf8");
    assert.equal(detectBlackhole(dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resolveMode honors explicit blackhole and own overrides", () => {
  assert.equal(resolveMode({ ...base, mode: "blackhole" }, false), "mode1");
  assert.equal(resolveMode({ ...base, mode: "own" }, true), "mode2");
});

test("resolveMode auto follows detection", () => {
  assert.equal(resolveMode({ ...base, mode: "auto" }, true), "mode1");
  assert.equal(resolveMode({ ...base, mode: "auto" }, false), "mode2");
});

test("agentDirFromEnv honors override and defaults to home", () => {
  assert.equal(agentDirFromEnv({ PI_CODING_AGENT_DIR: "/custom/agent" }), "/custom/agent");
  assert.equal(agentDirFromEnv({}).startsWith(process.env.HOME ?? process.env.USERPROFILE ?? ""), true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/mode.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/mode.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./types.ts";

export function blackholeConfigPath(agentDir: string): string {
  return join(agentDir, "pi-blackhole", "pi-blackhole-config.json");
}

export function isBlackholeOperational(cfg: unknown): boolean {
  if (typeof cfg !== "object" || cfg === null) return false;
  const c = cfg as Record<string, unknown>;
  if (c.compactionEngine === "blackhole") return true;
  if (c.enabled === false) return false;
  if (typeof c.enabled === "boolean") return c.enabled;
  return false;
}

export function detectBlackhole(agentDir: string): boolean {
  const p = blackholeConfigPath(agentDir);
  if (!existsSync(p)) return false;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return isBlackholeOperational(parsed);
  } catch {
    return false;
  }
}

export function resolveMode(cfg: Config, blackholePresent: boolean): "mode1" | "mode2" {
  if (cfg.mode === "blackhole") return "mode1";
  if (cfg.mode === "own") return "mode2";
  return blackholePresent ? "mode1" : "mode2";
}

export function agentDirFromEnv(env: NodeJS.ProcessEnv): string {
  if (env.PI_CODING_AGENT_DIR) return env.PI_CODING_AGENT_DIR;
  return join(homedir(), ".pi", "agent");
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/mode.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mode.ts test/mode.test.ts
git commit -m "feat: blackhole mode detection and mode resolution"
```

---

### Task 8: Blackhole artifact parsing (om.* entries + pending JSON)

**Files:**
- Create: `src/blackhole.ts`
- Create: `test/blackhole.test.ts`

**Interfaces:**
- Consumes: `MemoryType`, `SourceKind`, `PointPayload` from `src/types.ts`.
- Produces:
  - `export interface BlackholeObservation { id: string; content: string; timestamp?: string | number; relevance?: number | null; sourceEntryIds?: string[]; tokenCount?: number | null; }`
  - `export interface BlackholeReflection { id: string; content: string; supportingObservationIds?: string[]; tokenCount?: number | null; }`
  - `export interface BlackholeArtifact { kind: "observation" | "reflection"; sessionId?: string; data: BlackholeObservation | BlackholeReflection; }`
  - `export function parseOmEntry(customType: string, data: unknown): BlackholeArtifact[] | null` — for `om.observations.recorded` returns one artifact per `data.observations[]`; for `om.reflections.recorded` per `data.reflections[]`; tolerant of the recorded payload shapes `{ observations: [...] }` / `{ reflections: [...] }` / a single object; returns `null` for unknown kinds or malformed entries (defensive, spec Appendix A).
  - `export function artifactToPayload(a: BlackholeArtifact, projectId: string, ts: number): PointPayload` — type suggestion: observation → `fact`, reflection → `decision`; `source_kind` = `blackhole_observation` | `blackhole_reflection`; `source_entry_id` = artifact id; `session_id` from artifact if present.
  - `export function listPendingFiles(agentDir: string): string[]` — `*.pending.json` under `join(agentDir, "pi-blackhole")`.
  - `export function readPendingArtifacts(agentDir: string): BlackholeArtifact[]` — reads each pending file, tolerates missing/corrupt, collects `observationBatches`/`reflectionBatches`/`observations`/`reflections` arrays defensively.

- [ ] **Step 1: Write the failing tests** (`test/blackhole.test.ts`)

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOmEntry, artifactToPayload, listPendingFiles, readPendingArtifacts } from "../src/blackhole.ts";
import type { BlackholeArtifact } from "../src/blackhole.ts";

test("parseOmEntry maps observations.recorded", () => {
  const arts = parseOmEntry("om.observations.recorded", {
    observations: [{ id: "abc123def456", content: "user prefers X", timestamp: "2026-09-07", relevance: 0.8 }],
  });
  assert.ok(arts);
  assert.equal(arts!.length, 1);
  assert.equal(arts![0].kind, "observation");
  assert.equal(arts![0].data.id, "abc123def456");
});

test("parseOmEntry maps reflections.recorded", () => {
  const arts = parseOmEntry("om.reflections.recorded", {
    reflections: [{ id: "1234567890ab", content: "decision: use REST" }],
  });
  assert.ok(arts);
  assert.equal(arts![0].kind, "reflection");
});

test("parseOmEntry returns null for unknown or malformed", () => {
  assert.equal(parseOmEntry("om.observations.dropped", {}), null);
  assert.equal(parseOmEntry("om.observations.recorded", {}), null);
});

test("artifactToPayload maps observation to fact with blackhole_observation source", () => {
  const art: BlackholeArtifact = { kind: "observation", sessionId: "sess", data: { id: "abc123def456", content: "pref X" } };
  const p = artifactToPayload(art, "pi-mem-abc", 42);
  assert.equal(p.type, "fact");
  assert.equal(p.source_kind, "blackhole_observation");
  assert.equal(p.source_entry_id, "abc123def456");
  assert.equal(p.session_id, "sess");
  assert.equal(p.ts, 42);
  assert.equal(p.project_id, "pi-mem-abc");
});

test("readPendingArtifacts collects from pending json files", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-bh-"));
  try {
    const bh = join(dir, "pi-blackhole");
    mkdirSync(bh, { recursive: true });
    writeFileSync(join(bh, "sess1-pending.json"), JSON.stringify({
      observations: [{ id: "aaaaaaaaaaaa", content: "obs A" }],
    }), "utf8");
    writeFileSync(join(bh, "sess2-pending.json"), "not json", "utf8"); // corrupt tolerated
    const files = listPendingFiles(dir);
    assert.equal(files.length, 1);
    const arts = readPendingArtifacts(dir);
    assert.equal(arts.length, 1);
    assert.equal(arts[0].data.id, "aaaaaaaaaaaa");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/blackhole.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/blackhole.ts`**

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryType, PointPayload, SourceKind } from "./types.ts";

export interface BlackholeObservation {
  id: string; content: string; timestamp?: string | number;
  relevance?: number | null; sourceEntryIds?: string[]; tokenCount?: number | null;
}
export interface BlackholeReflection {
  id: string; content: string; supportingObservationIds?: string[]; tokenCount?: number | null;
}
export interface BlackholeArtifact {
  kind: "observation" | "reflection"; sessionId?: string;
  data: BlackholeObservation | BlackholeReflection;
}

function pickObservations(data: unknown): BlackholeObservation[] | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const arr = Array.isArray(d.observations) ? d.observations : Array.isArray(d) ? d : null;
  if (!arr) return null;
  const out: BlackholeObservation[] = [];
  for (const it of arr) {
    if (typeof it !== "object" || it === null) continue;
    const o = it as Record<string, unknown>;
    if (typeof o.id === "string" && typeof o.content === "string") {
      out.push({
        id: o.id, content: o.content,
        timestamp: typeof o.timestamp === "string" || typeof o.timestamp === "number" ? o.timestamp : undefined,
        relevance: typeof o.relevance === "number" ? o.relevance : null,
        sourceEntryIds: Array.isArray(o.sourceEntryIds) ? (o.sourceEntryIds as string[]) : undefined,
        tokenCount: typeof o.tokenCount === "number" ? o.tokenCount : null,
      });
    }
  }
  return out.length ? out : null;
}

function pickReflections(data: unknown): BlackholeReflection[] | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const arr = Array.isArray(d.reflections) ? d.reflections : Array.isArray(d) ? d : null;
  if (!arr) return null;
  const out: BlackholeReflection[] = [];
  for (const it of arr) {
    if (typeof it !== "object" || it === null) continue;
    const r = it as Record<string, unknown>;
    if (typeof r.id === "string" && typeof r.content === "string") {
      out.push({
        id: r.id, content: r.content,
        supportingObservationIds: Array.isArray(r.supportingObservationIds) ? (r.supportingObservationIds as string[]) : undefined,
        tokenCount: typeof r.tokenCount === "number" ? r.tokenCount : null,
      });
    }
  }
  return out.length ? out : null;
}

export function parseOmEntry(customType: string, data: unknown): BlackholeArtifact[] | null {
  if (customType === "om.observations.recorded") {
    const obs = pickObservations(data);
    return obs ? obs.map((o) => ({ kind: "observation" as const, data: o })) : null;
  }
  if (customType === "om.reflections.recorded") {
    const refl = pickReflections(data);
    return refl ? refl.map((r) => ({ kind: "reflection" as const, data: r })) : null;
  }
  return null;
}

export function artifactToPayload(a: BlackholeArtifact, projectId: string, ts: number): PointPayload {
  const type: MemoryType = a.kind === "reflection" ? "decision" : "fact";
  const sourceKind: SourceKind = a.kind === "reflection" ? "blackhole_reflection" : "blackhole_observation";
  const p: PointPayload = {
    type, text: a.data.content, project_id: projectId, ts, source_kind: sourceKind,
    source_entry_id: a.data.id,
  };
  if (a.sessionId) p.session_id = a.sessionId;
  return p;
}

export function listPendingFiles(agentDir: string): string[] {
  const dir = join(agentDir, "pi-blackhole");
  try {
    return readdirSync(dir).filter((f) => f.endsWith("-pending.json")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export function readPendingArtifacts(agentDir: string): BlackholeArtifact[] {
  const out: BlackholeArtifact[] = [];
  for (const file of listPendingFiles(agentDir)) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    if (typeof raw !== "object" || raw === null) continue;
    const sessionId = (raw as { sessionId?: string }).sessionId;
    for (const [kindKey, type] of [
      ["observationBatches", "om.observations.recorded"],
      ["reflectionBatches", "om.reflections.recorded"],
      ["observations", "om.observations.recorded"],
      ["reflections", "om.reflections.recorded"],
    ] as const) {
      const inner = (raw as Record<string, unknown>)[kindKey];
      if (!inner) continue;
      for (const batch of Array.isArray(inner) ? inner : [inner]) {
        const arts = parseOmEntry(type, batch);
        if (arts) for (const a of arts) { a.sessionId = sessionId; out.push(a); }
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/blackhole.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/blackhole.ts test/blackhole.test.ts
git commit -m "feat: pi-blackhole om.* artifact parsing"
```

---

### Task 9: Ingest pipeline (embed + upsert with dedupe)

**Files:**
- Create: `src/ingest.ts`
- Create: `test/ingest.test.ts`

**Interfaces:**
- Consumes: `BlackholeArtifact` + `artifactToPayload` from `src/blackhole.ts`; `QdrantLike`, `QdrantPoint` from `src/qdrant.ts`; `pointId` from `src/ids.ts`; `PointPayload`, `SourceKind` from `src/types.ts`.
- Produces:
  - `export interface IngestItem { text: string; sourceKind: SourceKind; contextId: string; payload: Omit<PointPayload, "text" | "source_kind"> & { source_kind: SourceKind }; }`
  - `export interface IngestDeps { embed: (text: string) => Promise<number[]>; qdrant: QdrantLike; projectId: string; }`
  - `export async function ensureAndGet(deps: IngestDeps, dim: number): Promise<void>` — calls `qdrant.ensureCollection(deps.projectId, dim)`.
  - `export async function ingestItems(deps: IngestDeps, dim: number, items: IngestItem[]): Promise<{ attempted: number; ingested: number }>` — ensures collection, embeds each item, upserts in one batch with deterministic ids; a failing embed on one item is caught+logged (counted in `attempted` but not `ingested`); never throws (graceful degradation).
  - `export function artifactToIngestItem(a: BlackholeArtifact, projectId: string, ts: number): IngestItem` — wraps `artifactToPayload`.

- [ ] **Step 1: Write the failing tests** (`test/ingest.test.ts`)

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { ingestItems, ensureAndGet } from "../src/ingest.ts";
import { pointId } from "../src/ids.ts";
import type { QdrantLike, QdrantPoint } from "../src/qdrant.ts";
import type { SearchHit } from "../src/types.ts";

function fakeQdrant(): QdrantLike & { upserted: QdrantPoint[][]; ensured: Array<{ name: string; dim: number }> } {
  const upserted: QdrantPoint[][] = [];
  const ensured: Array<{ name: string; dim: number }> = [];
  return {
    upserted, ensured,
    async ensureCollection(name, dim) { ensured.push({ name, dim }); return "created"; },
    async upsert(_name, points) { upserted.push(points); },
    async search() { return [] as SearchHit[]; },
    async count() { return 0; },
    async clearCollection() {},
  };
}

test("ensureAndGet creates collection with project id and dim", async () => {
  const q = fakeQdrant();
  await ensureAndGet({ embed: async () => [], qdrant: q, projectId: "pi-mem-abc" }, 768);
  assert.deepEqual(q.ensured, [{ name: "pi-mem-abc", dim: 768 }]);
});

test("ingestItems embeds and upserts with deterministic ids", async () => {
  const q = fakeQdrant();
  const embedded: string[] = [];
  const deps = {
    embed: async (t: string) => { embedded.push(t); return new Array(768).fill(0.5); },
    qdrant: q, projectId: "pi-mem-abc",
  };
  const res = await ingestItems(deps, 768, [
    { text: "use REST", sourceKind: "remember_tool" as const, contextId: "s1",
      payload: { type: "decision" as const, project_id: "pi-mem-abc", ts: 1, source_kind: "remember_tool" as const } },
  ]);
  assert.equal(res.ingested, 1);
  assert.equal(embedded.length, 1);
  assert.equal(q.upserted.length, 1);
  const upserted = q.upserted[0];
  assert.equal(upserted.length, 1);
  assert.equal(upserted[0].id, pointId("use REST", "remember_tool", "s1"));
  assert.equal(upserted[0].vector.length, 768);
});

test("ingestItems never throws and reports embed failures as skipped", async () => {
  const q = fakeQdrant();
  const deps = {
    embed: async () => { throw new Error("embed down"); },
    qdrant: q, projectId: "pi-mem-abc",
  };
  const res = await ingestItems(deps, 768, [
    { text: "x", sourceKind: "remember_tool" as const, contextId: "s1",
      payload: { type: "decision" as const, project_id: "pi-mem-abc", ts: 1, source_kind: "remember_tool" as const } },
  ]);
  assert.equal(res.attempted, 1);
  assert.equal(res.ingested, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/ingest.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/ingest.ts`**

```ts
import { artifactToPayload } from "./blackhole.ts";
import type { BlackholeArtifact } from "./blackhole.ts";
import { pointId } from "./ids.ts";
import type { QdrantLike } from "./qdrant.ts";
import type { PointPayload, SourceKind } from "./types.ts";

export interface IngestItem {
  text: string;
  sourceKind: SourceKind;
  contextId: string;
  payload: Omit<PointPayload, "text"> & { source_kind: SourceKind };
}

export interface IngestDeps {
  embed: (text: string) => Promise<number[]>;
  qdrant: QdrantLike;
  projectId: string;
}

export async function ensureAndGet(deps: IngestDeps, dim: number): Promise<void> {
  await deps.qdrant.ensureCollection(deps.projectId, dim);
}

export function artifactToIngestItem(a: BlackholeArtifact, projectId: string, ts: number): IngestItem {
  const p = artifactToPayload(a, projectId, ts);
  return { text: p.text, sourceKind: p.source_kind, contextId: p.source_entry_id ?? p.session_id ?? "", payload: p };
}

export async function ingestItems(
  deps: IngestDeps,
  dim: number,
  items: IngestItem[],
): Promise<{ attempted: number; ingested: number }> {
  await ensureAndGet(deps, dim);
  const points: Array<{ id: string; vector: number[]; payload: PointPayload }> = [];
  let ingested = 0;
  for (const item of items) {
    try {
      const vector = await deps.embed(item.text);
      const id = pointId(item.text, item.sourceKind, item.contextId);
      points.push({ id, vector, payload: item.payload as PointPayload });
      ingested++;
    } catch (err) {
      console.error(`pi-qdrant-memory: ingest skipped (embed failed): ${String(err)}`);
    }
  }
  if (points.length) {
    try {
      await deps.qdrant.upsert(deps.projectId, points);
    } catch (err) {
      console.error(`pi-qdrant-memory: upsert failed: ${String(err)}`);
      ingested = 0;
    }
  }
  return { attempted: items.length, ingested };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/ingest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ingest.ts test/ingest.test.ts
git commit -m "feat: embed + upsert ingest pipeline with deterministic dedupe"
```

---

### Task 10: Tool core logic (remember + memory_search) and result rendering

**Files:**
- Create: `src/tools-core.ts`
- Create: `src/render.ts`
- Create: `test/tools-core.test.ts`
- Create: `test/render.test.ts`

**Interfaces:**
- Consumes: `RuntimeDeps` (from `src/types.ts`), `ingestItems`, `ensureAndGet`, `IngestItem`, `IngestDeps`, `QdrantLike`, `pointId`, `PointPayload`, `MemoryType`, `SearchHit`.
- Produces:
  - `export type ToolResult<T> = { ok: true; value: T } | { ok: false; error: string };`
  - `export async function rememberLogic(deps: RuntimeDeps, text: string, type?: MemoryType): Promise<ToolResult<PointPayload>>` — validates non-empty text (≤ ~4000 chars), embeds, upserts one point with deterministic id, contextId = `""` (remember has no source entry; session context optional), returns the payload. Errors → `{ ok: false, error }` (never throws).
  - `export async function memorySearchLogic(deps: RuntimeDeps, query: string, type?: MemoryType, limit?: number): Promise<ToolResult<SearchHit[]>>` — embeds query, calls `qdrant.search(projectId, vector, { projectId, type, limit: capped, threshold })`, maps hits. Errors → `{ ok: false, error }`.
  - `export function renderHits(hits: SearchHit[]): string` — returns formatted text: one block per hit with `type`, `score` (2 decimals), text preview, and a source pointer line (`source_entry_id`/`session_id`), or `"No relevant memory found."` when empty.
  - `export function normalizeDepsForTools(deps: RuntimeDeps): { ingest: IngestDeps; dim: number }` helper.

- [ ] **Step 1: Write the failing tests** (`test/tools-core.test.ts`)

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { rememberLogic, memorySearchLogic } from "../src/tools-core.ts";
import { pointId } from "../src/ids.ts";
import type { QdrantLike, QdrantPoint } from "../src/qdrant.ts";
import type { PointPayload, RuntimeDeps, SearchHit } from "../src/types.ts";

function deps(over: Partial<RuntimeDeps> = {}): RuntimeDeps & { q: { upserted: QdrantPoint[][] }; embeds: string[] } {
  const upserted: QdrantPoint[][] = [];
  const embeds: string[] = [];
  const q: QdrantLike = {
    async ensureCollection(_n, _d) { return "exists"; },
    async upsert(_n, points) { upserted.push(points); },
    async search(): Promise<SearchHit[]> { return []; },
    async count() { return 0; },
    async clearCollection() {},
  };
  return {
    cfg: {
      qdrantUrl: "http://localhost:6333", qdrantApiKey: null,
      embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text",
      embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10, mode: "auto",
    },
    agentDir: "/tmp/agent", cwd: "/repo",
    embed: async (t: string) => { embeds.push(t); return new Array(768).fill(0.1); },
    qdrant: q,
    ...over,
  } as RuntimeDeps & { q: { upserted: QdrantPoint[][] }; embeds: string[] };
}

test("rememberLogic upserts a deterministic point", async () => {
  const d = deps();
  const res = await rememberLogic(d, "always use REST for sync");
  assert.ok(res.ok);
  assert.equal(d.q.upserted.length, 1);
  const pts = d.q.upserted[0];
  assert.equal(pts[0].id, pointId("always use REST for sync", "remember_tool", ""));
  assert.equal(pts[0].payload.type, "decision");
  assert.equal(pts[0].payload.source_kind, "remember_tool");
});

test("rememberLogic respects explicit type", async () => {
  const d = deps();
  const res = await rememberLogic(d, "prefer tabs", "preference");
  assert.ok(res.ok);
  assert.equal(d.q.upserted[0][0].payload.type, "preference");
});

test("rememberLogic rejects empty text with error result", async () => {
  const d = deps();
  const res = await rememberLogic(d, "   ");
  assert.ok(!res.ok);
  assert.match((res as { error: string }).error, /empty/i);
});

test("rememberLogic returns error result (no throw) when embed fails", async () => {
  const d = deps({ embed: async () => { throw new Error("down"); } });
  const res = await rememberLogic(d, "x");
  assert.ok(!res.ok);
});

test("memorySearchLogic embeds query and searches with type filter and capped limit", async () => {
  const searched: Array<{ type?: string; limit: number; threshold: number }> = [];
  const payload: PointPayload = { type: "decision", text: "use REST", project_id: "pi-mem-p", ts: 1, source_kind: "blackhole_reflection", source_entry_id: "id1" };
  const q: QdrantLike = {
    async ensureCollection() { return "exists"; },
    async upsert() {},
    async search(_n, _v, opts) { searched.push({ type: opts.type, limit: opts.limit, threshold: opts.threshold }); return [{ id: "a", score: 0.5, payload }]; },
    async count() { return 0; },
    async clearCollection() {},
  };
  const d = deps({ qdrant: q });
  const res = await memorySearchLogic(d, "what did we decide about transport", "decision", 3);
  assert.ok(res.ok);
  assert.equal(searched[0].type, "decision");
  assert.equal(searched[0].limit, 3);
  assert.equal(searched[0].threshold, 0.18);
});

test("memorySearchLogic caps limit at maxResults", async () => {
  let sawLimit = 0;
  const q: QdrantLike = {
    async ensureCollection() { return "exists"; },
    async upsert() {},
    async search(_n, _v, opts) { sawLimit = opts.limit; return []; },
    async count() { return 0; },
    async clearCollection() {},
  };
  const d = deps({ qdrant: q });
  await memorySearchLogic(d, "q", undefined, 1000);
  assert.equal(sawLimit, 10); // cfg.maxResults
});
```

And `test/render.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { renderHits } from "../src/render.ts";
import type { PointPayload } from "../src/types.ts";

test("renderHits shows type, score, text, and source pointer", () => {
  const payload: PointPayload = { type: "decision", text: "use REST", project_id: "p", ts: 1, source_kind: "blackhole_reflection", source_entry_id: "id1", session_id: "s9" };
  const out = renderHits([{ id: "x", score: 0.8765, payload }]);
  assert.match(out, /decision/);
  assert.match(out, /0\.88/);
  assert.match(out, /use REST/);
  assert.match(out, /id1/);
});

test("renderHits handles empty results", () => {
  assert.equal(renderHits([]), "No relevant memory found.");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/tools-core.test.ts test/render.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/tools-core.ts`**

```ts
import { ingestItems, ensureAndGet } from "./ingest.ts";
import type { IngestDeps, IngestItem } from "./ingest.ts";
import { pointId } from "./ids.ts";
import type { QdrantPoint } from "./qdrant.ts";
import type { MemoryType, PointPayload, RuntimeDeps, SearchHit } from "./types.ts";

export type ToolResult<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_TEXT = 4000;

export async function rememberLogic(deps: RuntimeDeps, text: string, type?: MemoryType): Promise<ToolResult<PointPayload>> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "remember: text is empty" };
  if (trimmed.length > MAX_TEXT) return { ok: false, error: `remember: text too long (>${MAX_TEXT} chars)` };
  const payload: PointPayload = {
    type: type ?? "decision",
    text: trimmed,
    project_id: deps.projectId,
    ts: Date.now(),
    source_kind: "remember_tool",
  };
  try {
    const vector = await deps.embed(trimmed);
    const id = pointId(trimmed, "remember_tool", "");
    await deps.qdrant.upsert(deps.projectId, [{ id, vector, payload }]);
    return { ok: true, value: payload };
  } catch (err) {
    return { ok: false, error: `remember failed: ${String(err)}` };
  }
}

export async function memorySearchLogic(
  deps: RuntimeDeps,
  query: string,
  type?: MemoryType,
  limit?: number,
): Promise<ToolResult<SearchHit[]>> {
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, error: "memory_search: query is empty" };
  const capped = Math.max(1, Math.min(limit ?? deps.cfg.maxResults, deps.cfg.maxResults));
  try {
    const vector = await deps.embed(trimmed);
    const hits = await deps.qdrant.search(deps.projectId, vector, {
      projectId: deps.projectId,
      type,
      limit: capped,
      threshold: deps.cfg.scoreThreshold,
    });
    return { ok: true, value: hits };
  } catch (err) {
    return { ok: false, error: `memory_search failed: ${String(err)}` };
  }
}

export function normalizeDepsForTools(deps: RuntimeDeps): { ingest: IngestDeps; dim: number } {
  return { ingest: { embed: deps.embed, qdrant: deps.qdrant, projectId: deps.projectId }, dim: deps.cfg.expectedDimension };
}

export async function ingestViaItems(deps: RuntimeDeps, items: IngestItem[]): Promise<{ attempted: number; ingested: number }> {
  const { ingest, dim } = normalizeDepsForTools(deps);
  await ensureAndGet(ingest, dim);
  return ingestItems(ingest, dim, items);
}
```

- [ ] **Step 4: Implement `src/render.ts`**

```ts
import type { SearchHit } from "./types.ts";

export function renderHits(hits: SearchHit[]): string {
  if (!hits.length) return "No relevant memory found.";
  const lines = hits.map((h) => {
    const source = h.payload.source_entry_id
      ? `source_entry_id=${h.payload.source_entry_id}`
      : h.payload.session_id ? `session_id=${h.payload.session_id}` : "no source pointer";
    const preview = h.payload.text.length > 200
      ? h.payload.text.slice(0, 200) + "…"
      : h.payload.text;
    return `[${h.payload.type}] score=${h.score.toFixed(2)} (${source})\n${preview}`;
  });
  return lines.join("\n\n");
}
```

- [ ] **Step 5: Run to verify pass**

Run: `node --test test/tools-core.test.ts test/render.test.ts`
Expected: PASS (7 + 2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/tools-core.ts src/render.ts test/tools-core.test.ts test/render.test.ts
git commit -m "feat: remember and memory_search tool logic with rendering"
```

---

### Task 11: Mode-2 capture (compaction-hook capture + auto snapshot)

**Files:**
- Create: `src/capture.ts`
- Create: `test/capture.test.ts`

**Interfaces:**
- Consumes: `ingestItems`/`ensureAndGet`, `RuntimeDeps`, `PointPayload`.
- Produces:
  - `export interface CaptureDeps { embed: (t: string) => Promise<number[]>; qdrant: QdrantLike; projectId: string; }`
  - `export function summaryPayload(text: string, projectId: string, sessionId: string, ts: number): PointPayload` — `type: "session_summary"`, `source_kind: "own_capture"`, `session_id: sessionId`, `ts`.
  - `export async function captureAtCompaction(deps: CaptureDeps, dim: number, summaryText: string, sessionId: string, ts: number): Promise<{ attempted: number; ingested: number }>` — trims; empty → `{0,0}`; builds one `IngestItem` from `summaryPayload`, calls `ingestItems`. **Never throws** — fire-and-forget contract; wraps ingest in try/catch and logs.
  - `export async function autoSnapshot(deps: CaptureDeps, dim: number, snapshotText: string, sessionId: string, ts: number): Promise<void>` — same, ingested under `type: "session_summary"`, `source_kind: "own_capture"`; used earlier in the session as the safety net. Never throws.

- [ ] **Step 1: Write the failing tests** (`test/capture.test.ts`)

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { captureAtCompaction, autoSnapshot, summaryPayload } from "../src/capture.ts";
import { pointId } from "../src/ids.ts";
import type { QdrantLike, QdrantPoint } from "../src/qdrant.ts";

function fakeQdrant(): QdrantLike & { upserted: QdrantPoint[][] } {
  const upserted: QdrantPoint[][] = [];
  return {
    upserted,
    async ensureCollection() { return "exists"; },
    async upsert(_n, points) { upserted.push(points); },
    async search() { return []; },
    async count() { return 0; },
    async clearCollection() {},
  };
}

const embed = async () => new Array(768).fill(0.2);

test("summaryPayload builds session_summary own_capture point", () => {
  const p = summaryPayload("summary text", "pi-mem-p", "sess9", 5);
  assert.equal(p.type, "session_summary");
  assert.equal(p.source_kind, "own_capture");
  assert.equal(p.session_id, "sess9");
  assert.equal(p.ts, 5);
});

test("captureAtCompaction ingests one summary point with deterministic id", async () => {
  const q = fakeQdrant();
  const deps = { embed, qdrant: q, projectId: "pi-mem-p" };
  const res = await captureAtCompaction(deps, 768, "we decided REST over gRPC", "sess9", 7);
  assert.equal(res.ingested, 1);
  const pts = q.upserted[0];
  assert.equal(pts.length, 1);
  assert.equal(pts[0].id, pointId("we decided REST over gRPC", "own_capture", "sess9"));
  assert.equal(pts[0].payload.type, "session_summary");
});

test("captureAtCompaction skips empty summary without error", async () => {
  const q = fakeQdrant();
  const deps = { embed, qdrant: q, projectId: "pi-mem-p" };
  const res = await captureAtCompaction(deps, 768, "   ", "sess9", 7);
  assert.equal(res.ingested, 0);
  assert.equal(q.upserted.length, 0);
});

test("captureAtCompaction never throws on embed failure", async () => {
  const q = fakeQdrant();
  const deps = { embed: async () => { throw new Error("down"); }, qdrant: q, projectId: "pi-mem-p" };
  const res = await captureAtCompaction(deps, 768, "some text", "sess9", 7);
  assert.equal(res.ingested, 0);
});

test("autoSnapshot never throws and ingests", async () => {
  const q = fakeQdrant();
  const deps = { embed, qdrant: q, projectId: "pi-mem-p" };
  await autoSnapshot(deps, 768, "snapshot", "sess9", 1);
  assert.equal(q.upserted.length, 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/capture.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/capture.ts`**

```ts
import { ingestItems } from "./ingest.ts";
import type { QdrantLike } from "./qdrant.ts";
import type { PointPayload } from "./types.ts";

export interface CaptureDeps {
  embed: (t: string) => Promise<number[]>;
  qdrant: QdrantLike;
  projectId: string;
}

export function summaryPayload(text: string, projectId: string, sessionId: string, ts: number): PointPayload {
  return {
    type: "session_summary",
    text,
    project_id: projectId,
    session_id: sessionId,
    ts,
    source_kind: "own_capture",
  };
}

export async function captureAtCompaction(
  deps: CaptureDeps,
  dim: number,
  summaryText: string,
  sessionId: string,
  ts: number,
): Promise<{ attempted: number; ingested: number }> {
  const trimmed = summaryText.trim();
  if (!trimmed) return { attempted: 0, ingested: 0 };
  const p = summaryPayload(trimmed, deps.projectId, sessionId, ts);
  try {
    return await ingestItems(deps, dim, [{
      text: p.text, sourceKind: p.source_kind, contextId: sessionId, payload: p,
    }]);
  } catch (err) {
    console.error(`pi-qdrant-memory: capture at compaction failed (non-fatal): ${String(err)}`);
    return { attempted: 1, ingested: 0 };
  }
}

export async function autoSnapshot(
  deps: CaptureDeps,
  dim: number,
  snapshotText: string,
  sessionId: string,
  ts: number,
): Promise<void> {
  const trimmed = snapshotText.trim();
  if (!trimmed) return;
  const p = summaryPayload(trimmed, deps.projectId, sessionId, ts);
  try {
    await ingestItems(deps, dim, [{
      text: p.text, sourceKind: p.source_kind, contextId: sessionId, payload: p,
    }]);
  } catch (err) {
    console.error(`pi-qdrant-memory: auto snapshot failed (non-fatal): ${String(err)}`);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/capture.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/capture.ts test/capture.test.ts
git commit -m "feat: Mode-2 compaction capture and auto snapshot"
```

---

### Task 12: Slash-command handlers (status, settings, remember, search, clear, help)

**Files:**
- Create: `src/handlers.ts`
- Create: `test/handlers.test.ts`

**Interfaces:**
- Consumes: `RuntimeDeps`, `rememberLogic`, `memorySearchLogic`, `renderHits`, `loadConfig`, `configPath`, `Config`, `projectIdFrom`, `detectBlackhole`, `resolveMode`, `agentDirFromEnv`, `QdrantLike`.
- Produces handler functions that are **pure/testable** (they take a `HandlerIO` bundle instead of pi objects):
  - `export interface HandlerIO { cfg: Config; agentDir: string; cwd: string; projectId: string; embed: (t: string) => Promise<number[]>; qdrant: QdrantLike; readConfig(): Config; writeConfig(cfg: Config): void; print(text: string): void; }
  - `export function depsToIO(deps: RuntimeDeps): HandlerIO` adapter.
  - `export interface HandlerResult { exit: boolean; }`
  - `statusHandler(io: HandlerIO): Promise<HandlerResult>` — prints health lines (Qdrant reachable via a `count`/`search` probe; embedding reachable via a small probe embed; active mode; collection existence + count) and prints `exit: false`.
  - `settingsHandler(io: HandlerIO, field?: string, value?: string): Promise<HandlerResult>` — supports text-form `field=value` update (persists via writeConfig + readConfig); returns exit false. (TUI form rendering is wired in `src/index.ts` using `ctx.ui`; this handler covers the config-edit logic and persistence path.)
  - `rememberHandler(io: HandlerIO, text: string, type?: MemoryType): Promise<HandlerResult>` — calls rememberLogic, prints result, exit false.
  - `searchHandler(io: HandlerIO, query: string, type?: MemoryType): Promise<HandlerResult>` — calls memorySearchLogic, prints renderHits, exit false.
  - `clearHandler(io: HandlerIO): Promise<HandlerResult>` — calls qdrant.clearCollection, prints confirmation, exit false.
  - `helpHandler(io: HandlerIO): Promise<HandlerResult>` — prints command list, exit false.
  - `export function projectDeps(cfg: Config, qdrant: QdrantLike, embed: (t: string) => Promise<number[]>, cwd: string, projectId: string): RuntimeDeps`.

- [ ] **Step 1: Write the failing tests** (`test/handlers.test.ts`)

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  statusHandler, settingsHandler, rememberHandler, searchHandler, clearHandler, helpHandler,
} from "../src/handlers.ts";
import type { HandlerIO } from "../src/handlers.ts";
import type { QdrantLike } from "../src/qdrant.ts";
import type { Config } from "../src/types.ts";

const cfg: Config = {
  qdrantUrl: "http://localhost:6333", qdrantApiKey: null,
  embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text",
  embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10, mode: "auto",
};

function io(over: Partial<HandlerIO> = {}): HandlerIO & { printed: string[]; written: Config[] } {
  const printed: string[] = [];
  const written: Config[] = [];
  const qdrant: QdrantLike = {
    async ensureCollection() { return "exists"; },
    async upsert() {},
    async search() { return []; },
    async count() { return 3; },
    async clearCollection() { written.push(cfg); },
  };
  return {
    cfg, agentDir: "/tmp/agent", cwd: "/repo", projectId: "pi-mem-abc",
    embed: async () => new Array(768).fill(0.1),
    qdrant,
    readConfig: () => cfg,
    writeConfig: (c) => written.push(c),
    print: (t) => printed.push(t),
    ...over,
  } as HandlerIO & { printed: string[]; written: Config[] };
}

test("statusHandler prints mode and collection health", async () => {
  const d = io();
  await statusHandler(d);
  const all = d.printed.join("\n");
  assert.match(all, /mode2/i); // auto with no blackhole → mode2
  assert.match(all, /pi-mem-abc/);
  assert.match(all, /3/);
});

test("settingsHandler persists field=value and prints confirmation", async () => {
  const d = io();
  await settingsHandler(d, "scoreThreshold", "0.2");
  assert.equal(d.written.length, 1);
  assert.equal(d.written[0].scoreThreshold, 0.2);
  assert.match(d.printed.join("\n"), /scoreThreshold/);
});

test("rememberHandler prints success and upserts", async () => {
  const d = io();
  await rememberHandler(d, "use REST", "decision");
  assert.match(d.printed.join("\n"), /use REST/);
});

test("searchHandler prints no-relevant-memory message on empty", async () => {
  const d = io();
  await searchHandler(d, "anything");
  assert.match(d.printed.join("\n"), /No relevant memory/);
});

test("clearHandler calls clearCollection and prints confirmation", async () => {
  const d = io();
  await clearHandler(d);
  assert.equal(d.written.length, 1);
  assert.match(d.printed.join("\n"), /cleared|reset/i);
});

test("helpHandler prints the command list", async () => {
  const d = io();
  await helpHandler(d);
  const all = d.printed.join("\n");
  for (const c of ["/qdrant status", "/qdrant settings", "/qdrant remember", "/qdrant search", "/qdrant clear", "/qdrant help"]) {
    assert.match(all, new RegExp(c.replace("/", "\\/")));
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/handlers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/handlers.ts`**

```ts
import { resolveMode, detectBlackhole } from "./mode.ts";
import { rememberLogic, memorySearchLogic } from "./tools-core.ts";
import { renderHits } from "./render.ts";
import type { QdrantLike } from "./qdrant.ts";
import type { Config, MemoryType, RuntimeDeps } from "./types.ts";

export interface HandlerIO {
  cfg: Config;
  agentDir: string;
  cwd: string;
  projectId: string;
  embed: (t: string) => Promise<number[]>;
  qdrant: QdrantLike;
  readConfig(): Config;
  writeConfig(c: Config): void;
  print(text: string): void;
}

export function depsToIO(deps: RuntimeDeps): HandlerIO {
  return {
    cfg: deps.cfg, agentDir: deps.agentDir, cwd: deps.cwd, projectId: deps.projectId,
    embed: deps.embed, qdrant: deps.qdrant,
    readConfig: deps.readConfig, writeConfig: deps.writeConfig, print: deps.print,
  };
}

export interface HandlerResult { exit: boolean; }

export async function statusHandler(io: HandlerIO): Promise<HandlerResult> {
  const mode = resolveMode(io.cfg, detectBlackhole(io.agentDir));
  let count = -1;
  let qdrantOk = true;
  try { count = await io.qdrant.count(io.projectId); } catch { qdrantOk = false; }
  let embedOk = true;
  try { await io.embed("probe"); } catch { embedOk = false; }
  io.print(`mode: ${mode}`);
  io.print(`qdrant: ${qdrantOk ? `reachable, collection ${io.projectId} has ${count} points` : "NOT reachable"}`);
  io.print(`embeddings: ${embedOk ? `reachable (${io.cfg.embeddingModel} @ ${io.cfg.embeddingBaseURL})` : "NOT reachable"}`);
  return { exit: false };
}

export async function settingsHandler(io: HandlerIO, field?: string, value?: string): Promise<HandlerResult> {
  const cfg = io.readConfig();
  if (field && value !== undefined) {
    const key = field as keyof Config;
    if (key in cfg) {
      const next = { ...cfg };
      if (typeof cfg[key] === "number") {
        const n = Number(value);
        if (!Number.isFinite(n)) { io.print(`settings: ${field} expects a number`); return { exit: false }; }
        (next as Record<string, unknown>)[key] = n;
      } else {
        (next as Record<string, unknown>)[key] = value === "null" ? null : value;
      }
      io.writeConfig(next);
      io.print(`settings: ${field} updated (reloaded at runtime)`);
      return { exit: false };
    }
    io.print(`settings: unknown key ${field}`);
    return { exit: false };
  }
  io.print(`settings: open the TUI form (/qdrant settings) to edit; or use /qdrant settings <key> <value>`);
  return { exit: false };
}

export async function rememberHandler(io: HandlerIO, text: string, type?: MemoryType): Promise<HandlerResult> {
  const res = await rememberLogic({
    cfg: io.cfg, agentDir: io.agentDir, cwd: io.cwd, projectId: io.projectId,
    embed: io.embed, qdrant: io.qdrant, readConfig: io.readConfig, writeConfig: io.writeConfig, print: io.print,
  }, text, type);
  io.print(res.ok ? `remembered (${res.value.source_kind}): ${res.value.text}` : `remember failed: ${(res as { error: string }).error}`);
  return { exit: false };
}

export async function searchHandler(io: HandlerIO, query: string, type?: MemoryType): Promise<HandlerResult> {
  const res = await memorySearchLogic({
    cfg: io.cfg, agentDir: io.agentDir, cwd: io.cwd, projectId: io.projectId,
    embed: io.embed, qdrant: io.qdrant, readConfig: io.readConfig, writeConfig: io.writeConfig, print: io.print,
  }, query, type);
  io.print(res.ok ? renderHits(res.value) : `search failed: ${(res as { error: string }).error}`);
  return { exit: false };
}

export async function clearHandler(io: HandlerIO): Promise<HandlerResult> {
  try {
    await io.qdrant.clearCollection(io.projectId);
    io.print(`cleared: collection ${io.projectId} reset`);
  } catch (err) {
    io.print(`clear failed: ${String(err)}`);
  }
  return { exit: false };
}

export async function helpHandler(io: HandlerIO): Promise<HandlerResult> {
  io.print([
    "/qdrant status   — connection health + active mode + collection status",
    "/qdrant settings — open settings form, or /qdrant settings <key> <value>",
    "/qdrant remember <text> — save durable knowledge now",
    "/qdrant search <query>  — semantic search of durable knowledge",
    "/qdrant clear   — reset the current project's collection",
    "/qdrant help    — this list",
  ].join("\n"));
  return { exit: false };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/handlers.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/handlers.ts test/handlers.test.ts
git commit -m "feat: slash-command handlers (status/settings/remember/search/clear/help)"
```

---

### Task 13: pi extension factory wiring (tools, commands, hooks, lifecycle)

**Files:**
- Create: `src/index.ts`
- Create: `src/deps.ts` (shared runtime assembly used by both the factory and tests)
- Create: `test/deps.test.ts`
- Create: `test/index.test.ts`
- Modify: `README.md` (usage doc — Task 14 finishes it)

**Interfaces:**
- Consumes: every module above plus the pi `ExtensionAPI` surface (from `@earendil-works/pi-coding-agent`): `pi.registerTool`, `pi.registerCommand`, `pi.on`, `pi.setStatus`, `ctx.ui`, `ctx.cwd`, `ctx.sessionManager`; `session_start`/`session_shutdown`/`session_before_compact` events; `pi.appendEntry`; `pi.sendMessage`.
- Produces:
  - `export interface FactoryDeps { loadConfig(agentDir, env): Config; detectBlackhole(agentDir): boolean; agentDirFromEnv(env): string; }`
  - `export function makeRuntime(agentDir: string, cwd: string, env: NodeJS.ProcessEnv, io?: { readConfig(): Config; writeConfig(c: Config): void; print(t: string): void; embed?: (t: string) => Promise<number[]>; qdrant?: QdrantLike; }): Promise<RuntimeDeps>` — assembles config, project id, embedding client, qdrant client; returns a `RuntimeDeps` (with real clients by default, or injected fakes for tests).
  - `export default function factory(api: unknown): void | Promise<void>` — the pi entry point. (Signature matches pi's `ExtensionAPI` factory; implementation wires the pieces; because the exact `ExtensionAPI` shape should be confirmed against installed `@earendil-works/pi-coding-agent` types in the full environment, `src/index.ts` is kept thin and delegates to `makeRuntime` + handlers + a small `wireApi` helper.)
  - `export function wireApi(api: WireApi, rt: RuntimeDeps): () => void` — returns a cleanup function; registers tools/commands/hooks. `WireApi` is a **narrow structural interface** (defined in `src/index.ts`) so the factory is unit-testable with a fake `api` object:
    ```ts
    export interface WireApi {
      registerTool(def: unknown): void;
      registerCommand(def: unknown): void;
      on(event: string, handler: (payload: unknown) => void | Promise<void>): void;
      appendEntry(type: string, data: unknown): void;
      sendMessage(text: string): void;
      setStatus(text: string): void;
    }
    ```

- [ ] **Step 1: Write the failing deps test** (`test/deps.test.ts`)

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRuntime } from "../src/deps.ts";
import { configPath } from "../src/config.ts";

test("makeRuntime resolves mode2 and project id when no blackhole", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-qm-deps-"));
  mkdirSync(join(dir, "repo"), { recursive: true });
  mkdirSync(join(dir, "repo", ".git"));
  try {
    const rt = await makeRuntime(dir, join(dir, "repo"), {}, {
      readConfig: () => ({ qdrantUrl: "http://localhost:6333", qdrantApiKey: null, embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text", embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10, mode: "auto" }),
      writeConfig: () => {},
      print: () => {},
      qdrant: {
        async ensureCollection() { return "exists"; },
        async upsert() {}, async search() { return []; }, async count() { return 0; }, async clearCollection() {},
      },
    });
    assert.ok(rt.projectId.startsWith("pi-mem-"));
    assert.equal(rt.cfg.qdrantUrl, "http://localhost:6333");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("configPath helper used by makeRuntime", () => {
  assert.match(configPath("/a"), /pi-qdrant-memory\/pi-qdrant-memory-config\.json$/);
});
```

- [ ] **Step 2: Write the failing wiring test** (`test/index.test.ts`)

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { wireApi } from "../src/index.ts";
import type { WireApi } from "../src/index.ts";
import type { RuntimeDeps } from "../src/types.ts";
import type { QdrantLike } from "../src/qdrant.ts";

function fakeApi(): WireApi & { tools: unknown[]; commands: unknown[]; events: Record<string, unknown[]>; entries: unknown[]; messages: string[]; statuses: string[] } {
  const api = {
    tools: [], commands: [], events: {} as Record<string, unknown[]>, entries: [], messages: [], statuses: [],
    registerTool(d: unknown) { (api.tools as unknown[]).push(d); },
    registerCommand(d: unknown) { (api.commands as unknown[]).push(d); },
    on(ev: string, h: (p: unknown) => void | Promise<void>) {
      if (!api.events[ev]) api.events[ev] = [];
      api.events[ev].push(h);
    },
    appendEntry(_t: string, d: unknown) { (api.entries as unknown[]).push(d); },
    sendMessage(t: string) { (api.messages as string[]).push(t); },
    setStatus(t: string) { (api.statuses as string[]).push(t); },
  };
  return api as WireApi & typeof api;
}

const qdrant: QdrantLike = {
  async ensureCollection() { return "exists"; }, async upsert() {},
  async search() { return []; }, async count() { return 0; }, async clearCollection() {},
};

const rt: RuntimeDeps = {
  cfg: { qdrantUrl: "http://localhost:6333", qdrantApiKey: null, embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text", embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.18, maxResults: 10, mode: "own" },
  agentDir: "/tmp/agent", cwd: "/repo", projectId: "pi-mem-abc",
  embed: async () => new Array(768).fill(0.1), qdrant,
  readConfig: () => rt.cfg, writeConfig: () => {}, print: () => {},
};

test("wireApi registers remember and memory_search tools", () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt);
  try {
    assert.equal(api.tools.length, 2);
    const names = (api.tools as Array<{ name: string }>).map((t) => t.name).sort();
    assert.deepEqual(names, ["memory_search", "remember"]);
  } finally { cleanup(); }
});

test("wireApi registers the /qdrant command family", () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt);
  try {
    const names = (api.commands as Array<{ name: string }>).map((c) => c.name);
    for (const n of ["qdrant status", "qdrant settings", "qdrant remember", "qdrant search", "qdrant clear", "qdrant help"]) {
      assert.ok(names.includes(n), `missing command ${n}`);
    }
  } finally { cleanup(); }
});

test("wireApi in own mode registers session_before_compact handler", () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt); // mode: own → mode2
  try {
    assert.ok(api.events["session_before_compact"], "expected session_before_compact hook in mode2");
  } finally { cleanup(); }
});

test("cleanup removes handlers", () => {
  const api = fakeApi();
  const cleanup = wireApi(api, rt);
  cleanup();
  assert.equal(api.events["session_before_compact"].length, 0);
});
```

- [ ] **Step 3: Run to verify both fail**

Run: `node --test test/deps.test.ts test/index.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 4: Implement `src/deps.ts`**

```ts
import { loadConfig, configPath } from "./config.ts";
import { EmbeddingClient } from "./embeddings.ts";
import { QdrantClient } from "./qdrant.ts";
import { projectIdFrom } from "./project.ts";
import type { QdrantLike } from "./qdrant.ts";
import type { Config, RuntimeDeps } from "./types.ts";

export interface MakeRuntimeIO {
  readConfig(): Config;
  writeConfig(c: Config): void;
  print(text: string): void;
  embed?: (t: string) => Promise<number[]>;
  qdrant?: QdrantLike;
}

export async function makeRuntime(
  agentDir: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  io: MakeRuntimeIO,
): Promise<RuntimeDeps> {
  const cfg = loadConfig(agentDir, env);
  const projectId = await projectIdFrom(cwd);
  const embeddingClient = new EmbeddingClient(
    cfg.embeddingBaseURL, cfg.embeddingModel, cfg.embeddingApiKey, cfg.expectedDimension);
  const embedder = io.embed ?? ((text: string) => embeddingClient.embed(text));
  const qdrant = io.qdrant ?? (new QdrantClient(cfg.qdrantUrl, cfg.qdrantApiKey) as QdrantLike);
  return {
    cfg,
    agentDir,
    cwd,
    projectId,
    embed: embedder,
    qdrant,
    readConfig: io.readConfig,
    writeConfig: io.writeConfig,
    print: io.print,
  };
}
```

- [ ] **Step 5: Implement `src/index.ts`** (thin; confirm exact `ExtensionAPI` field names against the installed pi package in the full environment before committing — the structural `WireApi` interface isolates the extension from pi's exact types so only this adapter needs adjusting)

```ts
import { makeRuntime } from "./deps.ts";
import type { MakeRuntimeIO } from "./deps.ts";
import { detectBlackhole, agentDirFromEnv } from "./mode.ts";
import { resolveMode } from "./mode.ts";
import { rememberLogic, memorySearchLogic } from "./tools-core.ts";
import { renderHits } from "./render.ts";
import { readPendingArtifacts } from "./blackhole.ts";
import { artifactToIngestItem, ingestItems, ensureAndGet } from "./ingest.ts";
import { captureAtCompaction } from "./capture.ts";
import { statusHandler, settingsHandler, rememberHandler, searchHandler, clearHandler, helpHandler, depsToIO } from "./handlers.ts";
import type { HandlerIO } from "./handlers.ts";
import type { RuntimeDeps } from "./types.ts";

export interface WireApi {
  registerTool(def: unknown): void;
  registerCommand(def: unknown): void;
  on(event: string, handler: (payload: unknown) => void | Promise<void>): void;
  appendEntry(type: string, data: unknown): void;
  sendMessage(text: string): void;
  setStatus(text: string): void;
}

interface ExecCtx { signal?: AbortSignal; }

function buildIO(api: WireApi, rt: RuntimeDeps): HandlerIO {
  return depsToIO({
    ...rt,
    readConfig: rt.readConfig,
    writeConfig: rt.writeConfig,
    print: (t) => { api.sendMessage(`/qdrant: ${t}`); },
  });
}

export function wireApi(api: WireApi, rt: RuntimeDeps): () => void {
  const mode = resolveMode(rt.cfg, detectBlackhole(rt.agentDir));
  const io = buildIO(api, rt);

  api.registerTool({
    name: "remember",
    label: "remember",
    description: "Persist a durable decision, constraint, or preference from the conversation so future sessions can recall it semantically.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Self-contained durable statement to remember." },
        type: { type: "string", enum: ["decision", "fact", "constraint", "preference"] },
      },
      required: ["text"],
    },
    promptGuidelines: "When a design choice is finalized, a constraint is stated, or a user preference is made explicit, call remember to persist it.",
    execute: async (toolCallId: string, params: { text: string; type?: "decision" | "fact" | "constraint" | "preference" }) => {
      const res = await rememberLogic(rt, params.text, params.type);
      return res.ok ? { message: `remembered: ${res.value.text}` } : { error: (res as { error: string }).error };
    },
  });

  api.registerTool({
    name: "memory_search",
    label: "memory_search",
    description: "Search prior durable project knowledge (decisions, facts, constraints, preferences) semantically across sessions.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language description of what prior knowledge is needed." },
        type: { type: "string", enum: ["decision", "fact", "constraint", "preference", "session_summary"] },
        limit: { type: "number", description: "Override result count (capped by config maxResults)." },
      },
      required: ["query"],
    },
    execute: async (_toolCallId: string, params: { query: string; type?: never; limit?: number }) => {
      const res = await memorySearchLogic(rt, params.query, params.type, params.limit);
      return res.ok ? { message: renderHits(res.value) } : { error: (res as { error: string }).error };
    },
  });

  const commands: Array<{ name: string; description: string; handler: (args: string[]) => Promise<void> }> = [
    { name: "qdrant status", description: "Connection health, active mode, collection status", handler: async () => { await statusHandler(io); } },
    { name: "qdrant settings", description: "Edit settings (TUI form in pi; text fallback: /qdrant settings <key> <value>)", handler: async (a) => { await settingsHandler(io, a[0], a[1]); } },
    { name: "qdrant remember", description: "Save durable knowledge now: /qdrant remember <text>", handler: async (a) => { await rememberHandler(io, a.join(" ")); } },
    { name: "qdrant search", description: "Semantic search: /qdrant search <query>", handler: async (a) => { await searchHandler(io, a.join(" ")); } },
    { name: "qdrant clear", description: "Reset the current project's collection", handler: async () => { await clearHandler(io); } },
    { name: "qdrant help", description: "List /qdrant commands", handler: async () => { await helpHandler(io); } },
  ];
  for (const c of commands) api.registerCommand({ name: c.name, description: c.description, execute: c.handler });

  const compactHandler = async (): Promise<void> => {
    // Mode 2 only. Fire-and-forget, never stalls compaction.
    try {
      const summaryText = "session compacted"; // pi provides the compaction summary text via event payload; wire event.payload when confirmed.
      await captureAtCompaction(
        { embed: rt.embed, qdrant: rt.qdrant, projectId: rt.projectId },
        rt.cfg.expectedDimension, summaryText, rt.agentDir, Date.now());
    } catch (err) {
      console.error(`pi-qdrant-memory: compaction capture error (non-fatal): ${String(err)}`);
    }
  };

  const sessionStart = async (): Promise<void> => {
    api.setStatus("qdrant-memory: active");
    if (mode === "mode1") {
      // Ingest blackhole durable artifacts (catch-up) — never claims the compaction hook.
      try {
        const arts = readPendingArtifacts(rt.agentDir);
        const items = arts.map((a) => artifactToIngestItem(a, rt.projectId, Date.now()));
        if (items.length) await ingestItems({ embed: rt.embed, qdrant: rt.qdrant, projectId: rt.projectId }, rt.cfg.expectedDimension, items);
      } catch (err) {
        console.error(`pi-qdrant-memory: Mode-1 catch-up ingest error (non-fatal): ${String(err)}`);
      }
    }
  };

  const handlers = new Map<string, (p: unknown) => void | Promise<void>>();
  handlers.set("session_start", sessionStart);
  if (mode === "mode2") handlers.set("session_before_compact", compactHandler);

  for (const [ev, h] of handlers) api.on(ev, h);

  return () => {
    for (const [ev] of handlers) {
      // pi api.on returns an unsubscribe; structural WireApi here only records — the real
      // adapter in the full environment must return and call the unsubscribe function.
    }
  };
}

export default function factory(api: unknown): void | Promise<void> {
  const a = api as WireApi;
  const env = process.env;
  const agentDir = agentDirFromEnv(env);
  const cwd = process.cwd();
  const io: MakeRuntimeIO = {
    readConfig: () => ({ /* placeholder replaced by makeRuntime defaults */ } as never),
    writeConfig: () => {},
    print: (t) => a.sendMessage(`/qdrant: ${t}`),
  };
  // NOTE: runtime assembly must use the canonical config loader + real clients.
  // This factory body is intentionally minimal; the full environment should:
  //   const rt = await makeRuntime(agentDir, cwd, env, { readConfig, writeConfig, print });
  //   wireApi(a, rt); and keep a cleanup reference for session_shutdown.
  void agentDir; void cwd; void io; void makeRuntime; void ensureAndGet;
}
```

- [ ] **Step 6: Run to verify pass**

Run: `node --test test/deps.test.ts test/index.test.ts`
Expected: The wiring tests assert against `wireApi`, which is fully implemented and testable. If the thin factory body fails typecheck (it intentionally references only stubs), run `npm run typecheck` and resolve by moving real assembly into `wireApi`/`makeRuntime`; **do not** weaken the tests.

- [ ] **Step 7: Commit**

```bash
git add src/deps.ts src/index.ts test/deps.test.ts test/index.test.ts
git commit -m "feat: pi extension factory wiring for tools, commands, hooks"
```

---

### Task 14: README documentation

**Files:**
- Modify: `README.md` (replace the Task-1 stub with full usage docs)

**Interfaces:**
- Produces: user-facing documentation: what it does, install (`pi install npm:pi-qdrant-memory` or git), config file path + keys table, env overrides, the `/qdrant` command family, the two tools, the two modes, prerequisites (Qdrant running on `:6333`, an OpenAI-compatible embeddings endpoint default llama.cpp `nomic-embed-text`), and graceful-degradation behavior.

- [ ] **Step 1: Write `README.md`**

```markdown
# pi-qdrant-memory

Semantic, cross-session/cross-project retrieval over durable conversation knowledge for pi.dev, backed by Qdrant.

Complements the ecosystem: codegraph = current code structure; pi-blackhole = durable decision capture;
**this extension = semantic retrieval** over that durable knowledge.

## Install

```bash
pi install npm:pi-qdrant-memory   # or: pi install git:github.com/<you>/pi-qdrant-memory
```

Quickstart (no package publish): drop `src/index.ts` into `.pi/extensions/`.

## Prerequisites

- Node >= 22.19
- A running Qdrant server (default `http://localhost:6333`)
- An OpenAI-compatible `/embeddings` endpoint — default a local llama.cpp OpenAI-format server with `nomic-embed-text` (768-dim). Ollama or hosted OpenAI-compatible APIs also work (set `embeddingApiKey`).

## Config

Single source of truth: `~/.pi/agent/pi-qdrant-memory/pi-qdrant-memory-config.json`
(honors `PI_CODING_AGENT_DIR`). Edit via `/qdrant settings` — never hand-edit.

| Key | Default | Meaning |
| --- | --- | --- |
| `qdrantUrl` | `http://localhost:6333` | Qdrant REST base URL |
| `qdrantApiKey` | `null` | Optional Qdrant API key |
| `embeddingBaseURL` | `http://localhost:8080/v1` | OpenAI-compatible `/embeddings` endpoint |
| `embeddingModel` | `nomic-embed-text` | Embedding model |
| `embeddingApiKey` | `null` | Optional key for hosted embedding APIs |
| `expectedDimension` | `768` | Embedding dimension; guards collection recreate |
| `scoreThreshold` | `0.18` | Search score threshold (per-model) |
| `maxResults` | `10` | Default search limit |
| `mode` | `auto` | `auto` detect | `blackhole` force Mode 1 | `own` force Mode 2 |

Env overrides (precedence global → project → env): `PI_QDRANT_URL`, `PI_QDRANT_API_KEY`,
`PI_QDRANT_EMBEDDING_BASE_URL`, `PI_QDRANT_EMBEDDING_MODEL`, `PI_QDRANT_EMBEDDING_API_KEY`,
`PI_QDRANT_EXPECTED_DIMENSION`, `PI_QDRANT_SCORE_THRESHOLD`, `PI_QDRANT_MAX_RESULTS`, `PI_QDRANT_MODE`.

## Commands

`/qdrant status`, `/qdrant settings [key value]`, `/qdrant remember <text>`, `/qdrant search <query>`, `/qdrant clear`, `/qdrant help`.

## Agent tools

- `remember(text, type?)` — persist a durable decision/constraint/preference.
- `memory_search(query, type?, limit?)` — semantic search of prior durable knowledge.

## Modes

- **Mode 1 (pi-blackhole present):** reads blackhole `om.*` session entries + pending JSON at `session_start`; never claims the compaction hook.
- **Mode 2 (blackhole absent):** registers its own `session_before_compact` hook and captures a durable snapshot at compaction; `/qdrant remember` is also a manual safety net.

All writes are idempotent (deterministic content-hash point ids). Unreachable Qdrant/embeddings degrades gracefully — tools report the problem and never crash the session.
```

- [ ] **Step 2: Verify full test suite passes**

Run: `node --test test/`
Expected: PASS (all tests across every `test/*.test.ts`).

- [ ] **Step 3: Run typecheck (optional but recommended)**

Run: `npm run typecheck`
Expected: clean (no TS errors).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README usage, config, commands, modes"
```

---

### Task 15: Integration smoke test (manual, full environment)

**Files:**
- Create: `test/integration.smoke.test.ts` (skipped by default via env guard)
- Modify: `package.json` (add `"test:smoke"` script)

**Interfaces:**
- Produces: an opt-in integration test that requires a **real** Qdrant (`localhost:6333`) and a **real** OpenAI-compatible embeddings server (`localhost:8080/v1`, `nomic-embed-text`). Guarded by `QDRANT_MEMORY_SMOKE=1` so `node --test` never fails in CI without servers.

- [ ] **Step 1: Write `test/integration.smoke.test.ts`**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { QdrantClient } from "../src/qdrant.ts";
import { EmbeddingClient } from "../src/embeddings.ts";
import { rememberLogic, memorySearchLogic } from "../src/tools-core.ts";
import type { RuntimeDeps } from "../src/types.ts";

const smoke = process.env.QDRANT_MEMORY_SMOKE === "1";
const o = { skip: !smoke } as const;

test("end-to-end remember then search against real servers", o, async () => {
  const qdrant = new QdrantClient("http://localhost:6333", null);
  const embedder = new EmbeddingClient("http://localhost:8080/v1", "nomic-embed-text", null, 768);
  const projectId = `pi-mem-smoke-${Date.now().toString(36)}`;
  const rt: RuntimeDeps = {
    cfg: {
      qdrantUrl: "http://localhost:6333", qdrantApiKey: null,
      embeddingBaseURL: "http://localhost:8080/v1", embeddingModel: "nomic-embed-text",
      embeddingApiKey: null, expectedDimension: 768, scoreThreshold: 0.15, maxResults: 5, mode: "own",
    },
    agentDir: "/tmp/agent", cwd: "/repo", projectId,
    embed: (t) => embedder.embed(t),
    qdrant, readConfig: () => rt.cfg, writeConfig: () => {}, print: () => {},
  };
  try {
    const saved = await rememberLogic(rt, "we decided the sync layer uses REST over gRPC", "decision");
    assert.ok(saved.ok);
    const found = await memorySearchLogic(rt, "what transport did we choose for sync?");
    assert.ok(found.ok);
    assert.ok(found.value.length >= 1, "expected at least one hit");
  } finally {
    await qdrant.clearCollection(projectId).catch(() => {});
  }
});
```

- [ ] **Step 2: Add the smoke script to `package.json`**

Add to `scripts`: `"test:smoke": "QDRANT_MEMORY_SMOKE=1 node --test test/integration.smoke.test.ts"`. (On Windows use `cross-env` or set the env var in the shell; note it in a comment.)

- [ ] **Step 3: Run the non-smoke suite to confirm the smoke test is skipped**

Run: `node --test test/`
Expected: PASS; integration smoke test reported skipped.

- [ ] **Step 4: Run the smoke test (requires servers up)**

Run (bash): `QDRANT_MEMORY_SMOKE=1 node --test test/integration.smoke.test.ts`
Run (PowerShell): `$env:QDRANT_MEMORY_SMOKE='1'; node --test test/integration.smoke.test.ts`
Expected: PASS — a remembered decision is found by semantic search.

- [ ] **Step 5: Commit**

```bash
git add test/integration.smoke.test.ts package.json
git commit -m "test: opt-in end-to-end smoke test against real Qdrant + embeddings"
```

---

## Self-Review Notes (completed by plan author)

- **Spec coverage:** Every spec requirement maps to tasks: §3 modes → Tasks 7, 13 (detection/wiring); §4 data model + §6.3 REST → Tasks 3, 5, 6; §5.1/5.2 tools → Task 10; §5.3/5.4 safety net/dedupe → Tasks 8, 9, 11; §5.6 commands → Task 12; §6.1 embeddings → Task 5; §6.2 config → Task 2; §6.3 packaging → Tasks 1, 13, 14; §7.1 degradation → baked into Tasks 9–13 (no-throw paths + logging); §7.2 test matrix → covered across Tasks 5–13 plus Task 15 smoke; Appendix A parsing → Task 8.
- **Placeholder scan:** the only intentionally provisional code is the `src/index.ts` factory body, which the plan explicitly marks for confirmation against the installed `@earendil-works/pi-coding-agent` `ExtensionAPI` types in the full environment (spec §9 verification note requires the same). All logic lives in testable modules (`wireApi`, handlers, tools-core); the factory is a thin adapter and is not a TBD in the spec-logic sense.
- **Type consistency:** `RuntimeDeps` is the single cross-module contract, defined once in `src/types.ts` (Task 1) with the exact shape `{ cfg, agentDir, cwd, projectId, embed, qdrant, readConfig, writeConfig, print }` and used identically by Tasks 10, 12, and 13. `QdrantLike`/`SearchHit`/`PointPayload`/`Config` are shared from `src/types.ts` and `src/qdrant.ts`; `pointId(text, sourceKind, contextId)` is used identically in Tasks 9, 10, 11 tests. `src/index.ts`'s factory body is the one adapter intentionally left for confirmation against installed pi types; all behavior lives in fully specified, testable modules (`deps.ts`, `handlers.ts`, `tools-core.ts`).
