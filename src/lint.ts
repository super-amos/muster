import type { Belief } from "./types.js";
import { schemaIssues } from "./schema.js";

// The constitution, enforced. A belief that cannot name what would make it false is
// a rumor, and Muster refuses rumors. Every belief must declare ≥1 evidence trace and
// — unless it is a directive (a standing order, eternal by policy, killable only by
// the user) — ≥1 death condition. This is the single rule that makes memory mortal.
//
// `lintBelief` returns the list of violations (empty = valid). `assertBelief` throws.

export class LintError extends Error {
  constructor(public beliefId: string, public violations: string[]) {
    super(`belief ${beliefId || "(unminted)"} violates the constitution: ${violations.join("; ")}`);
    this.name = "LintError";
  }
}

export function lintBelief(b: Belief): string[] {
  const v: string[] = [];

  if (!b.claim.trim()) v.push("empty claim");
  if (b.evidence.length === 0) v.push("no evidence — a belief must rest on ≥1 trace");

  // NO IMMORTAL BELIEFS. Directives are the sole exception: they are eternal on
  // purpose and die only when the user denies them.
  if (b.kind !== "directive" && b.watch.length === 0) {
    v.push("immortal belief — a non-directive must declare ≥1 watch (death condition)");
  }

  // A directive with a content watch is a category error: it would decay, which
  // defeats the point of a standing order.
  if (b.kind === "directive" && b.watch.some((w) => w.kind !== "expire")) {
    v.push("directive carries a mortal watch — standing orders must not decay");
  }

  for (const w of b.watch) {
    if (!w.target.trim()) v.push(`watch(${w.kind}) has an empty target`);
    if (w.kind === "symbol" && !w.target.includes("@")) {
      v.push(`symbol watch "${w.target}" must be "name@path"`);
    }
  }

  if (b.confidence < 0 || b.confidence > 1) v.push(`confidence ${b.confidence} out of [0,1]`);
  return v;
}

export function assertBelief(b: Belief): void {
  // The write-path boundary refuses BOTH constitution violations (rumors) and structural
  // ones (a darkened enum / a future format version) — the same set `verify` treats as
  // fatal at rest, caught here before it can ever be persisted.
  const v = [...lintBelief(b), ...schemaIssues(b)];
  if (v.length) throw new LintError(b.id, v);
}
