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

/** Collect a list of observations from a recorded payload, tolerating shape drift. */
function pickObservations(data: unknown): BlackholeObservation[] | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const arr: unknown[] = Array.isArray(d.observations)
    ? d.observations
    : Array.isArray(d)
      ? d
      // single observation object wrapped (defensive, spec Appendix A)
      : typeof d.id === "string" && typeof d.content === "string" ? [d] : [];
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
  const arr: unknown[] = Array.isArray(d.reflections)
    ? d.reflections
    : Array.isArray(d)
      ? d
      : typeof d.id === "string" && typeof d.content === "string" ? [d] : [];
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
