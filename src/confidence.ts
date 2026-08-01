import type { Belief } from "./types.js";
import { exhaustive } from "./schema.js";

// ─────────────────────────────────────────────────────────────────────────────
// Confidence is a DERIVATION, never a naked float (PLAN §4). A number on its own is
// a vibe; a number you can decompose into its provenance is evidence. This module
// makes the derivation legible — `muster why` shows the *inputs*, not just the digit —
// and gives metabolism a mechanical rule for how corroboration raises trust.
//
// It does NOT rewrite the numbers ingest already derives (those are method-tuned and
// load-bearing for ordering). It explains them, and it defines the one lever M3 pulls:
// an independent second source lifts confidence, and single-source model extractions
// are quarantined until that lift arrives.
// ─────────────────────────────────────────────────────────────────────────────

// The method a fenced-LLM extraction stamps on a candidate belief. Kept here (not in
// extract.ts) because two other organs — the linker's quarantine cap and `why` — must
// recognise it without importing the metabolizer.
export const METHOD_EXTRACT = "llm-extract";

// Independent corroboration threshold: a claim supported by this many distinct traces
// is trusted; below it, a model-extracted claim stays provisional (capped below A1).
export const CORROBORATION_MIN = 2;

// Distinct supporting traces, counted by (kind, ref). `mergeBelief` already unions
// evidence when the same content-addressed claim is re-observed, so two independent
// sources of one claim show up here as two entries — corroboration falls out of the
// fold, it is not a flag anyone sets.
export function independentEvidence(b: Belief): number {
  const seen = new Set<string>();
  for (const e of b.evidence) seen.add(e.kind + "|" + e.ref);
  return seen.size;
}

// Quarantine, derived from provenance rather than stored. A belief is provisional iff
// it is a live, single-source model extraction. The instant a second independent trace
// corroborates the same claim (same id → evidence merges), this returns false and the
// belief is promoted — mechanically, no model, no flag to flip.
export function isProvisional(b: Belief): boolean {
  return b.status === "live"
    && b.method === METHOD_EXTRACT
    && independentEvidence(b) < CORROBORATION_MIN;
}

// How much an extra independent source is worth. Saturating, so a swarm of correlated
// traces can't inflate a weak claim to certainty. Used by metabolism when it promotes
// a corroborated belief.
export function corroborationBonus(b: Belief): number {
  const extra = Math.max(0, independentEvidence(b) - 1);
  return Math.min(0.15, 0.05 * extra);
}

// The basis label for a belief's kind — the "how did we come to hold this" that opens
// every confidence derivation. Mirrors the reconciliation precedence (§7): what an
// agent directly read > what a human asserted > what was inferred > what was assumed.
function basisLabel(b: Belief): string {
  switch (b.kind) {
    case "observed": return "observed";
    case "told": return "asserted by a human";
    case "directive": return "a standing order";
    case "inferred": return "inferred";
    case "assumed": return "assumed";
  }
  return exhaustive(b.kind, b.kind); // corrupt kind renders as itself, never crashes `why`
}

// A one-line derivation for `muster why`: the number, then the inputs that produced it.
// e.g. "0.80 — observed (read-source), 3 corroborating traces (+0.10)".
export function describeConfidence(b: Belief): string {
  const parts: string[] = [`${basisLabel(b)} (${b.method})`];
  const n = independentEvidence(b);
  parts.push(`${n} corroborating trace${n === 1 ? "" : "s"}`);
  const bonus = corroborationBonus(b);
  const tail = bonus > 0 ? ` (+${bonus.toFixed(2)})` : "";
  if (isProvisional(b)) parts.push("PROVISIONAL — single-source extraction, awaiting corroboration");
  return `${b.confidence.toFixed(2)}${tail} — ${parts.join(", ")}`;
}
