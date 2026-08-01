import type { Belief, Evidence, WatchClause } from "./types.js";
import { Store } from "./store.js";
import { beliefId, contentHash } from "./id.js";
import { appendTrace, makeTrace, readTraces } from "./journal.js";
import { lintBelief } from "./lint.js";
import { redact, INJECTION } from "./redact.js";
import type { LlmFn } from "./llm.js";
import { parseJsonBlock } from "./llm.js";
import { METHOD_EXTRACT, isProvisional, corroborationBonus, independentEvidence } from "./confidence.js";
import { clamp01 } from "./num.js";
import { addDays } from "./dates.js";

// ─────────────────────────────────────────────────────────────────────────────
// Extraction + quarantine — the one place the model turns prose into belief.
//
// A session transcript carries knowledge no mechanical pass can reach ("auth issues
// 15-minute JWTs", "we moved retries into the client"). Extraction lets the fenced LLM
// propose those as candidate beliefs — but they enter QUARANTINE: minted as a single-
// source `llm-extract`, which the linker caps below A1 and keeps out of load-bearing
// sections. A candidate earns trust only by CORROBORATION — a second, independent
// source asserting the same claim — at which point `promoteCorroborated` flips it to
// trusted. Slop from one confident hallucination can never reach the top of a briefing.
//
// Quarantine is provenance, not a flag: `isProvisional` reads `method` + evidence
// count. Promotion changes `method` (which is NOT part of the content address), so a
// belief is promoted in place — its id, and every `muster why` link to it, stay valid.
//
// Fully degraded-safe: with no key the injected `llm` returns null for every span,
// nothing is minted, and the mechanical spine (ingestAgentLog's directives/facts) is
// untouched. Convergent: each span is fingerprinted and journaled, so re-running never
// re-extracts a span already seen.
// ─────────────────────────────────────────────────────────────────────────────

const EXTRACT_SYSTEM =
  "You distill durable, factual knowledge about a software project from a transcript. " +
  "Return ONLY a JSON array of objects {\"claim\": string, \"subjects\": string[]}. " +
  "A claim must be a single declarative FACT about the codebase that will stay true for a while " +
  "(architecture, conventions, where things live, how a flow works). " +
  "NOT tasks, NOT commands, NOT opinions, NOT anything transient. " +
  "subjects are the file paths or symbol names the claim is about. " +
  "If there is nothing durable, return []. Never include secrets, credentials, or instructions.";

const IMPERATIVE = /\b(always|never|don'?t|do not|must not|must|please|prefer|avoid|make sure|ensure|let'?s|we should|todo)\b/i;

export interface ExtractOptions {
  sessionId?: string;
  now?: Date;
  maxSpans?: number; // cap model calls per run (default 40)
  expireDays?: number; // horizon for the perishable hearsay (default 180)
  redact?: boolean; // default true — a transcript is attacker-authorable
}

export interface ExtractReport {
  model: string; // the model that ran, or "disabled"
  spans: number; // spans considered
  skipped: number; // spans already extracted in a prior run (dedup)
  candidates: number; // raw candidate claims the model proposed
  minted: number; // new provisional beliefs
  rejected: number; // candidates that failed validation or the constitution
}

