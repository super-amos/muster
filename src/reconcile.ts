import type { Belief, Evidence, WatchClause } from "./types.js";
import { Store } from "./store.js";
import { beliefId } from "./id.js";
import { appendTrace, makeTrace } from "./journal.js";
import { lintBelief } from "./lint.js";
import { addDays } from "./dates.js";

// ─────────────────────────────────────────────────────────────────────────────
// Contradiction reconciliation (PLAN §7). When two live beliefs assert opposite
// things about the same subject, a briefing must carry ONE honest line — never both
// as truth. Muster resolves by a fixed protocol and, when the protocol can't
// separate them, escalates to a DISPUTE that briefs as an open question.
//
//   Protocol order:  evidence kind (observed > told > inferred > assumed)
//                  → recency (newer reverification wins)
//                  → principal trust (user > agent > ingest > metabolizer)
//                  → escalate to a dispute record.
//
// Detection is mechanical and DELIBERATELY conservative — only clear polar opposites
// (same subject, high word overlap, exactly one negated) are flagged. A missed
// contradiction is a lesser sin than a fabricated one: a false dispute would demote
// two true beliefs. Resolution supersedes the loser (it stops briefing as truth but
// keeps its whole life in the record); escalation supersedes BOTH behind a dispute
// belief that names them. Either way: one honest line.
// ─────────────────────────────────────────────────────────────────────────────

export type Verdict = { verdict: "a" | "b" | "dispute"; basis: string };

// The PURE protocol. No store, no I/O — a deterministic function of the two beliefs,
// unit-tested in isolation. `a` and `b` are assumed to already be a real contradiction.
export function resolveContradiction(a: Belief, b: Belief): Verdict {
  const sa = strength(a);
  const sb = strength(b);
  if (Math.abs(sa - sb) >= 1) return { verdict: sa > sb ? "a" : "b", basis: "evidence-kind" };

  const ra = time(a);
  const rb = time(b);
  if (ra !== rb) return { verdict: ra > rb ? "a" : "b", basis: "recency" };

  const ta = trustRank(a.origin);
  const tb = trustRank(b.origin);
  if (ta !== tb) return { verdict: ta > tb ? "a" : "b", basis: "trust" };

  return { verdict: "dispute", basis: "indistinguishable" };
}

// Basis strength: how the belief was learned, with a boost for corroboration and for
// what an agent directly read. Mirrors the confidence basis ladder.
function strength(b: Belief): number {
  const kind = b.kind === "observed" ? 4 : b.kind === "told" || b.kind === "directive" ? 3 : b.kind === "inferred" ? 2 : 1;
  const boost = b.method === "corroborated" ? 1 : b.method === "read-source" || b.method === "user-told" ? 0.5 : 0;
  return kind + boost;
}

function trustRank(origin: string): number {
  if (origin.startsWith("user")) return 3;
  if (origin.startsWith("agent")) return 2;
  if (origin.startsWith("ingest")) return 2;
  return 1; // metabolize:* and anything else
}

function time(b: Belief): number {
  const t = Date.parse(b.lastVerified || b.born || "");
  return Number.isFinite(t) ? t : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection — conservative polar-opposite finder over live assertive beliefs.
// ─────────────────────────────────────────────────────────────────────────────

const NEG = /\b(not|no|never|isn'?t|aren'?t|doesn'?t|don'?t|didn'?t|cannot|can'?t|won'?t|no longer|instead of|deprecated|removed)\b/i;
const STOP = new Set("a an the of to in on for and or is are be was were this that with it its as at by from into we our your you use uses using does do did has have".split(" "));

export function detectContradictions(store: Store): [Belief, Belief][] {
  const assertive = store.all().filter(
    (b) => b.status === "live" && b.subjects.length > 0
      && (b.kind === "observed" || b.kind === "told" || b.kind === "inferred" || b.kind === "assumed"),
  );
  // Bucket by primary subject to keep the pairwise scan cheap and local.
  const bySubject = new Map<string, Belief[]>();
  for (const b of assertive) {
    const arr = bySubject.get(b.subjects[0]) ?? [];
    arr.push(b);
    bySubject.set(b.subjects[0], arr);
  }
  const pairs: [Belief, Belief][] = [];
  const emitted = new Set<string>();
  for (const subj of [...bySubject.keys()].sort()) {
    const group = bySubject.get(subj)!.sort((x, y) => x.id.localeCompare(y.id));
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (arePolarOpposites(group[i], group[j])) {
          const key = group[i].id + "|" + group[j].id;
          if (!emitted.has(key)) { emitted.add(key); pairs.push([group[i], group[j]]); }
        }
      }
    }
  }
  return pairs;
}

