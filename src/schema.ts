import type { Belief, BeliefKind, BeliefStatus, DeathKind, Evidence, WatchClause } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// The on-disk grammar, versioned and validated at the boundary. types.ts declares the
// closed unions to the *compiler*; this file declares the same sets to the *runtime*,
// so a value that parseBelief cast in (`val as BeliefKind`) but that no member covers is
// caught rather than trusted. The two must agree — `assertNever` at each switch keeps the
// compiler enforcing that agreement, and `schemaIssues` keeps the disk honest.
// ─────────────────────────────────────────────────────────────────────────────

// Bump when the belief/journal grammar changes in a way an older muster could MISREAD
// (not merely for additive fields it can ignore). A store written by a NEWER muster
// (version > this) is refused loudly by `verify` rather than silently misparsed — a
// re-sync cannot repair a format from the future, so it is fatal, never soft drift.
export const FORMAT_VERSION = 1;

// The closed unions as runtime-checkable sets. Single source of truth for "what values
// are legal on disk"; mirror the unions in types.ts exactly.
export const BELIEF_KINDS: readonly BeliefKind[] = ["observed", "told", "inferred", "assumed", "directive"];
export const BELIEF_STATUSES: readonly BeliefStatus[] = ["live", "stale", "dead", "superseded", "retired"];
export const WATCH_KINDS: readonly WatchClause["kind"][] = ["blob", "symbol", "expire", "path"];
export const EVIDENCE_KINDS: readonly Evidence["kind"][] = ["commit", "file", "session", "told", "derived"];
export const DEATH_KINDS: readonly DeathKind[] = ["falsified", "expired", "superseded", "consolidated", "executed"];

// Structural violations: an unknown enum value or a format version from the future.
// Distinct from the constitution (lint.ts, a policy about watches/evidence) and from
// drift (a stale projection a re-sync fixes). These mean the bytes on disk do not match
// the grammar this binary understands, so `verify` treats them as FATAL — a darkened
// enum or a newer format is corruption/incompatibility, not something `muster sync` heals.
export function schemaIssues(b: Belief): string[] {
  const v: string[] = [];
  if (b.formatVersion !== undefined && b.formatVersion > FORMAT_VERSION) {
    v.push(`format_version ${b.formatVersion} is newer than this muster understands (${FORMAT_VERSION}) — upgrade muster; a re-sync cannot read it`);
  }
  if (!includesLoose(BELIEF_KINDS, b.kind)) v.push(`unknown kind "${b.kind}"`);
  if (!includesLoose(BELIEF_STATUSES, b.status)) v.push(`unknown status "${b.status}"`);
  for (const w of b.watch) if (!includesLoose(WATCH_KINDS, w.kind)) v.push(`unknown watch kind "${w.kind}"`);
  for (const e of b.evidence) if (!includesLoose(EVIDENCE_KINDS, e.kind)) v.push(`unknown evidence kind "${e.kind}"`);
  if (b.tombstone && !includesLoose(DEATH_KINDS, b.tombstone.death)) v.push(`unknown death kind "${b.tombstone.death}"`);
  return v;
}

// Membership test whose argument is deliberately widened to `string`: the value came off
// disk typed as a union member, but parseBelief may have cast a garbage string into it,
// and only a widened compare actually checks the runtime value.
function includesLoose(set: readonly string[], value: string): boolean {
  return set.includes(value);
}

// Compile-time exhaustiveness with a runtime fallback. Placed as the fall-through of a
// switch over a closed union, it fails to COMPILE if a variant is added and left unhandled
// (`x` is `never` only when every case is covered) — the mechanism that keeps the runtime
// sets above in lockstep with the unions in types.ts. Unlike a throwing `assertNever`, it
// DEGRADES on structurally-corrupt data that slipped past `verify`, returning `fallback`:
// `verify` itself evaluates watches, and both it and the read path (why/brief/sweep) must
// surface a darkened enum as a fatal issue, never crash on it.
export function exhaustive<T>(x: never, fallback: T): T {
  void x;
  return fallback;
}