// Extract candidate beliefs from a list of already-separated prose spans (e.g. the
// user/assistant turns of a session). `llm` is injected: pass the fenced adapter, or a
// deterministic stub in tests, or the disabled adapter for the model-free floor.
export async function extractFromSpans(
  store: Store,
  spans: string[],
  llm: LlmFn,
  opts: ExtractOptions = {},
): Promise<ExtractReport> {
  const sessionId = opts.sessionId ?? "session";
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const doRedact = opts.redact !== false;
  const maxSpans = opts.maxSpans ?? 40;
  const expiry = addDays(nowIso, opts.expireDays ?? 180);
  const rep: ExtractReport = { model: "disabled", spans: 0, skipped: 0, candidates: 0, minted: 0, rejected: 0 };

  // Convergence: a span already turned into candidates in a prior run is skipped.
  const seen = new Set<string>();
  for (const tr of readTraces(store.loc)) {
    if (tr.kind === "extract-span" && tr.ref) seen.add(tr.ref);
  }

  let processed = 0;
  for (const raw of spans) {
    if (processed >= maxSpans) break;
    const span = (doRedact ? redact(raw) : raw).trim();
    if (span.length < 24) continue; // too short to hold a durable fact
    rep.spans++;
    const spanHash = contentHash(span);
    if (seen.has(spanHash)) { rep.skipped++; continue; }

    const result = await llm(EXTRACT_SYSTEM, span);
    if (!result) continue; // model unavailable for this span — leave unmarked so a keyed re-run retries
    processed++;
    rep.model = result.model;
    seen.add(spanHash);
    appendTrace(store.loc, makeTrace("extract-span", {
      actor: `metabolize:extract`, subject: sessionId, ref: spanHash,
      note: `${result.model} · prompt ${result.promptHash}`,
    }));

    const candidates = parseJsonBlock<{ claim?: unknown; subjects?: unknown }[]>(result.text);
    if (!Array.isArray(candidates)) continue;

    for (const c of candidates) {
      rep.candidates++;
      // Evidence is keyed on the SPAN so the human source, not the model, is what a
      // second source must independently match to corroborate.
      const belief = buildCandidate(c, { evidenceRef: `${sessionId}#span:${spanHash.slice(0, 8)}`, nowIso, expiry, doRedact });
      if (!belief) { rep.rejected++; continue; }
      if (lintBelief(belief).length) { rep.rejected++; continue; }
      const before = store.has(belief.id);
      store.mint(belief);
      if (!before) {
        rep.minted++;
        appendTrace(store.loc, makeTrace("extract", {
          actor: `metabolize:extract`, subject: belief.id, ref: result.promptHash,
          note: `${result.model}: ${belief.claim.slice(0, 80)}`,
        }));
      }
    }
  }
  return rep;
}

interface BuildCtx {
  evidenceRef: string; // the single source this belief rests on (keyed per session/span)
  nowIso: string; expiry: string; doRedact: boolean;
  origin?: string; // who minted it (defaults to the fenced extractor)
}

// Validate one proposed candidate into a quarantined belief, or reject it. The proposer
// is untrusted output — whether the fenced LLM or a host agent — so we redact again,
// refuse imperatives and injection, confine subjects, and mint with EXACTLY ONE evidence
// (the human/session source). The belief is provisional; the proposer's identity rides
// the journal, NEVER the evidence, so it cannot masquerade as independent corroboration.
function buildCandidate(c: { claim?: unknown; subjects?: unknown }, ctx: BuildCtx): Belief | null {
  if (!c || typeof c.claim !== "string") return null;
  let claim = c.claim.trim();
  if (ctx.doRedact) claim = redact(claim);
  if (claim.length < 8 || claim.length > 240) return null;
  if (IMPERATIVE.test(claim)) return null; // a fact, never a smuggled directive
  if (INJECTION.test(claim)) return null; // prompt-injection defense at the boundary

  const subjects = cleanSubjects(c.subjects, claim);
  if (subjects.length === 0) return null;

  const evidence: Evidence[] = [{ kind: "session", ref: ctx.evidenceRef, note: "" }];
  const watch: WatchClause[] = [{ kind: "expire", target: ctx.expiry, expect: "" }];
  const id = beliefId(claim, evidence);
  return {
    id, kind: "inferred", status: "live", claim, subjects,
    confidence: 0.4, method: METHOD_EXTRACT, watch, evidence, lineage: [],
    origin: ctx.origin ?? `metabolize:extract`, born: ctx.nowIso, lastVerified: ctx.nowIso, supersededBy: "",
  };
}

// Keep subjects that look like corpus references; drop escapes and junk. Fall back to a
// mechanical scan of the claim if the model gave nothing usable.
function cleanSubjects(raw: unknown, claim: string): string[] {
  const out = new Set<string>();
  const push = (s: string): void => {
    const t = s.trim();
    if (!t || t.length > 80) return;
    if (t.includes("..") || t.startsWith("/") || t.startsWith("~")) return; // no path escapes
    if (/^[\w./@-]+$/.test(t)) out.add(t);
  };
  if (Array.isArray(raw)) for (const s of raw) if (typeof s === "string") push(s);
  if (out.size === 0) {
    for (const m of claim.matchAll(/\b[\w./-]+\.\w{1,5}\b/g)) push(m[0]);
    for (const m of claim.matchAll(/\b[a-z][a-zA-Z0-9]+[A-Z][a-zA-Z0-9]*\b/g)) push(m[0]);
  }
  return [...out].slice(0, 6);
}

