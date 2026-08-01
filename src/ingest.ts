import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, extname, dirname, basename } from "node:path";
import type { Loc } from "./paths.js";
import type { Belief, Evidence, WatchClause } from "./types.js";
import { beliefId, contentHash } from "./id.js";
import { Store } from "./store.js";
import { appendTrace, makeTrace } from "./journal.js";
import { lintBelief } from "./lint.js";
import { redact, INJECTION } from "./redact.js";
import { extractSymbols } from "./symbols.js";
import { clamp01 } from "./num.js";
import { addDays } from "./dates.js";

// Ingest is an attacker-authorable surface, so it is bounded (SEC-4): never read an
// unbounded log into memory, and never mint an unbounded number of beliefs from one run.
const MAX_LOG_BYTES = 64 * 1024 * 1024; // read at most this much of a session log
const MAX_LOG_EVENTS = 10_000; // mint from at most this many events per ingest

// Read at most `maxBytes` of a file — a giant log is truncated at a UTF-8-safe-ish boundary
// rather than pulled whole into memory. Returns the text and whether it was truncated.
function readCapped(path: string, maxBytes: number): { text: string; truncated: boolean } {
  const size = statSync(path).size;
  if (size <= maxBytes) return { text: readFileSync(path, "utf8"), truncated: false };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return { text: buf.subarray(0, n).toString("utf8"), truncated: true };
  } finally { closeSync(fd); }
}

// Re-exported so `ingest.ts` stays the public home of extraction (see index.ts).
export { extractSymbols } from "./symbols.js";

const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
  ".java", ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".cs", ".swift", ".kt",
]);

function isSource(rel: string): boolean {
  return SOURCE_EXT.has(extname(rel));
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000, // a hung git never wedges an ingest (ERR-1)
  });
}

export interface IngestOptions {
  repo: string;
  maxCommits: number;
  pathPrefix: string; // limit to a subtree; "" = whole repo
  maxSymbolsPerFile: number;
  redact?: boolean; // default true
}

export interface IngestReport {
  commits: number;
  files: number;
  symbols: number;
  cochange: number;
  hotspots: number;
  tests: number;
  minted: number;
  rejected: number; // beliefs the constitution refused
  secretsRedacted: number; // exhaust spans that carried a secret
  cappedFiles: string[];
}

