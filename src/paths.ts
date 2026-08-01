import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface Loc {
  repo: string;    // the repository whose memory this is (source of exhaust)
  store: string;   // where beliefs + journal live (default <repo>/.muster)
}

export function resolveLoc(opts: { repo?: string; store?: string }): Loc {
  const repo = resolve(opts.repo && opts.repo.length ? opts.repo : process.cwd());
  const store = opts.store && opts.store.length ? resolve(opts.store) : join(repo, ".muster");
  return { repo, store };
}

export function beliefsDir(loc: Loc): string { return join(loc.store, "beliefs"); }

// The journal. Legacy single-file stores keep `journal.jsonl`; multi-writer stores
// shard it under `journal/<writer>.jsonl` (one shard per writer, so appends never
// contend — see principal.ts). The fold reads the legacy file AND every shard.
export function journalPath(loc: Loc): string { return join(loc.store, "journal.jsonl"); }
export function journalDir(loc: Loc): string { return join(loc.store, "journal"); }
export function journalShard(loc: Loc, writer: string): string { return join(journalDir(loc), writer + ".jsonl"); }
export function leasePath(loc: Loc): string { return join(loc.store, "lease.json"); }

// The private overlay store — local-only beliefs that mount OVER the team store and are
// never committed to the shared remote (gitignore `.muster/private/`). Reads merge
// team ⊕ private with private winning; team memory stays clean of one agent's overrides.
export function privateLoc(loc: Loc): Loc { return { repo: loc.repo, store: join(loc.store, "private") }; }

export function ensureDir(p: string): void { mkdirSync(p, { recursive: true }); }

// Atomic write: temp file in the same dir + rename. A crash mid-write never leaves
// a half-written belief; readers see either the old file or the new one, never a tear.
export function atomicWrite(path: string, data: string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}
