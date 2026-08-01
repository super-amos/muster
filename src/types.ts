// The type spine. Everything on disk is derived from these shapes.

export type BeliefKind = "observed" | "told" | "inferred" | "assumed" | "directive";

// The living state, the demotions, and death. Only "live" beliefs brief as truth;
// "dead" beliefs still brief — as obituaries and tripwires in the task's blast radius.
export type BeliefStatus =
  | "live" // currently trusted; the only status that briefs as an assertion
  | "stale" // a content watch fired; the world moved but the claim may still hold — demote, re-fingerprint on next sync
  | "dead" // falsified / expired / executed — tombstoned; briefs only as a caution
  | "superseded" // replaced by a newer belief (lineage points forward)
  | "retired"; // consolidated into a principle, or dismissed; out of briefing candidacy

// How a belief died. Each death is journaled, tombstoned, and citable.
export type DeathKind =
  | "falsified" // a watch fired and reverification failed (cites the killing commit)
  | "expired" // born with a horizon, reached it unreverified
  | "superseded" // lost a contradiction to a newer/stronger belief
  | "consolidated" // absorbed into a principle (retirement with a forwarding address)
  | "executed"; // `muster deny` — the user is the highest court

// A death condition. Every belief is born knowing what would make it false.
//   blob   — file content hash; fires (→ stale) when the file changes, revives when it matches
//   symbol — "name@path"; fires (→ dead) when the definition is removed  ← the scar-killer
//   path   — a file path; fires (→ dead) when the file is deleted
//   expire — an ISO date; fires (→ dead) when the horizon passes unreverified
export interface WatchClause {
  kind: "blob" | "symbol" | "expire" | "path";
  target: string; // file path | "symbol@path" | ISO date
  expect: string; // fingerprint at birth (content hash / "present"); "" for expire
}

// A provenance pointer a human can follow with ordinary tools (git, grep, editor).
export interface Evidence {
  kind: "commit" | "file" | "session" | "told" | "derived";
  ref: string; // "9d2c1a" | "src/auth.ts" | "session-6b2#12"
  note: string; // free text; may be empty (NOT part of identity)
}

// Written when a belief dies. Immutable once set; the belief keeps its claim so the
// briefing can render a truthful obituary ("X was true until commit Y removed it").
export interface Tombstone {
  death: DeathKind;
  at: string; // ISO instant of death
  // Who or what ended it — the attribution depends on `death`, and for a metabolized death
  // it is a FORWARDING ADDRESS, not just a killer: a commit sha (falsified), "user"
  // (executed via `muster deny`), or the belief id that replaced it — the superseding
  // belief (superseded) or the absorbing principle (consolidated). `muster why` follows it.
  by: string;
  note: string; // human-facing obituary line
}

// The unit of storage: one mortal, falsifiable assertion. On disk: one .md file.
export interface Belief {
  id: string; // content-addressed, e.g. "e:7f3a1c9b2d0e"
  kind: BeliefKind;
  status: BeliefStatus;
  claim: string; // the body: a single human-readable assertion
  subjects: string[]; // relevance tags: file paths, symbols, topics
  confidence: number; // 0..1 — a derived score, never a naked guess (see `method`)
  method: string; // how confidence was derived (git-history | read-source | user-told | …)
  watch: WatchClause[]; // death conditions (empty => eternal, e.g. a directive)
  evidence: Evidence[]; // provenance chain
  lineage: string[]; // belief ids this supersedes / derives from
  origin: string; // who minted it (ingest:git | user | agent:session-x)
  born: string; // ISO timestamp
  lastVerified: string; // ISO timestamp of last successful reverification
  supersededBy: string; // id, when status === "superseded"; else ""
  tombstone?: Tombstone; // set once the belief dies
  summary?: string; // NON-identity enrichment: a symbol's signature + first doc line,
  // rendered at higher altitude. Never part of the content address — two agents agree
  // on a symbol regardless of how its doc comment is worded.
  formatVersion?: number; // on-disk grammar version (NON-identity). Absent = legacy, read
  // as the current version; a value from the future is refused fatally by `verify`.
  signature?: string; // NON-identity at-rest signature over the trust/mortality fields the
  // content-address does NOT cover (kind, origin, status, method, confidence, watch,
  // forwarding address, death). Recomputed on every write; a mismatch at rest is tamper.
}

// An append-only journal entry — the advisory audit trail (torn-tail tolerant; the
// canonical state is the beliefs). The record of what happened.
export interface Trace {
  v?: number; // on-disk grammar version; absent = legacy. Advisory, never fatal.
  ts: string;
  kind: string;
  actor: string;
  subject: string;
  ref: string;
  note: string;
}

// The altitude ladder. A0 one line · A1 line + provenance tag · A2 full with evidence.
// A briefing buys resolution before breadth: it climbs this ladder on the most
// relevant beliefs before it admits new ones. Invariant, enforced by construction:
// every word at altitude N also appears at altitude N+1 (higher = strict superset).
export type Altitude = 0 | 1 | 2;

// One line of a compiled briefing, tied to the belief it came from (for `muster why`).
export interface BriefLine {
  section: string;
  beliefId: string;
  altitude: Altitude;
  text: string;
  tokens: number;
}

export interface Briefing {
  task: string;
  budget: number;
  used: number;
  asOf: string; // the "now" the compile was pinned to (journal head time) — reproducible
  text: string;
  lines: BriefLine[];
  omitted: number; // relevant beliefs that did not fit the budget (mandatory AND optional)
  mandatoryOmitted: number; // of those, how many were tripwires/standing orders — a dropped
  // SAFETY artifact the footer must surface loudly, never hide behind "0 held back".
}
