import { dirname } from "node:path";
import type { Belief, WatchClause, Evidence } from "./types.js";
import { Store } from "./store.js";
import { beliefId } from "./id.js";
import { appendTrace, makeTrace } from "./journal.js";
import { lintBelief } from "./lint.js";
import { isProvisional } from "./confidence.js";
import { clamp01 } from "./num.js";
import { addDays } from "./dates.js";

// ─────────────────────────────────────────────────────────────────────────────
// Consolidation — how the live set stays flat while the journal grows forever.
//
// Over a year an agent accumulates thousands of low-value orientation beliefs
// ("this file exists", "these two files co-change") and overlapping notes about the
// same subject. Left alone they would bloat every briefing's neighborhood and blow
// the belief ceiling. Consolidation folds each such family into ONE principle that
// cites every member it absorbed (total-citation), and retires the members — out of
// briefing candidacy, never out of the record. `muster why` on the principle lists
// its whole constituency; `muster why` on a member forwards to the principle.
//
// It is DETERMINISTIC and MODEL-FREE on purpose. Clustering is a mechanical key,
// the principle's claim is a stable template, so its content address is stable: one
// principle per (family, anchor), forever. Re-running finds the members already
// retired and does nothing — convergent, idempotent, no wall clock in identity.
//
// Two categories are NEVER absorbed, because absorbing them would break invariants:
//   • live `read-source` symbol beliefs — the scar-killers. Each must stay granular
//     and individually mortal so a deleted definition still fires its own tripwire.
//   • directives — standing orders are briefed first and killable only by the user.
// Consolidation targets the orientation layer and overlapping facts: exactly the
// categories that grow unbounded and carry the least value per token.
// ─────────────────────────────────────────────────────────────────────────────

export interface ConsolidateOptions {
  threshold?: number; // min live members to open a NEW principle (default 6)
  horizonDays?: number; // expiry horizon for the perishable summary (default 120)
  now?: Date; // injected for deterministic tests; default new Date()
}

export interface PrincipleReport {
  principle: string; // principle belief id
  family: string;
  anchor: string;
  absorbed: string[]; // member ids folded in THIS run
  created: boolean; // true = new principle, false = extended an existing one
}

export interface ConsolidateReport {
  principles: PrincipleReport[];
  retired: number;
  liveBefore: number;
  liveAfter: number;
}

const FAMILIES = new Set(["cochange", "churn", "files", "facts"]);

export function consolidate(store: Store, opts: ConsolidateOptions = {}): ConsolidateReport {
  const threshold = opts.threshold ?? 6;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const horizon = addDays(nowIso, opts.horizonDays ?? 120);
  const report: ConsolidateReport = { principles: [], retired: 0, liveBefore: 0, liveAfter: 0 };

  const liveNow = (): number => store.all().filter((b) => b.status === "live").length;
  report.liveBefore = liveNow();

  // Group consolidatable live beliefs by (family, anchor).
  const groups = new Map<string, { family: string; anchor: string; members: Belief[] }>();
  for (const b of store.all()) {
    if (!consolidatable(b)) continue;
    const fa = familyOf(b);
    if (!fa.family || !fa.anchor) continue;
    const key = fa.family + "\x00" + fa.anchor;
    let g = groups.get(key);
    if (!g) { g = { family: fa.family, anchor: fa.anchor, members: [] }; groups.set(key, g); }
    g.members.push(b);
  }

  // Deterministic order: by key, so the run is reproducible regardless of Map order.
  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key)!;
    const claim = templateClaim(g.family, g.anchor);
    const evidence: Evidence[] = [{
      kind: "derived",
      ref: `consolidation:${g.family}@${g.anchor}`,
      note: "", // the volatile member count goes in the note below — NOT part of identity
    }];
    const id = beliefId(claim, evidence);
    const existing = store.get(id);
    const existingLive = existing && existing.status === "live" ? existing : undefined;

    // Only open a NEW principle once a family is genuinely bloated; but always EXTEND an
    // existing principle, even by one member, so the live set never re-inflates.
    if (!existingLive && g.members.length < threshold) continue;

    const memberIds = g.members.map((m) => m.id).sort();
    const lineage = union(existingLive?.lineage ?? [], memberIds);
    const subjects = union(existingLive?.subjects ?? [], g.members.flatMap((m) => m.subjects)).slice(0, 12);
    const born = g.members.map((m) => m.born).filter(Boolean).sort()[0] || nowIso;

    const principle: Belief = {
      id,
      kind: "inferred",
      status: "live",
      claim,
      subjects,
      confidence: clamp01(0.5 + Math.min(0.3, lineage.length / 40)),
      method: "consolidation",
      watch: watchFor(g.anchor, horizon),
      evidence: [{ ...evidence[0], note: `consolidates ${lineage.length} belief(s)` }],
      lineage,
      origin: "metabolize:consolidate",
      born,
      lastVerified: nowIso,
      supersededBy: "",
    };
    if (lintBelief(principle).length) continue; // a malformed principle is never persisted

    store.persist(principle);
    appendTrace(store.loc, makeTrace("consolidate", {
      actor: "metabolize:consolidate", subject: id, ref: `${g.family}@${g.anchor}`,
      note: `${memberIds.length} absorbed → ${lineage.length} total`,
    }));

    // Retire the members — a forwarding address, not a deletion.
    for (const m of g.members) {
      m.status = "retired";
      m.supersededBy = id;
      m.lastVerified = nowIso;
      m.tombstone = { death: "consolidated", at: nowIso, by: id, note: `absorbed into principle ${id}` };
      store.persist(m);
      appendTrace(store.loc, makeTrace("retire", { actor: "metabolize:consolidate", subject: m.id, ref: id, note: "consolidated" }));
      report.retired++;
    }

    report.principles.push({ principle: id, family: g.family, anchor: g.anchor, absorbed: memberIds, created: !existingLive });
  }

  report.liveAfter = liveNow();
  return report;
}