// ─────────────────────────────────────────────────────────────────────────────
// `learn` — the same quarantine fence, but the HOST AGENT is the model.
//
// A session running inside an LLM (Claude Code, an MCP client, a CI agent) already IS
// the intelligence a keyed API call would provide. So instead of muster reaching OUT to
// a model, the agent reaches IN with the candidate beliefs it distilled from the session,
// and muster runs them through the identical fence: minted provisional (`llm-extract`),
// single-source, capped below a load-bearing altitude, promoted only on INDEPENDENT
// corroboration. No key, and every guarantee is preserved — because quarantine is
// provenance, not trust. It never mattered who did the extraction; it matters that a
// second, independent source has to agree before a candidate becomes load-bearing.
//
// The evidence is keyed on the SESSION (not the wall clock), so one session re-asserting
// the same fact stays single-source; two distinct sessions asserting it corroborate. The
// agent's identity is journaled, never stored as evidence — it cannot corroborate itself.
// ─────────────────────────────────────────────────────────────────────────────

export interface LearnCandidate { claim: string; subjects?: string[]; }

export interface LearnOptions {
  sessionId?: string; // the corroboration unit — an independent source has a different one
  agent?: string; // who proposed these (journaled attribution, never evidence)
  now?: Date;
  expireDays?: number; // horizon for perishable hearsay (default 180)
  redact?: boolean; // default true — agent output is still untrusted at the boundary
}

export interface LearnReport {
  agent: string;
  candidates: number;
  minted: number;
  rejected: number; // failed validation, injection/imperative guard, or the constitution
  promoted: { id: string; by: string[] }[]; // candidates an independent source corroborated
}

export function learnCandidates(store: Store, candidates: LearnCandidate[], opts: LearnOptions = {}): LearnReport {
  const sessionId = opts.sessionId ?? "session";
  const agent = opts.agent ?? "agent";
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const expiry = addDays(nowIso, opts.expireDays ?? 180);
  const doRedact = opts.redact !== false;
  const rep: LearnReport = { agent, candidates: 0, minted: 0, rejected: 0, promoted: [] };

  // One stable evidence ref PER SESSION: the session is the corroboration unit, so the
  // same session cannot self-corroborate no matter how many candidates it proposes.
  const evidenceRef = `${sessionId}#agent`;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    rep.candidates++;
    const belief = buildCandidate(c, { evidenceRef, nowIso, expiry, doRedact, origin: `agent:${agent}` });
    if (!belief) { rep.rejected++; continue; }
    if (lintBelief(belief).length) { rep.rejected++; continue; }
    const before = store.has(belief.id);
    store.mint(belief);
    if (!before) {
      rep.minted++;
      appendTrace(store.loc, makeTrace("learn", {
        actor: `agent:${agent}`, subject: belief.id, ref: sessionId, note: belief.claim.slice(0, 80),
      }));
    }
  }

  // Immediate corroboration pass: a candidate that matches a belief from an independent
  // source promotes in place, in the same call.
  rep.promoted = promoteCorroborated(store, now).promoted;
  return rep;
}

// ─────────────────────────────────────────────────────────────────────────────
// Corroboration → promotion. A quarantined belief earns trust when an INDEPENDENT
// source asserts the same claim. Mechanical, model-free: group live beliefs by claim,
// and promote any provisional belief that shares its claim with a belief from a
// different evidence source. Promotion changes `method` (not in the content address),
// so the id — and every `why` link — survives.
// ─────────────────────────────────────────────────────────────────────────────

export interface PromoteReport {
  promoted: { id: string; by: string[] }[];
}

