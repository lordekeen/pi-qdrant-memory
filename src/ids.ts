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