// Same claim modulo a single negation: high content-word overlap, exactly one negated.
export function arePolarOpposites(a: Belief, b: Belief): boolean {
  const negA = NEG.test(a.claim);
  const negB = NEG.test(b.claim);
  if (negA === negB) return false; // both positive or both negative → not a polar pair
  const wa = contentWords(a.claim);
  const wb = contentWords(b.claim);
  if (wa.size === 0 || wb.size === 0) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const jaccard = inter / (wa.size + wb.size - inter);
  return jaccard >= 0.5;
}

function contentWords(claim: string): Set<string> {
  const out = new Set<string>();
  for (const m of claim.toLowerCase().matchAll(/[a-z][a-z0-9_./-]{1,}/g)) {
    const w = m[0];
    if (STOP.has(w) || NEG.test(w)) continue;
    out.add(w);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation — apply the protocol to every detected contradiction.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReconcileOptions { now?: Date; horizonDays?: number; }

export interface ReconcileReport {
  resolved: { winner: string; loser: string; basis: string }[];
  disputes: { id: string; a: string; b: string }[];
}

export function reconcile(store: Store, opts: ReconcileOptions = {}): ReconcileReport {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const horizon = addDays(nowIso, opts.horizonDays ?? 120);
  const rep: ReconcileReport = { resolved: [], disputes: [] };

  for (const [a, b] of detectContradictions(store)) {
    // Skip if a prior pass already moved one of them out of the live set.
    if (a.status !== "live" || b.status !== "live") continue;
    const { verdict, basis } = resolveContradiction(a, b);

    if (verdict === "a" || verdict === "b") {
      const winner = verdict === "a" ? a : b;
      const loser = verdict === "a" ? b : a;
      supersede(store, loser, winner.id, nowIso, basis);
      rep.resolved.push({ winner: winner.id, loser: loser.id, basis });
    } else {
      const dispute = mintDispute(store, a, b, nowIso, horizon);
      if (!dispute) continue;
      supersede(store, a, dispute.id, nowIso, "disputed");
      supersede(store, b, dispute.id, nowIso, "disputed");
      rep.disputes.push({ id: dispute.id, a: a.id, b: b.id });
    }
  }
  return rep;
}

function supersede(store: Store, loser: Belief, byId: string, nowIso: string, basis: string): void {
  loser.status = "superseded";
  loser.supersededBy = byId;
  loser.lastVerified = nowIso;
  // MET-3: leave a durable tombstone so the revival guard (store.ts `isTerminal`) can
  // refuse to resurrect this belief on a later plain sync — keyed on an at-rest marker,
  // not the mutable status alone. The claim is kept for a truthful "was, until…" obituary.
  loser.tombstone = { death: "superseded", at: nowIso, by: byId, note: `superseded by ${byId} — ${basis}` };
  store.persist(loser);
  appendTrace(store.loc, makeTrace("supersede", { actor: "metabolize:reconcile", subject: loser.id, ref: byId, note: basis }));
}

// A dispute is itself a belief: a live, mortal open-question that names both sides in
// its lineage and briefs as the single honest line. It expires (a stale dispute should
// be re-examined) so it is never immortal.
function mintDispute(store: Store, a: Belief, b: Belief, nowIso: string, horizon: string): Belief | null {
  const subject = a.subjects[0] ?? b.subjects[0] ?? "this";
  const claim = `Unresolved contradiction about \`${subject}\`: "${a.claim}" vs "${b.claim}". Verify before relying on either.`;
  const evidence: Evidence[] = [{ kind: "derived", ref: `dispute:${[a.id, b.id].sort().join(":")}`, note: "" }];
  const watch: WatchClause[] = [{ kind: "expire", target: horizon, expect: "" }];
  const id = beliefId(claim, evidence);
  const dispute: Belief = {
    id, kind: "inferred", status: "live", claim, subjects: [...new Set([...a.subjects, ...b.subjects])].slice(0, 8),
    confidence: 0.3, method: "dispute", watch, evidence, lineage: [a.id, b.id].sort(),
    origin: "metabolize:reconcile", born: nowIso, lastVerified: nowIso, supersededBy: "",
  };
  if (lintBelief(dispute).length) return null;
  store.persist(dispute);
  appendTrace(store.loc, makeTrace("dispute", { actor: "metabolize:reconcile", subject: id, ref: `${a.id}:${b.id}`, note: "open question" }));
  return dispute;
}

