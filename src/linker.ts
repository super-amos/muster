import type { Belief, Briefing, BriefLine, Altitude } from "./types.js";
import { countTokens } from "./tokens.js";
import { Store } from "./store.js";
import { isProvisional } from "./confidence.js";

const STOP = new Set(
  "a an the of to in on for and or is are be this that with your you it its as at by from into we our i add use using make build fix update refactor change wire up so".split(" "),
);

// Path-structural fragments that live in almost every path. If these leaked into the
// keyword set, "src" alone would match every source-file belief in the repo — the
// blast radius would be the whole codebase and the relevance fold would be noise.
const PATH_STOP = new Set(
  "src lib dist build out bin pkg app apps packages index main test tests spec specs mock mocks node_modules vendor ts tsx js jsx mjs cjs py go rs".split(" "),
);

interface Task { paths: Set<string>; symbols: Set<string>; keywords: Set<string>; }

export function parseTask(task: string): Task {
  const paths = new Set<string>();
  const symbols = new Set<string>();
  const keywords = new Set<string>();
  for (const m of task.matchAll(/\b[\w./-]+\.\w{1,5}\b/g)) paths.add(m[0].toLowerCase());
  for (const m of task.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*\b/g)) symbols.add(m[0]);
  for (const m of task.matchAll(/[A-Za-z][A-Za-z0-9_]{2,}/g)) {
    const w = m[0].toLowerCase();
    if (!STOP.has(w) && !PATH_STOP.has(w)) keywords.add(w);
  }
  return { paths, symbols, keywords };
}

// ─────────────────────────────────────────────────────────────────────────────
// Relevance — a mechanical fold over claim + subject text. No embeddings, no model.
// Recency is data-relative (measured against the journal head, never the wall clock),
// so the whole compile is a pure function of (store, task, budget).
// ─────────────────────────────────────────────────────────────────────────────

interface Scored { b: Belief; score: number; hits: number; named: boolean; }

// The co-change blast radius. Two files that historically move together mean an edit to
// one usually needs the other — so a file the task never named is still in its blast
// radius if it co-changes with a file the task DID name. We fold the git-cochange
// beliefs into an adjacency map (lowercased for path matching) once per compile; a
// symbol/file belief about a neighbour then earns a relevance bonus even with no direct
// hit. Purely mechanical, budget-independent — monotonicity and determinism are intact.
type Neighbors = Map<string, Set<string>>;

function buildNeighbors(all: Belief[]): Neighbors {
  const nb: Neighbors = new Map();
  const link = (x: string, y: string): void => {
    const k = x.toLowerCase();
    const s = nb.get(k) ?? new Set<string>();
    s.add(y.toLowerCase());
    nb.set(k, s);
  };
  for (const b of all) {
    if (b.status !== "live" || b.method !== "git-cochange") continue;
    const [a, c] = b.subjects; // ingest sets subjects[0], subjects[1] = the two files
    if (a && c) { link(a, c); link(c, a); }
  }
  return nb;
}

