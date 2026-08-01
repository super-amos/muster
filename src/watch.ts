import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import type { BeliefStatus, DeathKind, WatchClause, Belief } from "./types.js";
import { contentHash } from "./id.js";
import { exhaustive } from "./schema.js";
import { confine, isConfined } from "./confine.js";
import { Store } from "./store.js";
import { appendTrace, makeTrace } from "./journal.js";
import { definesSymbol, yieldsAnySymbol, hasCode, splitSymbolTarget } from "./symbols.js";

// Re-exported so `watch.ts` stays the public home of presence detection (see index.ts).
export { definesSymbol } from "./symbols.js";

// A corpus-confined read that never throws: it distinguishes a genuinely-gone file
// (ENOENT → the watch fires) from an inconclusive read (a directory at the path, a
// permission error → demote to stale, never a false tombstone and never a crash that
// aborts the whole sweep or `verify`). This is the ERR-2 fix, living inside evalWatch so
// the sweep and `verify` cannot diverge into phantom drift.
function readTarget(p: string): { text: string } | { gone: boolean } {
  try { return { text: readFileSync(p, "utf8") }; }
  catch (e) { return { gone: (e as NodeJS.ErrnoException).code === "ENOENT" }; }
}

// The outcome of evaluating one death condition against current reality.
export interface WatchResult {
  fired: boolean;
  reason: string;
  // A fired watch resolves to one of two fates:
  //   "dead"  — the belief is falsified/expired; it becomes an obituary + tripwire
  //   "stale" — the world moved but the claim may still hold; demote, revive on re-sync
  fate: "dead" | "stale";
  death?: DeathKind;
}

const NOT_FIRED: WatchResult = { fired: false, reason: "", fate: "stale" };

// Evaluate one death condition against current reality. Reads are corpus-confined:
// a watch whose target escapes the repo root is refused (never fired, never read).
export function evalWatch(repo: string, w: WatchClause, now: Date): WatchResult {
  switch (w.kind) {
    case "expire": {
      const fired = now.toISOString() >= w.target;
      return fired
        ? { fired: true, reason: `expiry ${w.target.slice(0, 10)} elapsed`, fate: "dead", death: "expired" }
        : NOT_FIRED;
    }
    case "path": {
      if (!isConfined(repo, w.target)) return NOT_FIRED;
      const exists = existsSync(confine(repo, w.target));
      return exists
        ? NOT_FIRED
        : { fired: true, reason: `${w.target} no longer exists`, fate: "dead", death: "falsified" };
    }
    case "blob": {
      if (!isConfined(repo, w.target)) return NOT_FIRED;
      const rd = readTarget(confine(repo, w.target));
      if ("gone" in rd) {
        return rd.gone
          ? { fired: true, reason: `${w.target} deleted`, fate: "dead", death: "falsified" }
          : { fired: true, reason: `${w.target} unreadable (inconclusive)`, fate: "stale" };
      }
      const cur = contentHash(rd.text);
      // Content moved, but the file still exists — the summary may be outdated, not
      // wrong. Demote to stale; a re-sync re-fingerprints and revives it.
      return cur !== w.expect
        ? { fired: true, reason: `${w.target} changed (${w.expect}→${cur})`, fate: "stale" }
        : NOT_FIRED;
    }
    case "symbol": {
      const { name: sym, file } = splitSymbolTarget(w.target);
      if (!file || !isConfined(repo, file)) {
        return { fired: true, reason: `${file || "?"} unreadable`, fate: "dead", death: "falsified" };
      }
      const rd = readTarget(confine(repo, file));
      if ("gone" in rd) {
        // A deleted file falsifies hard (the scar); an inconclusive read (a directory at
        // the path, EACCES) is NOT evidence the symbol is gone — demote to stale so a
        // transient read error can never forge a tombstone or crash the sweep.
        return rd.gone
          ? { fired: true, reason: `${file} deleted`, fate: "dead", death: "falsified" }
          : { fired: true, reason: `${file} unreadable (inconclusive)`, fate: "stale" };
      }
      const ext = extname(file);
      if (definesSymbol(rd.text, sym || "", ext)) return NOT_FIRED;
      // The symbol is not found. Distinguish a REAL absence from a scanner-BLIND file
      // (item 17): if the file still yields OTHER symbols (or is empty), the scanner can
      // read it, so the missing definition is genuinely gone — falsify HARD (the canonical
      // scar; it must resurface as a tripwire, never brief as truth again). If a NON-empty
      // file yields ZERO symbols, the regex floor can't parse it (a reformat, an unfamiliar
      // construct) — that's inconclusive, so demote to stale rather than forge a tombstone.
      const blind = hasCode(rd.text, ext) && !yieldsAnySymbol(rd.text, ext);
      return blind
        ? { fired: true, reason: `${file} yielded no parseable symbols — cannot confirm ${sym} was removed`, fate: "stale" }
        : { fired: true, reason: `${sym} no longer defined in ${file}`, fate: "dead", death: "falsified" };
    }
  }
  // Exhaustive over WatchClause["kind"]: adding a kind without a case fails to compile.
  // A corrupt kind (only reachable via on-disk tampering, which `verify` flags fatal)
  // degrades to "never fired" so neither the sweep nor `verify` crashes on it.
  return exhaustive(w.kind, NOT_FIRED);
}

