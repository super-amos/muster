import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Loc } from "./paths.js";
import { beliefsDir, ensureDir, atomicWrite } from "./paths.js";
import { idToFile } from "./id.js";
import { serializeBelief, parseBelief } from "./frontmatter.js";
import type { Belief, Evidence } from "./types.js";

export class Store {
  private byId = new Map<string, Belief>();
  // Belief files that failed to load (throw or no id) — a truncated/corrupt `.md`. Kept
  // so `verify` can SURFACE the corruption as fatal instead of silently folding a lower
  // count and reporting "intact" (missed bug #3).
  loadErrors: { file: string; detail: string }[] = [];
  constructor(public loc: Loc) {}

  static open(loc: Loc): Store {
    const s = new Store(loc);
    s.load();
    return s;
  }

  // In-memory store for tests / read-only compilation (no disk).
  static fromBeliefs(loc: Loc, beliefs: Belief[]): Store {
    const s = new Store(loc);
    for (const b of beliefs) s.byId.set(b.id, b);
    return s;
  }

  // The team ⊕ private overlay (PLAN §M4). A read-only store where a local private
  // belief mounts OVER the shared team belief of the same id — the agent gets their
  // overrides and local-only notes without the team memory ever seeing them. Used by
  // the read verbs (brief/why); writes still go to whichever concrete store the writer
  // chose (`tell --private` → private, everything else → team). Team-only when no
  // private layer exists on disk, so single-store behaviour is unchanged.
  static mergedRead(team: Loc, priv: Loc): Store {
    const t = Store.open(team);
    if (!existsSync(beliefsDir(priv))) return t;
    const merged = new Map<string, Belief>();
    for (const b of t.all()) merged.set(b.id, b);
    for (const b of Store.open(priv).all()) merged.set(b.id, b); // private wins on collision
    return Store.fromBeliefs(team, [...merged.values()]);
  }

  load(): void {
    this.byId.clear();
    this.loadErrors = [];
    const dir = beliefsDir(this.loc);
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const b = parseBelief(readFileSync(join(dir, f), "utf8"));
        if (b.id) this.byId.set(b.id, b);
        else this.loadErrors.push({ file: f, detail: "no id — truncated or malformed frontmatter" });
      } catch (e) {
        // A corrupt belief file is recorded, not swallowed: `verify` reports it fatally.
        this.loadErrors.push({ file: f, detail: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  all(): Belief[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  get(id: string): Belief | undefined { return this.byId.get(id); }
  has(id: string): boolean { return this.byId.has(id); }
  count(): number { return this.byId.size; }

  // mint — idempotent by id: minting the same belief twice merges evidence and keeps
  // the freshest verification, reviving a stale belief if reality now agrees again.
  // Returns the merged result (which may differ from the input). Use this to observe
  // a belief; use `persist` to write back a state change to one already merged.
  mint(b: Belief): Belief {
    const existing = this.byId.get(b.id);
    const merged = existing ? mergeBelief(existing, b) : b;
    this.byId.set(merged.id, merged);
    ensureDir(beliefsDir(this.loc));
    atomicWrite(join(beliefsDir(this.loc), idToFile(merged.id)), serializeBelief(merged));
    return merged;
  }

  // persist — write a state change (status, lineage, tombstone) to an existing belief
  // verbatim, with no merge. The caller owns the object's final shape.
  persist(b: Belief): void {
    this.byId.set(b.id, b);
    ensureDir(beliefsDir(this.loc));
    atomicWrite(join(beliefsDir(this.loc), idToFile(b.id)), serializeBelief(b));
  }
}

// A belief that reached one of these states was adjudicated by metabolism or the user;
// re-observing the same content must NOT resurrect it (COR-1). Otherwise a plain `sync`,
// which re-mints live symbol beliefs, would silently undo a metabolize: reviving a
// superseded belief alongside its replacement, or a consolidated member alongside its
// principle — erasing the forwarding address and double-counting the live set.
function isTerminal(b: Belief): boolean {
  return b.status === "superseded"
    || b.status === "retired"
    || b.tombstone?.death === "executed"    // `muster deny` — the user is the highest court
    || b.tombstone?.death === "superseded"  // lost a reconciliation (MET-3 stamps this)
    || b.tombstone?.death === "consolidated"; // absorbed into a principle
}

function mergeBelief(a: Belief, b: Belief): Belief {
  // A terminal, adjudicated belief is IMMUTABLE to re-observation: a plain `sync` that
  // re-mints the same content must not revive it, raise its confidence (the `Math.max`
  // below), or swap its watch — that is exactly how sync used to silently undo a
  // metabolize (COR-1). Keep it precisely as metabolism / the user left it.
  if (isTerminal(a)) return a;
  // Re-observation resurrects a dead (falsified/expired) or stale belief when reality
  // agrees again — the scar heals when the symbol returns.
  const revived = b.status === "live";
  const merged: Belief = {
    ...a,
    evidence: dedupEvidence([...a.evidence, ...b.evidence]),
    status: revived ? "live" : a.status,
    confidence: Math.max(a.confidence, b.confidence),
    lastVerified: a.lastVerified > b.lastVerified ? a.lastVerified : b.lastVerified,
    watch: b.watch.length ? b.watch : a.watch, // freshest fingerprint wins
    subjects: [...new Set([...a.subjects, ...b.subjects])],
    summary: b.summary ?? a.summary, // non-identity enrichment; a re-mint refreshes it
  };
  if (revived) {
    delete merged.tombstone; // the obituary is retracted; the belief lives again
    merged.supersededBy = "";
  }
  return merged;
}

function dedupEvidence(list: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const e of list) {
    const k = e.kind + "|" + e.ref;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}