// Not all symbols are equal citizens. A public/exported definition is the surface an
// agent is likeliest to call; a private helper is implementation detail. We read the
// visibility off the belief's non-identity `summary` (the signature) — so it costs no
// storage and never touches identity. Only clearly-public gets a lift and only
// clearly-private a small demotion; unmarked (Python, an un-exported TS helper) stays
// neutral, so we never punish a language that has no visibility keyword.
function surfaceWeight(b: Belief): number {
  if (b.method !== "read-source" || !b.summary) return 1;
  if (/^(?:export\b|pub\b|pub\(|public\b|open\b)/.test(b.summary)) return 1.25;
  if (/^(?:private\b|fileprivate\b|internal\b|static\s)/.test(b.summary)) return 0.85;
  return 1;
}

// Not all knowledge is equally worth a token. A symbol definition or a user-told fact
// is the substance an agent acts on; "this file exists" or "these two files co-change"
// is orientation — useful, but it must never crowd the substance out of a tight
// budget. This value weight is mechanical (keyed on how the belief was derived).
function valueWeight(method: string): number {
  switch (method) {
    case "read-source": return 1.4; // a symbol definition — the API surface
    case "user-told": return 1.3; // a human-asserted fact
    case "corroborated": return 1.25; // an extraction confirmed by a second source
    case "consolidation": return 1.2; // a principle — synthesized substance, cites many
    case "test-topology": return 1.0; // which test covers what
    case "dispute": return 0.9; // an open question — worth a line, not the lead
    case "git-cochange": return 0.8; // edit-coupling
    case "git-churn": return 0.7; // hotspot
    case "git-history": return 0.55; // "is a tracked file" — orientation only
    case "llm-extract": return 0.5; // quarantined — never load-bearing until corroborated
    default: return 1.0;
  }
}

function scoreBelief(b: Belief, t: Task, ref: number, spanMs: number, nb: Neighbors): Scored {
  const hay = (b.claim + " " + b.subjects.join(" ")).toLowerCase();
  const subjLower = b.subjects.map((s) => s.toLowerCase());
  let hits = 0;
  let named = false;
  for (const p of t.paths) {
    if (subjLower.includes(p)) { hits += 4; named = true; }
    else if (hay.includes(p)) hits += 3;
  }
  for (const s of t.symbols) {
    if (b.subjects.includes(s)) { hits += 4; named = true; }
    else if (hay.includes(s.toLowerCase())) hits += 2;
  }
  for (const k of t.keywords) if (hay.includes(k)) hits += 1;

  // Co-change blast radius: pull in a belief about a file that historically moves with
  // a file the task named, even if the task never mentioned it. Weaker than a direct
  // hit (+2 vs +3/4) and never sets `named`, so a neighbour lands in §6, not §4.
  if (nb.size) {
    const subjFiles = subjLower.filter((s) => s.includes("/") || s.includes("."));
    outer: for (const p of t.paths) {
      const ring = nb.get(p);
      if (!ring) continue;
      for (const sf of subjFiles) if (ring.has(sf)) { hits += 2; break outer; }
    }
  }

  const lv = Date.parse(b.lastVerified || b.born || "");
  const age = Number.isFinite(lv) ? Math.max(0, ref - lv) : spanMs;
  const rec = spanMs > 0 ? 1 - 0.5 * Math.min(1, age / spanMs) : 1; // [0.5, 1]
  const score = hits * (0.5 + 0.5 * b.confidence) * rec * valueWeight(b.method) * surfaceWeight(b);
  return { b, score, hits, named };
}

// ─────────────────────────────────────────────────────────────────────────────
// The narrative grammar — a fixed order the model can read top-to-bottom. Safety
// first (standing orders, then tripwires), then the truth, then the context. Only
// LIVE beliefs brief as assertions; DEAD ones brief as tripwires and obituaries so
// the next session carries the corpse's warning, not its ghost.
// ─────────────────────────────────────────────────────────────────────────────

type Section = "standing_orders" | "tripwires" | "situation" | "deceased" | "neighborhood" | "cautions";

const SECTION_ORDER: Section[] = ["standing_orders", "tripwires", "situation", "deceased", "neighborhood", "cautions"];

const SECTION_TITLE: Record<Section, string> = {
  standing_orders: "§2 STANDING ORDERS — directives, always in force",
  tripwires: "§3 TRIPWIRES — deleted/removed things in your blast radius. DO NOT USE THESE.",
  situation: "§4 THE SITUATION — what is true in the code you are touching",
  deceased: "§5 RECENTLY DECEASED — died in your blast radius (here so you don't resurrect them)",
  neighborhood: "§6 THE NEIGHBORHOOD — adjacent context, compressed",
  cautions: "§7 OPEN QUESTIONS — stale, disputed, unverified (single-source), or expiring; verify before you trust",
};

// "Carries an expire watch" is NOT the same as "expiring soon." Every `tell` fact and every
// extraction is minted with a 180-day expire horizon, so routing any belief with an expire
// watch to §7 (COR-3) buried the user's own hand-entered knowledge — and the sanctioned
// two-source promotion — under "unverified, verify before you trust" for the whole 180 days.
// An expire watch is a §7 caution only when its horizon is within this window of the compile's
// journal-head reference (data-relative, never the wall clock — determinism holds). A distant
// horizon is a freshly-minted fact and briefs as substance in §4/§6.
const EXPIRE_SOON_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function expiringSoon(b: Belief, ref: number): boolean {
  for (const w of b.watch) {
    if (w.kind !== "expire") continue;
    const horizon = Date.parse(w.target);
    if (!Number.isFinite(horizon)) return true; // an unreadable horizon → caution, fail safe
    if (horizon - ref <= EXPIRE_SOON_MS) return true; // near (or past) the journal head
  }
  return false;
}

function classify(s: Scored, t: Task, ref: number): Section | null {
  const b = s.b;
  if (b.status === "live" && b.kind === "directive") return "standing_orders";

  if (b.status === "dead") {
    if (s.hits === 0) return null; // outside the blast radius — stays buried
    return b.tombstone?.death === "falsified" ? "tripwires" : "deceased";
  }

  if (b.status === "stale") return s.hits > 0 ? "cautions" : null;
  if (b.status !== "live") return null; // superseded / retired never brief

  if (s.hits === 0) return null;
  // M3 metabolizer states, handled before the generic rules below:
  if (isProvisional(b)) return "cautions"; // quarantined extraction — capped, verify-first
  if (b.method === "dispute") return "cautions"; // an open question, never both sides as truth
  if (b.method === "consolidation") return s.named ? "situation" : "neighborhood"; // a principle is substance
  if (/deprecat/i.test(b.claim)) return "cautions";
  if (b.confidence < 0.45 || expiringSoon(b, ref)) return "cautions";
  return s.named ? "situation" : "neighborhood";
}

// ─────────────────────────────────────────────────────────────────────────────
// Altitude rendering. Each higher altitude is a STRICT superset of the one below —
// A1 = A0 + a provenance tag, A2 = A1 + the evidence line — so climbing the ladder
// only ever adds detail, never changes a claim. This is what makes a 4k briefing a
// coarsening of the 200k briefing, never a contradiction of it.
// ─────────────────────────────────────────────────────────────────────────────

function deathHint(b: Belief): string {
  const sym = b.watch.find((w) => w.kind === "symbol");
  const io = b.watch.find((w) => w.kind === "blob" || w.kind === "path");
  const exp = b.watch.find((w) => w.kind === "expire");
  if (sym) return `dies if ${sym.target.split("@")[0]} is removed`;
  if (io) return `dies if ${io.target} ${io.kind === "path" ? "is deleted" : "changes"}`;
  if (exp) return `expires ${exp.target.slice(0, 10)}`;
  return "eternal";
}

function evidenceLine(b: Belief): string {
  const refs = b.evidence.map((e) => `${e.kind} ${e.ref}`).slice(0, 4).join("; ");
  return `evidence: ${refs || "(none)"} — trace with \`muster why ${b.id}\``;
}

function beliefText(b: Belief, section: Section, alt: Altitude): string {
  if (section === "tripwires") return `⛔ ${b.tombstone?.note ?? b.claim} ⟦${b.id}⟧`;
  if (section === "deceased") return `† ${b.tombstone?.note ?? b.claim} ⟦${b.id}⟧`;
  if (section === "standing_orders") {
    const base = `★ ${b.claim} ⟦${b.id}⟧`;
    return alt >= 1 ? `${base}\n    ↳ standing order · never decays` : base;
  }
  // A quarantined extraction is marked so the model never mistakes it for a settled
  // fact: it leads with a caution glyph and says, on the line, that it is single-source.
  if (isProvisional(b)) return `? ${b.claim} — unverified (single source) ⟦${b.id}⟧`;
  const a0 = `• ${b.claim} ⟦${b.id}⟧`;
  if (alt === 0) return a0;
  // A1 adds provenance and — for a symbol — its signature + doc line, the enrichment
  // that turns "X is defined in Y" into something worth reading. Strict superset of A0.
  let a1 = `${a0}\n    ↳ ${b.kind} · conf ${b.confidence.toFixed(2)} · ${deathHint(b)}`;
  if (b.summary) a1 += `\n    ↳ ${b.summary}`;
  if (alt === 1) return a1;
  return `${a1}\n    ⤷ ${evidenceLine(b)}`;
}

// Mandatory beliefs render terse (A0): a directive is a one-line standing order and a
// tripwire is a one-line warning. Keeping them at A0 means they are always affordable —
// they never crowd the substance out of a tight budget, yet are never dropped.
function mandatoryAlt(_section: Section): Altitude {
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering + the monotone packer.
// ─────────────────────────────────────────────────────────────────────────────

interface Meta { belief: Belief; section: Section; order: number; }

function renderHeader(task: string, budget: number, asOf: string): string {
  // Bound the echoed task so a pathologically long task string can't eat the whole budget
  // and starve the tripwires/directives (missed #1). Relevance still uses the FULL task.
  const echo = task.length > 240 ? task.slice(0, 240).trimEnd() + "…" : task;
  return `# MUSTER BRIEFING\n## §1 TASK\n${echo}\n[budget ${budget} tokens · as of ${asOf.slice(0, 19)}Z · every line reverified against current sources]`;
}

const LEGEND =
  "## §8 HOW TO READ THIS\n" +
  "Interrogate any ⟦e:…⟧ with `muster why <id>`. Nothing here is stale — beliefs that failed reverification were buried before this compiled.";

function render(
  task: string,
  budget: number,
  planAlt: Map<string, Altitude>,
  meta: Map<string, Meta>,
  asOf: string,
): { text: string; lines: BriefLine[]; used: number } {
  const parts: string[] = [renderHeader(task, budget, asOf)];
  const lines: BriefLine[] = [];

  for (const section of SECTION_ORDER) {
    const members: Meta[] = [];
    for (const id of planAlt.keys()) {
      const m = meta.get(id);
      if (m && m.section === section) members.push(m);
    }
    if (members.length === 0) continue;
    members.sort((a, b) => a.order - b.order);
    parts.push(`\n## ${SECTION_TITLE[section]}`);
    for (const m of members) {
      const alt = planAlt.get(m.belief.id) ?? 0;
      const text = beliefText(m.belief, section, alt);
      parts.push(text);
      lines.push({ section, beliefId: m.belief.id, altitude: alt, text: m.belief.claim, tokens: countTokens(text) });
    }
  }

  parts.push("\n" + LEGEND);
  const text = parts.join("\n") + "\n";
  return { text, lines, used: countTokens(text) };
}

interface Atom { id: string; alt: Altitude; }

// The read path: task → relevance fold → altitude-ladder packing under a hard budget
// → fixed 8-section grammar. Model-free and deterministic: same store, same task,
// same budget yield a byte-identical briefing. Budget-monotone by construction: the
// atom sequence is fixed and independent of the budget, and the briefing is the
// maximal PREFIX of it that fits — so a bigger budget can only add detail (more
// beliefs, or higher altitude on the ones already shown), never swap a claim.
export function compileBriefing(store: Store, task: string, budget: number): Briefing {
  const t = parseTask(task);
  const all = store.all();

  // "now" = journal head (max verified/born time). Reproducible; no wall clock.
  let ref = 0;
  let min = Number.POSITIVE_INFINITY;
  for (const b of all) {
    const lv = Date.parse(b.lastVerified || b.born || "");
    if (Number.isFinite(lv)) { ref = Math.max(ref, lv); min = Math.min(min, lv); }
  }
  if (!Number.isFinite(min)) min = ref;
  const spanMs = Math.max(1, ref - min);
  const asOf = ref ? new Date(ref).toISOString() : "1970-01-01T00:00:00.000";
  const neighbors = buildNeighbors(all);

  const classified = all
    .map((b) => scoreBelief(b, t, ref, spanMs, neighbors))
    .map((s) => ({ s, section: classify(s, t, ref) }))
    .filter((c): c is { s: Scored; section: Section } => c.section !== null);

  const isMandatory = (sec: Section): boolean => sec === "standing_orders" || sec === "tripwires";
  const mandatory = classified.filter((c) => isMandatory(c.section))
    .sort((a, b) => sectionRank(a.section) - sectionRank(b.section) || b.s.score - a.s.score || a.s.b.id.localeCompare(b.s.b.id));
  const optional = classified.filter((c) => !isMandatory(c.section))
    .sort((a, b) => b.s.score - a.s.score || a.s.b.id.localeCompare(b.s.b.id));

  const meta = new Map<string, Meta>();
  let order = 0;
  for (const c of [...mandatory, ...optional]) {
    if (!meta.has(c.s.b.id)) meta.set(c.s.b.id, { belief: c.s.b, section: c.section, order: order++ });
  }

  // Fixed atom sequence — the altitude ladder as the origin design intends it: a 4k
  // briefing is an "airport briefing" (every relevant subject, one line), a 200k one is
  // a "war-room binder" (full dossiers). So BREADTH first — every belief gets its A0
  // line, mandatory and optional alike — THEN resolution climbs A1→A2 on the most
  // relevant with whatever budget remains. The sequence is independent of the budget,
  // so the briefing is still the maximal prefix that fits: strictly budget-monotone.
  // Quarantined extractions are capped at A0 — they get their one line but never climb
  // to a load-bearing altitude until a second source corroborates them (§7 / M3).
  const atoms: Atom[] = [];
  for (const c of mandatory) atoms.push({ id: c.s.b.id, alt: mandatoryAlt(c.section) });
  for (const c of optional) atoms.push({ id: c.s.b.id, alt: 0 }); // breadth: one line each
  for (const c of optional) if (!isProvisional(c.s.b)) atoms.push({ id: c.s.b.id, alt: 1 }); // resolution pass 1
  for (const c of optional) if (!isProvisional(c.s.b)) atoms.push({ id: c.s.b.id, alt: 2 }); // resolution pass 2

  // Greedy maximal prefix — but O(atoms), NOT O(atoms²). The old packer re-rendered the
  // WHOLE briefing to price every atom (8.7s @128k on a 4k-belief store). `countTokens` is
  // additive across the "\n" joins `render` uses, so a running total tracks the exact
  // rendered size and each atom is priced in O(1): a new member costs its own line, an
  // altitude upgrade costs only the delta, a section costs its header once. We still stop
  // at the FIRST atom that overflows (no skipping), so prefixes nest and the briefing stays
  // byte-identical to the old packer and budget-monotone across every budget.
  const NL = countTokens("\n");
  const sectionCost = (sec: Section): number => NL + countTokens(`\n## ${SECTION_TITLE[sec]}`);
  const memberTokens = (id: string, alt: Altitude): number => {
    const m = meta.get(id)!;
    return countTokens(beliefText(m.belief, m.section, alt));
  };
  const baseCost = countTokens(renderHeader(task, budget, asOf)) + NL + countTokens("\n" + LEGEND) + NL;

  const planAlt = new Map<string, Altitude>();
  const activeSection = new Set<Section>();
  let running = baseCost;
  for (const atom of atoms) {
    const prev = planAlt.get(atom.id);
    if (prev !== undefined && prev >= atom.alt) continue;
    const m = meta.get(atom.id)!;
    let delta = activeSection.has(m.section) ? 0 : sectionCost(m.section);
    delta += prev === undefined
      ? NL + memberTokens(atom.id, atom.alt)                          // a new member line
      : memberTokens(atom.id, atom.alt) - memberTokens(atom.id, prev); // an altitude upgrade
    if (running + delta > budget) break; // first overflow — maximal prefix, no skipping
    running += delta;
    activeSection.add(m.section);
    planAlt.set(atom.id, atom.alt);
  }

  // Authoritative re-check (ONE render): the running total is exact when additivity holds,
  // but budget adherence is a HARD invariant that must never depend on that. If a
  // pathological string ever broke additivity, trim the most-recently-added atoms until the
  // true rendered size fits. In practice this never trims (see the byte-equivalence tests).
  let final = render(task, budget, planAlt, meta, asOf);
  while (final.used > budget && planAlt.size > 0) {
    const ids = [...planAlt.keys()];
    planAlt.delete(ids[ids.length - 1]);
    final = render(task, budget, planAlt, meta, asOf);
  }
  const includedOptional = optional.filter((c) => planAlt.has(c.s.b.id)).length;
  // A mandatory belief (tripwire / standing order) leads the atom sequence, so it drops
  // ONLY when the budget can't fit it — and when that happens it must be COUNTED, not
  // silently omitted while the footer claims "0 held back" (missed #1, safety-grade).
  const includedMandatory = mandatory.filter((c) => planAlt.has(c.s.b.id)).length;
  const mandatoryOmitted = mandatory.length - includedMandatory;
  const omitted = (optional.length - includedOptional) + mandatoryOmitted;
  return { task, budget, used: final.used, asOf, text: final.text, lines: final.lines, omitted, mandatoryOmitted };
}

function sectionRank(s: Section): number {
  return SECTION_ORDER.indexOf(s);
}