export interface SweepResult {
  checked: number;
  killed: { id: string; status: BeliefStatus; reason: string }[];
  staled: { id: string; reason: string }[];
}

// The reverification sweep — the mortality engine. For every live belief, evaluate
// its death conditions against current reality. A fired watch either falsifies the
// belief (writing a tombstone that cites the killing commit) or demotes it to stale.
// This is the whole difference from a rotting instruction file: beliefs know when to
// die, and they die by themselves — no model, no human, no gardening.
export function sweep(store: Store, now: Date = new Date()): SweepResult {
  const res: SweepResult = { checked: 0, killed: [], staled: [] };
  const nowIso = now.toISOString();
  for (const b of store.all()) {
    if (b.status !== "live") continue;
    res.checked++;
    for (const w of b.watch) {
      const f = evalWatch(store.loc.repo, w, now);
      if (!f.fired) continue;

      if (f.fate === "dead") {
        const killer = killingCommit(store.loc.repo, w);
        b.status = "dead";
        b.lastVerified = nowIso;
        b.tombstone = {
          death: f.death ?? "falsified",
          at: nowIso,
          by: killer,
          note: obituaryLine(b, f.reason, killer),
        };
        store.persist(b);
        appendTrace(store.loc, makeTrace("death", { actor: "sweep", subject: b.id, ref: killer || w.kind, note: f.reason }));
        res.killed.push({ id: b.id, status: "dead", reason: f.reason });
      } else {
        b.status = "stale";
        b.lastVerified = nowIso;
        store.persist(b);
        appendTrace(store.loc, makeTrace("stale", { actor: "sweep", subject: b.id, ref: w.kind, note: f.reason }));
        res.staled.push({ id: b.id, reason: f.reason });
      }
      break; // first fired watch decides the fate
    }
  }
  return res;
}

// A truthful obituary: what was believed, and what killed it. This is the line the
// next briefing carries *instead of the belief's ghost*.
function obituaryLine(b: Belief, reason: string, killer: string): string {
  const sym = b.watch.find((w) => w.kind === "symbol");
  const cite = killer ? ` (commit ${killer})` : "";
  if (sym) {
    const { name, file } = splitSymbolTarget(sym.target);
    return `\`${name}\` was defined in \`${file}\` until it was removed${cite}. Do not call it.`;
  }
  const path = b.watch.find((w) => w.kind === "path" || w.kind === "blob");
  if (path && /deleted|no longer exists/.test(reason)) {
    return `\`${path.target}\` existed until it was deleted${cite}.`;
  }
  return `${b.claim} — no longer true: ${reason}${cite}.`;
}

// Best-effort: the last commit that touched the watched file is the probable killer.
// Mechanical and citeable; degrades to "" outside a git repo.
function killingCommit(repo: string, w: WatchClause): string {
  const file = w.kind === "symbol" ? splitSymbolTarget(w.target).file : w.target;
  if (!file || w.kind === "expire" || !isConfined(repo, file)) return "";
  try {
    const out = execFileSync("git", ["-C", repo, "log", "-1", "--format=%h", "--", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    return out;
  } catch {
    return "";
  }
}
