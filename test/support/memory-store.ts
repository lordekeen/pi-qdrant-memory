/**
 * The shared in-memory `QdrantLike` used by every write-path test.
 *
 * It models a store, not a call recorder (AGENTS.md testing conventions): an
 * upsert adds or replaces by point id, every delete really removes the matching
 * points, `clearCollection` empties the collection, `ensureCollection` enforces
 * dimensions with the same created/exists/recreated outcomes (and the same
 * `DimensionMismatchError` under the default policy) as `QdrantClient`, and
 * `search` mirrors the client's filter policy (project_id + type, code points
 * hidden from every non-code query, threshold and limit applied).
 *
 * `timeline` records the mutations in call order, so a test can assert that a
 * file's delete precedes its upsert — the code-sync data-loss bug shipped
 * because a fake recorded deletes but never removed its upserts.
 *
 * Test-only: lives under `test/support/`, never imported by `src/`.
 */
import { DimensionMismatchError, QdrantError } from "../../src/qdrant.ts";
import type { EnsureCollectionOptions, QdrantLike, QdrantPoint } from "../../src/qdrant.ts";
import type { MemoryType, PointPayload, SearchHit } from "../../src/types.ts";

/** What `seed` accepts: an already-stored point, with an optional vector. */
export interface SeedPoint {
  id: string;
  payload: PointPayload;
  /** Defaults to a uniform vector of the target collection's dimension. */
  vector?: number[];
}

/** One modeled mutation, in the order it happened. Reads are not recorded. */
export type StoreOp =
  | { op: "ensure"; name: string; dim: number; outcome: "created" | "exists" | "recreated" }
  | { op: "upsert"; ids: string[] }
  | { op: "delete"; by: "files"; paths: string[] }
  | { op: "delete"; by: "source_kind"; kind: string }
  | { op: "delete"; by: "source_entry_ids"; ids: string[] }
  | { op: "delete"; by: "ids"; ids: string[] }
  | { op: "clear" };

export interface MemoryStoreOptions {
  /** Collection the inspection helpers default to; `"pi-mem-abc"` when omitted. */
  name?: string;
  /** Vector length for seeded points (and the dimension a seeded collection
   *  starts at); 768 when omitted. */
  dimension?: number;
  /** Similarity used by `search`; defaults to cosine similarity over the
   *  stored vectors. Inject this when a search test needs fixed scores. */
  scoreOf?: (query: number[], point: QdrantPoint) => number;
}

export interface MemoryStore extends QdrantLike {
  /** Every mutation so far, in order. Seeding is setup and is not recorded. */
  readonly timeline: StoreOp[];
  /** Stored points of the collection, in insertion order. */
  points(name?: string): QdrantPoint[];
  /** Dimensions of the stored collection, or undefined when it does not exist. */
  dimensionOf(name?: string): number | undefined;
  /** Point-id lists of every `upsert` call, in order. */
  upsertBatches(): string[][];
  /** Path lists of every `deletePointsByFiles` call, in order. */
  deletedFileBatches(): string[][];
  /** Index of the first mutation matching `predicate`; -1 when absent. */
  indexOfOp(predicate: (op: StoreOp) => boolean): number;
  /** Establish pre-existing state as if the points had been indexed earlier:
   *  creates the collection at the configured dimension when absent and
   *  records nothing on the timeline. */
  seed(points: SeedPoint[], name?: string): void;
}

const DEFAULT_NAME = "pi-mem-abc";
const DEFAULT_DIMENSION = 768;

interface StoredCollection {
  dim: number;
  points: Map<string, QdrantPoint>;
}

/** Uniform seeded vector: cosine similarity 1 against another uniform vector. */
function uniformVector(dim: number): number[] {
  return new Array<number>(dim).fill(0.1);
}

/** Cosine similarity over the vectors; zero vectors score 0 (never NaN). */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