// Mechanical git bootstrap — zero LLM. Turns a repo's history and current tree into
// mortal beliefs. Five mechanical belief families, each with real death conditions:
//   • file     — a tracked source file (dies when deleted; re-fingerprints on change)
//   • symbol   — a top-level definition (dies when removed)  ← the scar-killer
//   • co-change— two files that historically move together (dies if either is deleted)
//   • hotspot  — a high-churn file where change is risky (dies if deleted, or expires)
//   • test     — a test file and the source it covers (dies if either is deleted)
export function ingestGit(store: Store, opts: IngestOptions): IngestReport {
  const { repo } = opts;
  const loc = store.loc;
  const doRedact = opts.redact !== false;
  const report: IngestReport = {
    commits: 0, files: 0, symbols: 0, cochange: 0, hotspots: 0, tests: 0,
    minted: 0, rejected: 0, secretsRedacted: 0, cappedFiles: [],
  };
  const rd = (s: string): string => {
    if (!doRedact) return s;
    const r = redact(s);
    if (r !== s) report.secretsRedacted++;
    return r;
  };

  // --- commits -> traces (the record of what happened) ---
  const log = git(repo, ["log", "-n", String(opts.maxCommits), "--pretty=format:%H%x1f%an%x1f%aI%x1f%s"]);
  let headSha = "";
  let headIso = "";
  for (const line of log.split("\n")) {
    if (!line.trim()) continue;
    const [sha, author, iso, subject] = line.split("\x1f");
    if (!sha) continue;
    if (!headSha) { headSha = sha; headIso = iso || ""; }
    report.commits++;
    appendTrace(loc, makeTrace("commit", { actor: author || "?", subject: sha.slice(0, 7), ref: iso || "", note: rd(subject || "") }));
  }
  const nowIso = headIso || new Date().toISOString();
  const horizon = addDays(nowIso, 120); // perishable statistics carry a horizon

  // --- one pass over history: per-file tallies + per-commit file groups ---
  const touches = new Map<string, number>();
  const lastTouch = new Map<string, string>();
  const pairCount = new Map<string, number>();
  const nameLog = git(repo, ["log", "-n", String(opts.maxCommits), "--name-only", "--pretty=format:%x02%aI"]);
  let curDate = "";
  let group: string[] = [];
  const flush = (): void => {
    const src = group.filter((f) => isSource(f) && inScope(f, opts.pathPrefix));
    if (src.length >= 2 && src.length <= 40) {
      // Skip merge/mega-commits (>40 files): they inflate co-change noise.
      const sorted = [...new Set(src)].sort();
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const key = sorted[i] + "\x00" + sorted[j];
          pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
        }
      }
    }
    group = [];
  };
  for (const line of nameLog.split("\n")) {
    if (line.startsWith("\x02")) { flush(); curDate = line.slice(1); continue; }
    const f = line.trim();
    if (!f) continue;
    touches.set(f, (touches.get(f) ?? 0) + 1);
    if (!lastTouch.has(f)) lastTouch.set(f, curDate); // first seen (top-down) = most recent
    group.push(f);
  }
  flush();

  // --- tracked files -> file beliefs + symbol beliefs ---
  const tracked = git(repo, ["ls-files"]).split("\n").map((s) => s.trim()).filter(Boolean);
  const trackedSet = new Set(tracked);
  for (const rel of tracked) {
    if (!inScope(rel, opts.pathPrefix)) continue;
    if (!isSource(rel)) continue;
    const abs = join(repo, rel);
    if (!existsSync(abs)) continue;
    let content = "";
    try { content = readFileSync(abs, "utf8"); } catch { continue; }

    const hash = contentHash(content);
    const n = touches.get(rel) ?? 1;
    const last = lastTouch.get(rel) || nowIso;
    report.files++;

    // File belief — the claim is STABLE (volatile counts live in the evidence note,
    // which is excluded from identity), so re-sync is idempotent.
    mint(store, report, loc, "file-seen", {
      claim: `\`${rel}\` is a tracked source file in this repository.`,
      kind: "observed",
      subjects: [rel, dirname(rel)],
      confidence: clamp01(0.5 + Math.min(0.4, n / 50)),
      method: "git-history",
      watch: [{ kind: "blob", target: rel, expect: hash }],
      evidence: [{ kind: "file", ref: rel, note: `${n} commit(s), last ${last.slice(0, 10)}, blob ${hash}` }],
      origin: "ingest:git",
      born: last,
      lastVerified: nowIso,
    });

    // Symbol beliefs — the scar-killers. Language-aware extraction; the signature and
    // first doc line ride along as NON-identity enrichment (see `summary`).
    let count = 0;
    for (const s of extractSymbols(content, extname(rel))) {
      if (count >= opts.maxSymbolsPerFile) { report.cappedFiles.push(rel); break; }
      count++;
      report.symbols++;
      mint(store, report, loc, "symbol-seen", {
        claim: `\`${s.name}\` (${s.kind}) is defined in \`${rel}\`.`,
        kind: "observed",
        subjects: [rel, s.name],
        confidence: 0.8,
        method: "read-source",
        watch: [{ kind: "symbol", target: `${s.name}@${rel}`, expect: "present" }],
        evidence: [{ kind: "file", ref: rel, note: `line ${s.line}` }],
        origin: "ingest:git",
        born: last,
        lastVerified: nowIso,
        summary: summaryOf(s.signature, s.doc, rd),
      });
    }
  }

  // --- churn hotspots: where change is historically concentrated (and risky) ---
  const ranked = [...touches.entries()]
    .filter(([f]) => isSource(f) && inScope(f, opts.pathPrefix) && trackedSet.has(f))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const hotThreshold = Math.max(5, ranked.length ? ranked[0][1] * 0.4 : 5);
  for (const [f, cnt] of ranked.slice(0, 25)) {
    if (cnt < hotThreshold) break;
    report.hotspots++;
    mint(store, report, loc, "hotspot", {
      claim: `\`${f}\` is a churn hotspot (${cnt} commits) — changes here touch a lot and merit extra care.`,
      kind: "inferred",
      subjects: [f, dirname(f)],
      confidence: clamp01(0.55 + Math.min(0.35, cnt / 100)),
      method: "git-churn",
      watch: [{ kind: "path", target: f, expect: "present" }, { kind: "expire", target: horizon, expect: "" }],
      evidence: [{ kind: "file", ref: f, note: `${cnt} commits in last ${opts.maxCommits}` }],
      origin: "ingest:git",
      born: lastTouch.get(f) || nowIso,
      lastVerified: nowIso,
    });
  }

  // --- co-change: files that historically move together ---
  const pairs = [...pairCount.entries()]
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 60);
  for (const [key, cnt] of pairs) {
    const [a, b] = key.split("\x00");
    if (!a || !b || !trackedSet.has(a) || !trackedSet.has(b)) continue;
    report.cochange++;
    mint(store, report, loc, "cochange", {
      claim: `\`${a}\` and \`${b}\` change together — edits to one usually need the other (${cnt}×).`,
      kind: "inferred",
      subjects: [a, b, dirname(a), dirname(b)],
      confidence: clamp01(0.4 + Math.min(0.4, cnt / 20)),
      method: "git-cochange",
      watch: [{ kind: "path", target: a, expect: "present" }, { kind: "path", target: b, expect: "present" }, { kind: "expire", target: horizon, expect: "" }],
      evidence: [{ kind: "file", ref: a, note: `co-changed with ${b} ${cnt}×` }, { kind: "file", ref: b, note: `co-changed with ${a} ${cnt}×` }],
      origin: "ingest:git",
      born: nowIso,
      lastVerified: nowIso,
    });
  }

  // --- test topology: a test file and the source it most likely covers ---
  for (const rel of tracked) {
    if (!inScope(rel, opts.pathPrefix) || !isSource(rel)) continue;
    const covered = coveredSource(rel, trackedSet);
    if (!covered) continue;
    report.tests++;
    mint(store, report, loc, "test-topology", {
      claim: `\`${rel}\` is a test that exercises \`${covered}\`.`,
      kind: "inferred",
      subjects: [rel, covered, "tests"],
      confidence: 0.65,
      method: "test-topology",
      watch: [{ kind: "path", target: rel, expect: "present" }, { kind: "path", target: covered, expect: "present" }],
      evidence: [{ kind: "file", ref: rel, note: `covers ${covered} (name match)` }],
      origin: "ingest:git",
      born: lastTouch.get(rel) || nowIso,
      lastVerified: nowIso,
    });
  }

  return report;
}

