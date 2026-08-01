import { createHash } from "node:crypto";
import type { Evidence } from "./types.js";

// Deterministic JSON: recursively sorted keys, minimal separators.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortDeep(src[k]);
    return out;
  }
  return v;
}

export function sha256hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function contentHash(s: string): string {
  return sha256hex(s).slice(0, 12);
}

// Belief identity = hash of the claim + the evidence it rests on (kind+ref only).
// Confidence, status, timestamps, and evidence notes are mutable state and are NOT
// part of identity, so the same assertion from the same evidence always collapses
// to one id: ingest is idempotent, and two agents observing the same thing agree.
//
// 12 hex = 48 bits. At the 1M-belief soft ceiling the birthday-collision odds are
// ~1.8e-3; at a realistic 50k they are ~7e-8. (6 hex would collide ~50% of the time
// at only a few thousand beliefs — a silent-corruption bug, not a theoretical one.)
export function beliefId(claim: string, evidence: Evidence[]): string {
  const basis = canonicalJson({
    claim: claim.trim(),
    evidence: evidence
      .map((e) => ({ kind: e.kind, ref: e.ref }))
      .sort((a, b) => (a.kind + a.ref).localeCompare(b.kind + b.ref)),
  });
  return "e:" + sha256hex(basis).slice(0, 12);
}

// The immutable projection an id commits to. `muster verify` recomputes this from a
// belief's claim+evidence and asserts it equals the stored id — any in-place edit to
// a load-bearing field yields a different id, so tamper cannot hide.
export function recomputeId(claim: string, evidence: Evidence[]): string {
  return beliefId(claim, evidence);
}

export function idToFile(id: string): string {
  return id.replace(":", "-") + ".md";
}

export function fileToId(file: string): string {
  return file.replace(/\.md$/, "").replace("-", ":");
}