export function createMemoryStore(opts: MemoryStoreOptions = {}): MemoryStore {
  const defaultName = opts.name ?? DEFAULT_NAME;
  const defaultDimension = opts.dimension ?? DEFAULT_DIMENSION;
  const scoreOf = opts.scoreOf;
  const collections = new Map<string, StoredCollection>();
  const timeline: StoreOp[] = [];

  const existing = (name: string): StoredCollection | undefined => collections.get(name);
  /** Like QdrantClient: an operation on an unknown collection without a
   *  notFound-tolerant path is an error. */
  const requireCollection = (name: string): StoredCollection => {
    const col = existing(name);
    if (!col) throw new QdrantError(`collection ${name} does not exist`, 404);
    return col;
  };
  const removeWhere = (col: StoredCollection, match: (point: QdrantPoint) => boolean): void => {
    for (const [id, point] of col.points) {
      if (match(point)) col.points.delete(id);
    }
  };
  const countWhere = (name: string, match: (point: QdrantPoint) => boolean): number => {
    const col = existing(name);
    if (!col) return 0;
    let count = 0;
    for (const point of col.points.values()) {
      if (match(point)) count++;
    }
    return count;
  };

  // Plain methods over closure state (no `this`), so a test can spread the
  // store to override one capability (e.g. a throwing delete) and keep the
  // rest of the model — and its state — working.
  return {
    timeline,

    points(name = defaultName) {
      return [...(existing(name)?.points.values() ?? [])];
    },
    dimensionOf(name = defaultName) {
      return existing(name)?.dim;
    },
    upsertBatches() {
      return timeline.flatMap((op) => (op.op === "upsert" ? [op.ids] : []));
    },
    deletedFileBatches() {
      return timeline.flatMap((op) => (op.op === "delete" && op.by === "files" ? [op.paths] : []));
    },
    indexOfOp(predicate) {
      return timeline.findIndex(predicate);
    },
    seed(points, name = defaultName) {
      let col = existing(name);
      if (!col) {
        col = { dim: defaultDimension, points: new Map() };
        collections.set(name, col);
      }
      for (const point of points) {
        col.points.set(point.id, {
          id: point.id,
          vector: point.vector ?? uniformVector(col.dim),
          payload: point.payload,
        });
      }
    },

    async ensureCollection(name, dim: number, opts?: EnsureCollectionOptions) {
      const col = existing(name);
      if (!col) {
        collections.set(name, { dim, points: new Map() });
        timeline.push({ op: "ensure", name, dim, outcome: "created" });
        return "created";
      }
      if (col.dim === dim) {
        timeline.push({ op: "ensure", name, dim, outcome: "exists" });
        return "exists";
      }
      if (opts?.onDimensionMismatch !== "recreate") {
        // Same guard as QdrantClient: a read path must never wipe the
        // collection (the caller surfaces this as an error).
        throw new DimensionMismatchError(name, col.dim, dim);
      }
      collections.set(name, { dim, points: new Map() });
      timeline.push({ op: "ensure", name, dim, outcome: "recreated" });
      return "recreated";
    },

    async upsert(name, points: QdrantPoint[]) {
      const col = requireCollection(name);
      for (const point of points) col.points.set(point.id, point);
      timeline.push({ op: "upsert", ids: points.map((point) => point.id) });
    },

    async search(name, vector: number[], opts: {
      projectId: string; type?: MemoryType; limit: number; threshold: number;
    }): Promise<SearchHit[]> {
      const col = requireCollection(name);
      const score: (query: number[], point: QdrantPoint) => number =
        scoreOf ?? ((query, point) => cosineSimilarity(query, point.vector));
      return [...col.points.values()]
        .filter((point) => point.payload.project_id === opts.projectId)
        // QdrantClient policy: code points answer only code-typed queries.
        .filter((point) => (opts.type ? point.payload.type === opts.type : point.payload.type !== "code"))
        .map((point) => ({ id: point.id, score: score(vector, point), payload: point.payload }))
        .filter((hit) => hit.score >= opts.threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, opts.limit);
    },

    async count(name) {
      return requireCollection(name).points.size;
    },

    async clearCollection(name) {
      requireCollection(name); // like QdrantClient, clearing an unknown collection is an error
      collections.delete(name);
      timeline.push({ op: "clear" });
    },

    async deletePointsByFiles(name, filePaths: string[]) {
      if (!filePaths.length) return; // QdrantClient short-circuits: no request, no op
      const col = existing(name);
      timeline.push({ op: "delete", by: "files", paths: [...filePaths] });
      if (col) {
        removeWhere(col, (point) => {
          const path = point.payload.file_path;
          return typeof path === "string" && filePaths.includes(path);
        });
      }
    },

    async countBySourceKind(name, kind: string) {
      return countWhere(name, (point) => point.payload.source_kind === kind);
    },

    async countCodeSymbols(name) {
      return countWhere(name, (point) => point.payload.source_kind === "code_summary" && point.payload.symbol !== undefined);
    },

    async deletePointsBySourceKind(name, kind: string) {
      const col = existing(name);
      timeline.push({ op: "delete", by: "source_kind", kind });
      if (col) removeWhere(col, (point) => point.payload.source_kind === kind);
    },

    async deletePointsBySourceEntryIds(name, ids: string[]) {
      if (!ids.length) return; // QdrantClient short-circuits: no request, no op
      const col = existing(name);
      timeline.push({ op: "delete", by: "source_entry_ids", ids: [...ids] });
      if (col) {
        removeWhere(col, (point) => {
          const entryId = point.payload.source_entry_id;
          return typeof entryId === "string" && ids.includes(entryId);
        });
      }
    },

    async deletePointsByIds(name, ids: string[]) {
      if (!ids.length) return 0; // QdrantClient short-circuits: no request, no op
      const col = existing(name);
      timeline.push({ op: "delete", by: "ids", ids: [...ids] });
      if (!col) return 0;
      let removed = 0;
      for (const id of ids) {
        if (col.points.delete(id)) removed++;
      }
      // The count of points actually removed — the exact behavior the real
      // client approximates by returning the requested id count.
      return removed;
    },

    async codeIndexSnapshot(name) {
      const col = requireCollection(name);
      const out = new Map<string, string>();
      for (const point of col.points.values()) {
        if (point.payload.source_kind !== "code_summary") continue;
        const filePath = point.payload.file_path;
        const fileSha = point.payload.file_sha;
        // Malformed payloads are skipped, like QdrantClient's scroll mapping.
        if (typeof filePath === "string" && typeof fileSha === "string") out.set(filePath, fileSha);
      }
      return out;
    },

    async existingPointIds(name, ids: string[]) {
      const out = new Set<string>();
      const col = existing(name);
      if (!col) return out; // QdrantClient treats a missing collection as empty
      for (const id of ids) {
        if (col.points.has(id)) out.add(id);
      }
      return out;
    },
  };
}
