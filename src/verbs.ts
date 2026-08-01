import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Loc } from "./paths.js";
import { resolveLoc, privateLoc, beliefsDir, ensureDir } from "./paths.js";
import { Store } from "./store.js";
import { ingestGit, ingestAgentLog } from "./ingest.js";
import { sweep } from "./watch.js";
import { compileBriefing } from "./linker.js";
import { beliefId } from "./id.js";
import { appendTrace, makeTrace, readTraces, journalFiles } from "./journal.js";
import { verifyStore } from "./integrity.js";
import { assertBelief } from "./lint.js";
import { redact } from "./redact.js";
import { metabolize, readSpans } from "./metabolize.js";
import { learnCandidates, type LearnCandidate } from "./extract.js";
import { describeConfidence, isProvisional } from "./confidence.js";
import { exhaustive } from "./schema.js";
import { splitSymbolTarget } from "./symbols.js";
import { addDays } from "./dates.js";
import { currentWriter } from "./principal.js";
import { withLease } from "./lease.js";
import type { Belief, Evidence, WatchClause, Trace, Briefing } from "./types.js";

// Thrown when an id resolves to no belief. The two edges map it to their own idiom:
// the CLI to a distinct exit code (not-found), MCP to a tool error. A programmatic
// caller that wants a soft result can catch it. LeaseBusyError (from ./lease) is the
// other typed outcome the edges special-case — neither is swallowed into a string here.
export class NotFoundError extends Error {
  constructor(public readonly query: string) {
    super(`no belief matching "${query}"`);
    this.name = "NotFoundError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// sync — synchronize memory with reality. Ingest a repo's exhaust (git history +
// optional agent-session log), then reverify the whole store. This is the operation
// that keeps beliefs honest; run it whenever the world moved. `--git` also commits
// the store, because the store IS a git repo.
// ─────────────────────────────────────────────────────────────────────────────

export interface SyncArgs {
  repo?: string; store?: string; log?: string; sessionId?: string;
  maxCommits?: number; pathPrefix?: string; maxSymbols?: number;
  redact?: boolean; git?: boolean; push?: boolean;
}

export async function cmdSync(a: SyncArgs): Promise<string> {
  const loc = resolveLoc(a);
  // The sweep rewrites belief files in place, so it runs under the lease — never
  // interleaved with a concurrent metabolize on the same store. A busy store throws
  // LeaseBusyError, handled at the edge (CLI → exit code, MCP → soft tool text).
  return await withLease(loc, { holder: `sync:${currentWriter()}` }, () => syncBody(a, loc));
}

function syncBody(a: SyncArgs, loc: Loc): string {
  const store = Store.open(loc);
  const out: string[] = [];

  ensureStoreGitignore(loc); // the local overlay, caches, and lease temps must never be shared
  ensureStoreGitattributes(loc); // pin store bytes: no CRLF conversion on any teammate's checkout
  const git = ingestGit(store, {
    repo: loc.repo,
    maxCommits: a.maxCommits ?? 300,
    pathPrefix: a.pathPrefix ?? "",
    maxSymbolsPerFile: a.maxSymbols ?? 40,
    redact: a.redact,
  });
  out.push(`ingest(git)  ${git.commits} commits · ${git.files} files · ${git.symbols} symbols · ${git.cochange} co-change · ${git.hotspots} hotspots · ${git.tests} tests`);
  out.push(`             → ${git.minted} new beliefs${git.rejected ? ` · ${git.rejected} rejected by the linter` : ""}${git.secretsRedacted ? ` · ${git.secretsRedacted} secret(s) redacted` : ""}`);
  if (git.cappedFiles.length) {
    out.push(`             (symbol cap reached in ${git.cappedFiles.length} file(s); raise --max-symbols to include more)`);
  }

  if (a.log && existsSync(a.log)) {
    const log = ingestAgentLog(store, a.log, a.sessionId ?? "session", a.redact !== false);
    out.push(`ingest(log)  ${log.events} events → ${log.minted} belief(s)${log.secretsRedacted ? ` · ${log.secretsRedacted} secret(s) redacted` : ""}`);
  }

  const sw = sweep(store);
  out.push(`sweep        ${sw.checked} live beliefs reverified · ${sw.killed.length} died · ${sw.staled.length} went stale`);
  for (const k of sw.killed.slice(0, 8)) out.push(`             ✝ ${k.id}  ${k.reason}`);
  if (sw.killed.length > 8) out.push(`             … and ${sw.killed.length - 8} more`);

  const all = store.all();
  const live = all.filter((b) => b.status === "live").length;
  const dead = all.filter((b) => b.status === "dead").length;
  out.push(`store        ${all.length} beliefs · ${live} live · ${dead} tombstoned → ${loc.store}`);

  if (a.git || a.push) out.push(gitCommitStore(loc, a.push === true));
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// metabolize — the fenced write-path intelligence. Promote corroborated candidates,
// reconcile contradictions, consolidate bloated families into cited principles, and
// (with a key + a session log) extract new candidate beliefs into quarantine. Every
// mechanical process runs with no model; the LLM only ADDS learning-from-prose.
// ─────────────────────────────────────────────────────────────────────────────

export interface MetabolizeArgs {
  repo?: string; store?: string; log?: string; sessionId?: string;
  threshold?: number; git?: boolean;
}

export async function cmdMetabolize(a: MetabolizeArgs): Promise<string> {
  const loc = resolveLoc(a);
  return await withLease(loc, { holder: `metabolize:${currentWriter()}` }, () => metabolizeBody(a, loc));
}

async function metabolizeBody(a: MetabolizeArgs, loc: Loc): Promise<string> {
  const store = Store.open(loc);
  const spans = a.log && existsSync(a.log) ? readSpans(a.log) : [];
  const r = await metabolize(store, { spans, sessionId: a.sessionId, threshold: a.threshold });

  const out: string[] = [];
  const degraded = r.model === "disabled";
  out.push(`metabolize   model ${r.model}${degraded ? "  (degraded mode — mechanical spine only; set MUSTER_LLM_KEY to learn from prose)" : ""}`);
  if (r.extract) {
    out.push(`  extract     ${r.extract.spans} span(s) → ${r.extract.minted} quarantined · ${r.extract.rejected} rejected · ${r.extract.skipped} already seen`);
  }
  out.push(`  promote     ${r.promote.promoted.length} quarantined belief(s) corroborated → trusted`);
  out.push(`  reconcile   ${r.reconcile.resolved.length} contradiction(s) resolved · ${r.reconcile.disputes.length} escalated to open disputes`);
  out.push(`  consolidate ${r.consolidate.principles.length} principle(s) · ${r.consolidate.retired} belief(s) retired into them (total-citation preserved)`);
  for (const p of r.consolidate.principles.slice(0, 8)) {
    out.push(`     ⊕ ${p.principle}  ${p.family}@${p.anchor}  (+${p.absorbed.length}${p.created ? " · new" : ""})`);
  }
  out.push(`  live set    ${r.liveBefore} → ${r.liveAfter} beliefs (the record keeps everything; only briefing candidacy changed)`);
  if (a.git) out.push(gitCommitStore(loc, false));
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// learn — the host agent IS the model. A session running inside an LLM distills facts
// from itself and hands muster the candidates; muster runs the SAME quarantine fence as
// the fenced extractor (provisional, single-source, capped, promote-on-corroboration).
// No key: the un-degraded write path when the caller brings its own intelligence.
// ─────────────────────────────────────────────────────────────────────────────

export interface LearnArgs {
  repo?: string; store?: string;
  candidates?: LearnCandidate[]; // programmatic / MCP
  json?: string; // raw JSON string (CLI --json '[…]')
  file?: string; // path to a JSON file (CLI --candidates FILE)
  sessionId?: string; agent?: string; git?: boolean;
}

export async function cmdLearn(a: LearnArgs): Promise<string> {
  const loc = resolveLoc(a);
  const cands = resolveCandidates(a);
  if (!cands.length) {
    return `learn        no candidates — pass --candidates FILE.json, --json '[{"claim":…,"subjects":[…]}]', or an array via MCP`;
  }
  return await withLease(loc, { holder: `learn:${currentWriter()}` }, () => {
    const store = Store.open(loc);
    const r = learnCandidates(store, cands, { sessionId: a.sessionId, agent: a.agent ?? currentWriter() });
    const out: string[] = [];
    out.push(`learn        ${r.candidates} candidate(s) from agent "${r.agent}" → ${r.minted} quarantined · ${r.rejected} rejected`);
    out.push(`  quarantine  minted single-source & provisional — each briefs only in §7 (verify-first) until`);
    out.push(`              an INDEPENDENT source asserts the same claim, then it promotes in place (id preserved)`);
    if (r.promoted.length) {
      out.push(`  promote     ${r.promoted.length} corroborated → trusted (an independent source already agreed)`);
      for (const p of r.promoted.slice(0, 6)) out.push(`     ↑ ${p.id}`);
    }
    if (a.git) out.push(gitCommitStore(loc, false));
    return out.join("\n");
  });
}

// Candidates can arrive programmatically (MCP), as a --json string, or from a --candidates
// file. Accept either a bare array or a { candidates: [...] } envelope; keep only well-
// formed {claim, subjects?} shapes (the fence rejects the rest at mint time).
function resolveCandidates(a: LearnArgs): LearnCandidate[] {
  if (a.candidates && a.candidates.length) return sanitizeCandidates(a.candidates);
  let raw = "";
  if (a.json) raw = a.json;
  else if (a.file && existsSync(a.file)) raw = readFileSync(a.file, "utf8");
  if (!raw.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const arr = Array.isArray(parsed) ? parsed
    : (parsed && typeof parsed === "object" && Array.isArray((parsed as { candidates?: unknown }).candidates))
      ? (parsed as { candidates: unknown[] }).candidates : [];
  return sanitizeCandidates(arr);
}

function sanitizeCandidates(arr: unknown): LearnCandidate[] {
  if (!Array.isArray(arr)) return [];
  const out: LearnCandidate[] = [];
  for (const c of arr) {
    if (c && typeof c === "object" && typeof (c as { claim?: unknown }).claim === "string") {
      const subj = (c as { subjects?: unknown }).subjects;
      out.push({ claim: String((c as { claim: string }).claim), subjects: Array.isArray(subj) ? subj.map(String) : undefined });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// brief — compile a deterministic, budget-shaped briefing for a task.
// ─────────────────────────────────────────────────────────────────────────────

export interface BriefArgs { repo?: string; store?: string; task: string; budget?: number; json?: boolean; }

export function cmdBrief(a: BriefArgs): string {
  const loc = resolveLoc(a);
  const store = Store.mergedRead(loc, privateLoc(loc)); // team ⊕ private overlay
  const b = compileBriefing(store, a.task, a.budget ?? 2000);
  // Re-redact at render (SEC-1): beliefs are redacted at ingest, but the read path is the
  // last gate before a secret reaches an agent's context. redact() is pure and offline
  // (no clock/network/model), so the read path stays deterministic. Corpus-structural ids
  // (belief ids, shas) are allowlisted, so `why` links survive.
  if (a.json) return briefJson(b);
  // A dropped tripwire/standing order is surfaced LOUDLY (never hidden behind the count).
  const warn = b.mandatoryOmitted > 0
    ? ` · ⚠ ${b.mandatoryOmitted} tripwire/standing-order did NOT fit — raise --budget`
    : "";
  return `${redact(b.text)}[${b.used}/${b.budget} tokens · ${b.lines.length} lines · ${b.omitted} relevant beliefs held back under budget${warn}]`;
}

// The machine-readable briefing: same numbers as the human footer, plus per-line
// structure (section, belief id, altitude, tokens). Text is redacted on the same
// pure/offline path as the human render — the JSON is never a redaction bypass.
function briefJson(b: Briefing): string {
  return JSON.stringify({
    task: b.task, budget: b.budget, used: b.used, asOf: b.asOf,
    lineCount: b.lines.length, omitted: b.omitted, mandatoryOmitted: b.mandatoryOmitted,
    lines: b.lines.map((l) => ({
      section: l.section, id: l.beliefId, altitude: l.altitude, tokens: l.tokens, text: redact(l.text),
    })),
    text: redact(b.text),
  }, null, 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// why — the provenance chain of one belief, walked all the way to the journal.
// ─────────────────────────────────────────────────────────────────────────────

export interface WhyArgs { repo?: string; store?: string; id: string; json?: boolean; }

export function cmdWhy(a: WhyArgs): string {
  const loc = resolveLoc(a);
  const store = Store.mergedRead(loc, privateLoc(loc)); // a private belief is queryable too
  const id = normId(a.id);
  const b = store.get(id) ?? store.get(a.id) ?? resolvePrefix(store, id);
  if (!b) throw new NotFoundError(a.id);

  const traces = readTraces(loc);
  if (a.json) return whyJson(b, traces);
  const L: string[] = [];
  L.push(`${b.id}  ${b.kind} · ${b.status} · confidence ${describeConfidence(b)}`);
  L.push(`  claim:    ${redact(b.claim)}`);
  if (b.summary) L.push(`  summary:  ${redact(b.summary)}`);
  L.push(`  born:     ${b.born}   origin ${b.origin}`);
  L.push(`  verified: ${b.lastVerified}`);
  L.push(`  subjects: ${b.subjects.join(", ") || "(none)"}`);

  if (isProvisional(b)) {
    L.push(`  ⚠ QUARANTINE: single-source extraction — briefs only as an unverified open question`);
    L.push(`               until a second, independent source asserts the same claim (then it promotes in place).`);
  }
  if (b.method === "consolidation") {
    const sample = b.lineage.slice(0, 6).join(", ");
    L.push(`  ⊕ PRINCIPLE: consolidates ${b.lineage.length} belief(s) — ${sample}${b.lineage.length > 6 ? ", …" : ""}`);
  }
  if (b.method === "dispute") {
    L.push(`  ⚖ DISPUTE:   an unresolved contradiction between ${b.lineage.join(" and ")} — briefed as an open question`);
  }

  if (b.tombstone) {
    L.push(`  ✝ DIED:   ${b.tombstone.death} on ${b.tombstone.at.slice(0, 19)}Z${b.tombstone.by ? ` — killed by ${b.tombstone.by}` : ""}`);
    L.push(`            ${redact(b.tombstone.note)}`);
  }

  if (b.watch.length) {
    L.push(`  dies if:`);
    for (const w of b.watch) L.push(`     · ${describeWatch(w)}`);
  } else {
    L.push(`  dies if:  never — standing order, killable only by \`muster deny\``);
  }

  L.push(`  evidence:`);
  for (const e of b.evidence) {
    L.push(`     · ${e.kind} ${e.ref}${e.note ? "  (" + redact(e.note) + ")" : ""}   →  ${auditHint(e, loc)}`);
    for (const tr of resolveEvidence(traces, e).slice(0, 2)) {
      L.push(`         ⤷ journal: ${tr.ts.slice(0, 19)}Z ${tr.kind} by ${tr.actor}${tr.note ? ` — ${redact(tr.note)}` : ""}`);
    }
  }

  const own = traces.filter((tr) => tr.subject === b.id);
  if (own.length) {
    L.push(`  journal:  ${own.length} event(s) reference this belief`);
    for (const tr of own.slice(0, 4)) L.push(`     · ${tr.ts.slice(0, 19)}Z ${tr.kind}${tr.note ? ` — ${redact(tr.note)}` : ""}`);
  }

  if (b.lineage.length) L.push(`  supersedes: ${b.lineage.join(", ")}`);
  if (b.supersededBy) L.push(`  superseded_by: ${b.supersededBy}`);
  return L.join("\n");
}

// The machine-readable provenance record: the belief's fields (redacted) plus its
// evidence and how many journal events reference it. Same data the human `why` walks.
function whyJson(b: Belief, traces: Trace[]): string {
  const journalEvents = traces.filter((tr) => tr.subject === b.id).length;
  return JSON.stringify({
    id: b.id, kind: b.kind, status: b.status,
    confidence: b.confidence, confidenceLabel: describeConfidence(b),
    claim: redact(b.claim),
    summary: b.summary ? redact(b.summary) : undefined,
    subjects: b.subjects, method: b.method, origin: b.origin,
    born: b.born, lastVerified: b.lastVerified,
    provisional: isProvisional(b),
    watch: b.watch,
    evidence: b.evidence.map((e) => ({ kind: e.kind, ref: e.ref, note: e.note ? redact(e.note) : "" })),
    lineage: b.lineage,
    supersededBy: b.supersededBy || undefined,
    tombstone: b.tombstone ? { ...b.tombstone, note: redact(b.tombstone.note) } : undefined,
    journalEvents,
  }, null, 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// tell — record a human-authored standing order (directive) or fact (told).
// ─────────────────────────────────────────────────────────────────────────────

export interface TellArgs { repo?: string; store?: string; text: string; directive?: boolean; fact?: boolean; private?: boolean; }

export async function cmdTell(a: TellArgs): Promise<string> {
  const loc = resolveLoc(a);
  // A private belief mounts over team memory but is never shared — write it to the
  // private overlay store (gitignored), keeping the team journal clean of local overrides.
  const target = a.private ? privateLoc(loc) : loc;
  // Mutations run under the store's lease, never interleaved with a concurrent
  // sweep/metabolize/deny on the same store (CON-2). A busy store throws
  // LeaseBusyError, handled at the edge (CLI → exit code, MCP → soft tool text).
  return await withLease(target, { holder: `tell:${currentWriter()}` }, () => tellBody(a, target));
}

function tellBody(a: TellArgs, target: Loc): string {
  const store = Store.open(target);
  const now = new Date().toISOString();
  const text = redact(a.text.trim());
  // A plain fact is mortal (ages out unless refreshed); a directive is eternal. The kind
  // is directive when the user says so (--directive) OR the wording reads like a standing
  // order — UNLESS --fact forces it mortal. The regex path is a heuristic, so it can be
  // wrong: an eternal order minted from a passing "must" is a silent footgun, so when the
  // regex (not an explicit flag) is what promoted it, we surface that LOUDLY below and
  // point at --fact. `--fact` always wins: it is the explicit "keep this mortal" override.
  const readsLikeDirective = /\b(always|never|don'?t|do not|must not|must|prefer|avoid|ensure|make sure)\b/i.test(text);
  const isDir = a.fact === true ? false : (a.directive === true || readsLikeDirective);
  const autoPromoted = isDir && a.directive !== true; // reached directive via the regex, not a flag
  const evidence: Evidence[] = [{ kind: "told", ref: `user@${now.slice(0, 10)}`, note: "" }];
  const id = beliefId(text, evidence);
  // A told fact is mortal (it ages out unless refreshed); a directive is eternal.
  const watch: WatchClause[] = isDir ? [] : [{ kind: "expire", target: addDays(now, 180), expect: "" }];
  const b: Belief = {
    id, kind: isDir ? "directive" : "told", status: "live", claim: text,
    subjects: subjectsOfText(text), confidence: isDir ? 1 : 0.85, method: "user-told",
    // Stamp the writer into origin so two teammates asserting opposite things carry
    // distinct principals — reconcile then escalates to a cross-principal dispute.
    watch, evidence, lineage: [], origin: `user:${currentWriter()}`, born: now, lastVerified: now, supersededBy: "",
  };
  // The write boundary refuses a rumor or a structurally-invalid belief before it lands.
  assertBelief(b);
  store.mint(b);
  appendTrace(target, makeTrace("told", { actor: `user:${currentWriter()}`, subject: id, note: text.slice(0, 120) }));
  const scope = a.private ? " · private (mounts over team, never shared)" : "";
  const life = isDir ? "\n  (standing order — briefed first, never decays)" : "\n  (mortal — expires in 180 days unless refreshed)";
  // Never silent: when the wording (not a flag) is what made this eternal, say so and
  // offer the mortal override — the user can undo a surprise standing order in one re-run.
  const promoted = autoPromoted
    ? `\n  ⚠ auto-promoted to a standing order — the wording reads like one ("always/never/must/…").\n    Re-run with --fact to keep it a mortal fact instead.`
    : "";
  return `${isDir ? "directive" : "belief"} recorded → ${id}${scope}\n  ${b.claim}${life}${promoted}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// deny — the user executes a belief. The highest court; the tombstone records their
// words, and the belief stays buried through every future re-sync.
// ─────────────────────────────────────────────────────────────────────────────

export interface DenyArgs { repo?: string; store?: string; id: string; reason?: string; }

export async function cmdDeny(a: DenyArgs): Promise<string> {
  const loc = resolveLoc(a);
  const id = normId(a.id);
  // The user is the highest court over BOTH stores: locate the belief across team ⊕
  // private and deny it in whichever concrete store holds it (a `tell --private` belief
  // is deny-able too — previously no verb could reach it). Locating is a lock-free read;
  // the mutation then runs under the holding store's lease.
  const target = locateForDeny(loc, id, a.id);
  if (!target) throw new NotFoundError(a.id);
  return await withLease(target, { holder: `deny:${currentWriter()}` }, () => {
    const store = Store.open(target);
    const b = store.get(id) ?? store.get(a.id) ?? resolvePrefix(store, id);
    if (!b) throw new NotFoundError(a.id);
    const now = new Date().toISOString();
    const reason = a.reason?.trim() || "denied by the user";
    b.status = "dead";
    b.lastVerified = now;
    b.tombstone = { death: "executed", at: now, by: "user", note: `${redact(reason)} — "${redact(b.claim)}"` };
    store.persist(b);
    appendTrace(target, makeTrace("deny", { actor: "user", subject: b.id, note: redact(reason).slice(0, 120) }));
    return `✝ ${b.id} denied and tombstoned.\n  ${b.tombstone.note}\n  (it will not resurrect on re-sync — the user is the highest court)`;
  });
}

// Which concrete store (team, then private overlay) holds a belief — for the mutating
// verbs that must reach a --private belief, not just the read-time merged view.
function locateForDeny(loc: Loc, id: string, raw: string): Loc | null {
  for (const target of [loc, privateLoc(loc)]) {
    if (!existsSync(beliefsDir(target))) continue;
    const store = Store.open(target);
    if (store.get(id) ?? store.get(raw) ?? resolvePrefix(store, id)) return target;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// verify — integrity by recomputation. Tamper is fatal; drift is a nudge to re-sync.
// ─────────────────────────────────────────────────────────────────────────────

export interface VerifyArgs { repo?: string; store?: string; json?: boolean; }

export function cmdVerify(a: VerifyArgs): { text: string; fatal: boolean } {
  const loc = resolveLoc(a);
  const store = Store.open(loc);
  const r = verifyStore(store);
  if (a.json) {
    const text = JSON.stringify({
      beliefs: r.beliefs, clean: r.clean, fatal: r.fatal,
      journalLines: r.journalLines, journalTorn: r.journalTorn,
      issues: r.issues.map((i) => ({ kind: i.kind, id: i.id, fatal: i.fatal, detail: i.detail })),
    }, null, 2);
    return { text, fatal: r.fatal };
  }
  const L: string[] = [];
  L.push(`verify  ${r.beliefs} beliefs · ${r.clean} clean · ${r.issues.length} issue(s)`);
  L.push(`journal ${r.journalLines} lines · ${r.journalTorn} torn (tolerated)`);
  const byKind = new Map<string, number>();
  for (const i of r.issues) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
  if (byKind.size) L.push(`        ${[...byKind].map(([k, n]) => `${k}=${n}`).join("  ")}`);
  for (const i of r.issues.slice(0, 20)) L.push(`  ${i.fatal ? "✗" : "•"} [${i.kind}] ${i.id}: ${i.detail}`);
  if (r.issues.length > 20) L.push(`  … and ${r.issues.length - 20} more`);
  L.push(r.fatal ? "RESULT: TAMPER DETECTED — the immutable set does not match its content address." : "RESULT: intact — every id matches its content; drift (if any) clears with `muster sync`.");
  return { text: L.join("\n"), fatal: r.fatal };
}

// ─────────────────────────────────────────────────────────────────────────────
// status — store health at a glance.
// ─────────────────────────────────────────────────────────────────────────────

export function cmdStatus(a: { repo?: string; store?: string; json?: boolean }): string {
  const loc = resolveLoc(a);
  const store = Store.open(loc);
  const all = store.all();
  const byStatus = new Map<string, number>();
  const byKind = new Map<string, number>();
  for (const b of all) {
    byStatus.set(b.status, (byStatus.get(b.status) ?? 0) + 1);
    byKind.set(b.kind, (byKind.get(b.kind) ?? 0) + 1);
  }
  const soon = all.filter((b) => b.status === "live" && b.watch.some((w) => w.kind === "expire")).length;
  const tripwires = all.filter((b) => b.status === "dead" && b.tombstone?.death === "falsified").length;
  const shards = journalFiles(loc).filter((f) => f.writer).map((f) => f.writer);
  const privateBeliefs = existsSync(privateLoc(loc).store) ? Store.open(privateLoc(loc)).count() : 0;
  if (a.json) {
    return JSON.stringify({
      store: loc.store, repo: loc.repo, writer: currentWriter(), shards,
      beliefs: all.length, private: privateBeliefs,
      byStatus: Object.fromEntries([...byStatus].sort()),
      byKind: Object.fromEntries([...byKind].sort()),
      tripwires, expiring: soon,
    }, null, 2);
  }
  return [
    `store:   ${loc.store}`,
    `repo:    ${loc.repo}`,
    `writer:  ${currentWriter()}${shards.length ? `   (journal shards: ${shards.join(", ")})` : ""}`,
    `beliefs: ${all.length}${privateBeliefs ? ` (+${privateBeliefs} private, overlaid on read)` : ""}`,
    `  status  ${fmtMap(byStatus)}`,
    `  kind    ${fmtMap(byKind)}`,
    `  ${tripwires} tombstoned belief(s) stand ready as tripwires`,
    `  ${soon} live belief(s) carry an expiry watch (decay if unrefreshed)`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function normId(raw: string): string {
  let s = raw.replace(/[⟦⟧]/g, "").trim();
  if (!s.startsWith("e:")) s = "e:" + s.replace(/^e[-:]/, "");
  return s;
}

// git-style shortest-unique-prefix resolution for a partial id.
function resolvePrefix(store: Store, id: string): Belief | undefined {
  const hex = id.replace(/^e:/, "");
  const matches = store.all().filter((b) => b.id.replace(/^e:/, "").startsWith(hex));
  return matches.length === 1 ? matches[0] : undefined;
}

function resolveEvidence(traces: Trace[], e: Evidence): Trace[] {
  return traces.filter((tr) => tr.ref === e.ref || tr.subject === e.ref || (e.kind === "commit" && tr.subject === e.ref.slice(0, 7)));
}

function describeWatch(w: WatchClause): string {
  switch (w.kind) {
    case "blob": return `${w.target} changes on disk (content ≠ ${w.expect})`;
    case "symbol": { const { name, file } = splitSymbolTarget(w.target); return `${name} stops being defined in ${file}`; }
    case "path": return `${w.target} is deleted`;
    case "expire": return `the date passes ${w.target.slice(0, 10)}`;
  }
  return exhaustive(w.kind, w.kind); // corrupt kind renders as itself, never crashes `why`
}

function auditHint(e: Evidence, loc: Loc): string {
  if (e.kind === "commit") return `git -C ${loc.repo} show ${e.ref}`;
  if (e.kind === "file") return `open ${e.ref}`;
  if (e.kind === "session") return `session log entry ${e.ref}`;
  return e.ref;
}

function subjectsOfText(s: string): string[] {
  const out = new Set<string>();
  for (const m of s.matchAll(/\b[\w./-]+\.\w{1,5}\b/g)) out.add(m[0]);
  for (const m of s.matchAll(/\b[a-z][a-zA-Z0-9]+[A-Z][a-zA-Z0-9]*\b/g)) out.add(m[0]);
  return [...out].slice(0, 6);
}

function fmtMap(m: Map<string, number>): string {
  return [...m.entries()].sort().map(([k, v]) => `${k}=${v}`).join("  ") || "none";
}

// Write (or complete) a `.gitignore` INSIDE the store so `git add -- <store>` can never
// stage the local overlay, disposable cache, or transient lock/temp files (SEC-5). Only
// APPENDS the muster block if absent — a user's own edits are preserved.
const GITIGNORE_BLOCK = [
  "# muster: never share the local overlay, disposable cache, or transient locks/temps",
  "private/", "cache/", "lease.json", "lease.json.*",
  "*.tmp-*", "*.steal", "*.new.*", "*.release.*", "*.claimed.*",
].join("\n") + "\n";
function ensureStoreGitignore(loc: Loc): void {
  try {
    ensureDir(loc.store);
    const p = join(loc.store, ".gitignore");
    const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
    if (!cur.includes("private/")) writeFileSync(p, cur ? cur.replace(/\s*$/, "\n\n") + GITIGNORE_BLOCK : GITIGNORE_BLOCK, "utf8");
  } catch { /* best-effort; the push guard below is the hard stop */ }
}

// Write a `.gitattributes` INSIDE the store that turns OFF line-ending conversion for every
// store file. The store is a content-addressed, byte-reproducible record shared via git; a
// teammate on `core.autocrlf=true` (Windows' default) would otherwise rewrite LF→CRLF on
// checkout and every belief id would fail to recompute — a false tamper across the whole
// store. `-text` pins the bytes: what's committed is what's checked out, on any platform.
// Idempotent; a user's own attribute lines are preserved.
const GITATTRIBUTES_BLOCK =
  "# muster: the store is content-addressed and byte-reproducible. Disable line-ending\n" +
  "# conversion so committed bytes survive checkout on any platform (no CRLF corruption).\n" +
  "* -text\n";
function ensureStoreGitattributes(loc: Loc): void {
  try {
    ensureDir(loc.store);
    const p = join(loc.store, ".gitattributes");
    const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
    if (!cur.includes("* -text")) writeFileSync(p, cur ? cur.replace(/\s*$/, "\n\n") + GITATTRIBUTES_BLOCK : GITATTRIBUTES_BLOCK, "utf8");
  } catch { /* best-effort; a mangled store still round-trips thanks to the CRLF-tolerant parser */ }
}

// The store is plain text in a git repo — distribution is `git`, on infra you already
// have. This commits the store; with `push`, it also rebases and pushes if a remote
// is configured. Network operations are opt-in.
function gitCommitStore(loc: Loc, push: boolean): string {
  const run = (args: string[]): string => {
    try { return execFileSync("git", ["-C", loc.repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 120_000 }).trim(); }
    catch { return ""; }
  };
  const ok = (args: string[]): boolean => {
    try { execFileSync("git", ["-C", loc.repo, ...args], { stdio: "ignore", timeout: 10_000 }); return true; }
    catch { return false; }
  };
  if (!run(["rev-parse", "--is-inside-work-tree"])) return `git          (not a git repo; skipped)`;
  ensureStoreGitignore(loc);
  ensureStoreGitattributes(loc);
  // Hard stop: never commit/push while the private overlay is trackable. `check-ignore`
  // exits 0 iff the path is ignored; if it isn't, refuse rather than leak local beliefs.
  if (existsSync(privateLoc(loc).store) && !ok(["check-ignore", "-q", "--", privateLoc(loc).store])) {
    return `git          REFUSED — ${privateLoc(loc).store} is not gitignored; sharing it would leak private beliefs`;
  }
  run(["add", "--", loc.store]);
  const staged = run(["diff", "--cached", "--name-only", "--", loc.store]);
  if (!staged) return `git          nothing to commit — the store is current`;
  const n = staged.split("\n").filter(Boolean).length;
  run(["commit", "-m", `muster: sync memory (${new Date().toISOString().slice(0, 10)})`, "--", loc.store]);
  let line = `git          committed ${n} store file(s)`;
  if (push) {
    const remote = run(["remote"]);
    if (remote) { run(["pull", "--rebase"]); const p = run(["push"]); line += p === "" ? " · pushed" : ` · pushed (${p.slice(0, 40)})`; }
    else line += " · no remote to push to";
  }
  return line;
}