// A belief is fair game for consolidation iff folding it away loses no mortality and no
// standing order: live, not a directive, not a symbol definition, not itself a
// principle, not still-quarantined, and in a family we know how to summarize.
function consolidatable(b: Belief): boolean {
  if (b.status !== "live") return false;
  if (b.kind === "directive") return false;
  if (b.method === "read-source") return false; // the scar-killers stay granular
  if (b.method === "consolidation") return false; // principles are not re-absorbed here
  if (isProvisional(b)) return false; // quarantined extractions must corroborate first
  return FAMILIES.has(familyOf(b).family);
}

function familyOf(b: Belief): { family: string; anchor: string } {
  switch (b.method) {
    case "git-cochange": return { family: "cochange", anchor: smallestFile(b.subjects) };
    case "git-churn": return { family: "churn", anchor: dirAnchor(b.subjects) };
    case "git-history": return { family: "files", anchor: dirAnchor(b.subjects) };
    case "user-told": return { family: "facts", anchor: b.subjects[0] ?? "" };
    case "llm-extract": return { family: "facts", anchor: b.subjects[0] ?? "" };
    default: return { family: "", anchor: "" };
  }
}

function templateClaim(family: string, anchor: string): string {
  const disp = anchor === "." ? "(repository root)" : anchor;
  switch (family) {
    case "cochange": return `\`${disp}\` is an edit-coupling hub — the files that change alongside it are consolidated under this principle (see lineage).`;
    case "churn": return `\`${disp}\` is a churn cluster — its high-change files are consolidated under this principle (see lineage).`;
    case "files": return `\`${disp}\` is a tracked subsystem — its source files are consolidated under this principle (see lineage).`;
    case "facts": return `Consolidated notes about \`${disp}\` (see lineage for the beliefs folded in here).`;
    default: return `Consolidated \`${disp}\` (see lineage).`;
  }
}

// The principle inherits real death conditions: it dies if its anchor file/dir is
// deleted, and it expires anyway (a summary is perishable — re-derive it periodically).
// Existence is checked lazily by the reverification sweep, never here at mint.
function watchFor(anchor: string, horizon: string): WatchClause[] {
  const w: WatchClause[] = [];
  const pathLike = /[/.]/.test(anchor) && anchor !== ".";
  if (pathLike) w.push({ kind: "path", target: anchor, expect: "present" });
  w.push({ kind: "expire", target: horizon, expect: "" });
  return w;
}

// ── small mechanical helpers ────────────────────────────────────────────────

function looksLikeFile(s: string): boolean {
  return /\.[A-Za-z0-9]{1,6}$/.test(s) && !s.includes(" ");
}

function smallestFile(subjects: string[]): string {
  const files = subjects.filter(looksLikeFile).sort();
  return files[0] ?? "";
}

function dirAnchor(subjects: string[]): string {
  const file = subjects.find(looksLikeFile);
  if (file) return dirname(file);
  // a subject that is already a directory
  const dir = subjects.find((s) => s.includes("/"));
  return dir ?? subjects[0] ?? "";
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