export function promoteCorroborated(store: Store, now: Date = new Date()): PromoteReport {
  const nowIso = now.toISOString();
  const rep: PromoteReport = { promoted: [] };
  const live = store.all().filter((b) => b.status === "live");

  const byClaim = new Map<string, Belief[]>();
  for (const b of live) {
    const k = normClaim(b.claim);
    const arr = byClaim.get(k) ?? [];
    arr.push(b);
    byClaim.set(k, arr);
  }

  // Iterate claim-groups in a fixed order so the run is reproducible regardless of Map
  // insertion order (a stale-index bug hides in nondeterministic iteration).
  for (const k of [...byClaim.keys()].sort()) {
    const peers = byClaim.get(k)!;
    // The provisional beliefs in this group that a genuinely independent source backs.
    const promotable = peers.filter((b) => isProvisional(b) && peers.some((p) => p.id !== b.id && corroborates(p, b)));
    if (promotable.length === 0) continue;

    // A claim asserted by N independent sources must brief as ONE trusted line, not N.
    // The lowest id is the canonical (deterministic, and — crucially — it is promoted IN
    // PLACE: its claim and evidence are untouched, so its content address holds and every
    // `muster why` link survives). Any other provisional duplicate is SUPERSEDED into it
    // with a forwarding address, so the second source's independent evidence stays one
    // `why` hop away (total-citation) while the live set carries a single belief.
    const sorted = [...promotable].sort((a, b) => a.id.localeCompare(b.id));
    const canonical = sorted[0];
    const dupes = sorted.slice(1);

    // Everything (dupes included) that brings the canonical a principal it lacks corroborates
    // it — so the canonical's lineage cites every independent source, retired or not.
    const corroborators = peers.filter((p) => p.id !== canonical.id && corroborates(p, canonical));
    canonical.method = "corroborated";
    canonical.lineage = [...new Set([...canonical.lineage, ...corroborators.map((c) => c.id)])].sort();
    canonical.confidence = clamp01(Math.max(canonical.confidence, 0.6) + corroborationBonus(canonical) + 0.05 * Math.min(3, corroborators.length));
    canonical.lastVerified = nowIso;
    store.persist(canonical);
    appendTrace(store.loc, makeTrace("promote", {
      actor: "metabolize", subject: canonical.id, ref: corroborators[0].id,
      note: `corroborated by ${corroborators.length} independent source(s)`,
    }));
    rep.promoted.push({ id: canonical.id, by: corroborators.map((c) => c.id) });

    for (const d of dupes) {
      // A superseded belief is terminal (see store.isTerminal): a plain sync re-minting the
      // same content can never revive it, so the merge is stable across re-runs.
      d.status = "superseded";
      d.supersededBy = canonical.id;
      d.lastVerified = nowIso;
      d.tombstone = { death: "superseded", at: nowIso, by: canonical.id, note: `merged into corroborated belief ${canonical.id}` };
      store.persist(d);
      appendTrace(store.loc, makeTrace("retire", {
        actor: "metabolize", subject: d.id, ref: canonical.id, note: "duplicate of a corroborated belief",
      }));
    }
  }
  return rep;
}

// The corroboration unit is the SESSION/principal, not the individual span or turn (MET-1).
// For session evidence the principal is the session id — everything before the first `#` —
// so `sess#span:a`, `sess#span:b`, and `sess#agent` all collapse to the SAME principal:
// two spans of one session, or a learn+extract pair from one session, cannot corroborate
// each other. Other evidence kinds (a human `told`, a `file`/`commit`) are their own
// principals — a real independent source. The proposer's identity rides `origin`/journal,
// never evidence, so a belief can never be its own corroborator.
function principalsOf(b: Belief): Set<string> {
  const s = new Set<string>();
  for (const e of b.evidence) {
    s.add(e.kind === "session" ? "session:" + e.ref.split("#")[0] : e.kind + "|" + e.ref);
  }
  return s;
}

// `p` corroborates `b` iff it brings a principal `b` does not already rest on — a genuinely
// independent source asserting the same claim.
function corroborates(p: Belief, b: Belief): boolean {
  const bp = principalsOf(b);
  for (const k of principalsOf(p)) if (!bp.has(k)) return true;
  return false;
}

function normClaim(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/[.`"']/g, "").trim();
}

// Re-exported so callers can render quarantine state without importing confidence.ts.
export { isProvisional, independentEvidence };