function inScope(rel: string, prefix: string): boolean {
  return !prefix || rel.startsWith(prefix);
}

// A test file by name convention (a marker in the basename, or a tests/ ancestor dir).
function isTestPath(rel: string): boolean {
  const base = basename(rel);
  return /(\.test\.|\.spec\.|_test\.|_spec\.)/.test(base) || /^test_/.test(base) || /(^|\/)(__tests__|tests?)(\/|$)/.test(rel);
}

// Map a test file to the source it covers by name convention:
//   foo.test.ts / foo.spec.ts -> foo.ts ; test_foo.py -> foo.py ; foo_test.go -> foo.go
function coveredSource(rel: string, tracked: Set<string>): string | null {
  const base = basename(rel);
  const dir = dirname(rel);
  if (!isTestPath(rel)) return null;
  const stems: string[] = [];
  const m = base.match(/^(.*?)(?:\.test|\.spec|_test|_spec)?(\.[^.]+)$/);
  if (m && m[1] && m[2]) stems.push(m[1].replace(/^test_/, "") + m[2]);
  const bare = base.replace(/^test_/, "").replace(/(\.test|\.spec|_test|_spec)(\.[^.]+)$/, "$2");
  if (bare !== base) stems.push(bare);
  for (const cand of stems) {
    // Try the same dir, a sibling src/ dir, and a parent dir.
    for (const d of [dir, dir.replace(/(^|\/)(__tests__|tests?)(\/|$)/, "$1"), dirname(dir), dir.replace(/tests?$/, "src")]) {
      const p = join(d, cand).replace(/\\/g, "/").replace(/^\.\//, "");
      if (p !== rel && tracked.has(p)) return p;
    }
  }
  // Fallback for a flat tests/ dir over a nested src/ tree, where no directory transform
  // lands on the source (e.g. `tests/arbiter.test.ts` → `src/engine/arbiter.ts`). Match by
  // basename across ALL tracked NON-test sources — but ONLY when the match is UNIQUE, so an
  // ambiguous stem (two `arbiter.ts` in the tree) is left unlinked rather than mis-attributed.
  const candBases = new Set(stems.map((s) => basename(s)));
  let hit: string | null = null;
  for (const f of tracked) {
    if (f === rel || !isSource(f) || isTestPath(f) || !candBases.has(basename(f))) continue;
    if (hit) return null; // ambiguous — a name that maps to two sources tells us nothing
    hit = f;
  }
  return hit;
}

interface DraftBelief {
  claim: string; kind: Belief["kind"]; subjects: string[]; confidence: number;
  method: string; watch: WatchClause[]; evidence: Evidence[]; origin: string;
  born: string; lastVerified: string; summary?: string;
}

function mint(store: Store, report: IngestReport, loc: Loc, traceKind: string, d: DraftBelief): void {
  const id = beliefId(d.claim, d.evidence);
  const belief: Belief = {
    id, kind: d.kind, status: "live", claim: d.claim, subjects: d.subjects,
    confidence: d.confidence, method: d.method, watch: d.watch, evidence: d.evidence,
    lineage: [], origin: d.origin, born: d.born, lastVerified: d.lastVerified, supersededBy: "",
    ...(d.summary ? { summary: d.summary } : {}),
  };
  // The constitution runs at the write boundary: a rumor never reaches the store.
  if (lintBelief(belief).length) { report.rejected++; return; }
  const before = store.has(id);
  store.mint(belief);
  if (!before) {
    report.minted++;
    appendTrace(loc, makeTrace(traceKind, { actor: d.origin, subject: id, ref: d.subjects[0] || "", note: d.claim.slice(0, 80) }));
  }
}

// Build a symbol belief's enrichment: its signature, plus the first line of its doc
// comment when present. Redacted at the boundary (a comment can leak a secret or URL)
// and length-capped so it never dominates a briefing. Empty ⇒ no summary is stored.
function summaryOf(signature: string, doc: string, rd: (s: string) => string): string | undefined {
  const sig = rd(signature).trim();
  const d = rd(doc).trim();
  const text = d ? (sig ? `${sig} — ${d}` : d) : sig;
  const clipped = text.replace(/\s+/g, " ").slice(0, 200).trim();
  return clipped.length >= 3 ? clipped : undefined;
}

export interface AgentLogReport { events: number; directives: number /* always 0: a log never mints directives (SEC-2) */; minted: number; rejected: number; secretsRedacted: number; }

// Ingest an agent-session log (jsonl). Each line: { role|type, text|content, ts? }.
// Mechanical, no LLM: every event becomes a trace; factual user statements become "told"
// beliefs (which carry an expiry watch, so unverified hearsay ages out). Imperatives are
// REFUSED, not minted (SEC-2): a transcript is attacker-authorable, and a scraped imperative
// would otherwise become an eternal, briefed-first directive — a standing order can only be
// authored deliberately via `tell --directive`. All text is redacted at the boundary.
// Coarse on purpose: richer extraction is fenced-LLM work (M3).
export function ingestAgentLog(store: Store, logPath: string, sessionId: string, doRedact = true): AgentLogReport {
  const rep: AgentLogReport = { events: 0, directives: 0, minted: 0, rejected: 0, secretsRedacted: 0 };
  if (!existsSync(logPath)) return rep;
  const { text: raw } = readCapped(logPath, MAX_LOG_BYTES);
  const rd = (s: string): string => {
    if (!doRedact) return s;
    const r = redact(s);
    if (r !== s) rep.secretsRedacted++;
    return r;
  };
  let idx = 0;
  for (const line of raw.split("\n")) {
    if (rep.events >= MAX_LOG_EVENTS) break; // DoS cap: never mint an unbounded set from one log
    const s = line.trim();
    if (!s) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(s) as Record<string, unknown>; } catch { continue; }
    idx++;
    rep.events++;
    const role = String(ev.role ?? ev.type ?? "");
    const rawText = String(ev.text ?? ev.content ?? ev.message ?? "").trim();
    const text = rd(rawText);
    const ts = String(ev.ts ?? ev.timestamp ?? "");
    if (!text) continue;
    appendTrace(store.loc, makeTrace("session", { actor: role || "session", subject: sessionId, ref: `${sessionId}#${idx}`, note: text.slice(0, 120) }));
    if (role !== "user") continue;
    for (const utt of splitSentences(text)) {
      // A session transcript is attacker-authorable. BOTH an injection-shaped phrasing and
      // a plain imperative are refused here — exactly as the fenced/`learn` boundary refuses
      // them (extract.ts `buildCandidate`). A scraped imperative would otherwise mint an
      // ETERNAL, confidence-1 directive briefed FIRST (SEC-2); the only way to author a
      // standing order is the deliberate `tell --directive`, never a log line.
      if (INJECTION.test(utt) || isImperative(utt)) { rep.rejected++; continue; }
      if (!isFactual(utt)) continue;
      const evidence: Evidence[] = [{ kind: "session", ref: `${sessionId}#${idx}`, note: ts }];
      const id = beliefId(utt, evidence);
      const before = store.has(id);
      const born = ts || new Date().toISOString();
      const belief: Belief = {
        id, kind: "told", status: "live", claim: utt,
        subjects: subjectsOf(utt), confidence: 0.7, method: "user-told",
        watch: [{ kind: "expire", target: addDays(born, 180), expect: "" }],
        evidence, lineage: [], origin: `user:${sessionId}`, born, lastVerified: born, supersededBy: "",
      };
      if (lintBelief(belief).length) { rep.rejected++; continue; }
      store.mint(belief);
      if (!before) rep.minted++;
    }
  }
  return rep;
}

function splitSentences(t: string): string[] {
  return t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 8);
}

const IMPERATIVE = /\b(always|never|don'?t|do not|must not|must|prefer|avoid|make sure|ensure)\b/i;
function isImperative(s: string): boolean { return s.length < 200 && IMPERATIVE.test(s); }

const FACTUAL = /\b(is|are|uses?|lives? in|handled|located|we use|our )\b/i;
function isFactual(s: string): boolean { return s.length < 200 && FACTUAL.test(s); }

function subjectsOf(s: string): string[] {
  const out = new Set<string>();
  for (const m of s.matchAll(/\b[\w./-]+\.\w{1,5}\b/g)) out.add(m[0]);
  for (const m of s.matchAll(/\b[a-z][a-zA-Z0-9]+[A-Z][a-zA-Z0-9]*\b/g)) out.add(m[0]);
  return [...out].slice(0, 6);
}

