import { openSync, writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, closeSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Loc } from "./paths.js";
import { leasePath, ensureDir } from "./paths.js";

// ─────────────────────────────────────────────────────────────────────────────
// The metabolizer lease (PLAN §M4). Writer shards make APPENDS coordination-free, but
// the mutating spine — the reverification sweep and metabolism — rewrites belief files
// in place (status, lineage, tombstones, consolidation). Two of those running at once
// could interleave a retire with a revive and corrupt the live set. So exactly one
// holder at a time may mutate, guarded by a single lease.
//
// The lease is a FILE, not a daemon (a daemon must earn its residency; PLAN §deployment):
//   • acquired by an atomic O_EXCL create — the OS guarantees one winner across processes;
//   • released by deleting the file;
//   • STEALABLE once expired — a crashed holder (kill -9, no release) never wedges the
//     store forever; the next writer past the TTL steals it via an atomic rename and
//     confirms its own token survived the race.
// The READ path never touches the lease: compilation stays lock-free and pure.
// ─────────────────────────────────────────────────────────────────────────────

export interface Lease {
  holder: string;
  token: string;
  acquired: string;
  expires: string;
  pid: number;
}

export interface AcquireOptions {
  holder: string;
  ttlMs?: number; // default 60s — long enough for a metabolize, short enough to reclaim
  now?: Date; // injected for deterministic expiry tests
}

const DEFAULT_TTL = 60_000;

export function acquireLease(loc: Loc, opts: AcquireOptions): Lease | null {
  ensureDir(loc.store);
  const now = opts.now ?? new Date();
  const ttl = opts.ttlMs ?? DEFAULT_TTL;
  const lease: Lease = {
    holder: opts.holder,
    token: randomBytes(8).toString("hex"),
    acquired: now.toISOString(),
    expires: new Date(now.getTime() + ttl).toISOString(),
    pid: process.pid,
  };
  const p = leasePath(loc);

  // Fast path: atomic create. O_EXCL ("wx") fails if the file exists, so exactly one
  // concurrent creator wins — no lock, no race.
  try {
    const fd = openSync(p, "wx");
    try { writeFileSync(fd, JSON.stringify(lease)); } finally { closeSync(fd); }
    return lease;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }

  // Contended. Steal ONLY if the incumbent has expired; a live holder means back off.
  const cur = readLease(loc);
  if (cur && now.toISOString() < cur.expires) return null;

  // Expired (or unreadable) incumbent. Stealing must be atomic against other stealers, and
  // a naive rename/re-read confirm has a TOCTOU where two stealers each observe their own
  // token and BOTH believe they won (CON-1). So stealers SERIALIZE on a short O_EXCL
  // steal-lock: exactly one holds it at a time, and only that one re-checks expiry and
  // installs. A stealer that can't take the steal-lock backs off — it never touches p, so
  // it can never clobber a fresh lease a faster stealer just installed.
  const sfd = takeStealLock(p + ".steal");
  if (sfd === null) return null;
  try {
    // Under the steal-lock: has someone already stolen and installed a fresh lease?
    const cur2 = readLease(loc);
    if (cur2 && now.toISOString() < cur2.expires) return null;
    // Still expired (or gone). Install by atomic rename — safe: we alone hold the steal-lock.
    const tmp = p + ".new." + lease.token;
    writeFileSync(tmp, JSON.stringify(lease));
    renameSync(tmp, p);
    return lease;
  } finally {
    closeSync(sfd);
    try { unlinkSync(p + ".steal"); } catch { /* already reclaimed */ }
  }
}

// The steal-lock protects a MICROSECOND critical section (re-check + rename). O_EXCL gives
// exactly one holder. A crash inside it would leak the lock, so a lock older than
// STEAL_LOCK_TTL is reclaimed once (wall-clock, since it guards crash recovery, not the
// injected logical lease clock) — a leaked steal-lock never wedges the store for long.
const STEAL_LOCK_TTL = 5_000;
function takeStealLock(path: string): number | null {
  try { return openSync(path, "wx"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    try {
      if (Date.now() - statSync(path).mtimeMs > STEAL_LOCK_TTL) {
        unlinkSync(path);
        return openSync(path, "wx");
      }
    } catch { /* lost the reclaim race to another stealer */ }
    return null;
  }
}

// Release only if we still hold it — without a read-then-unlink TOCTOU (deleting a lease a
// stealer already replaced). Move the file to a PRIVATE name first (`rename` is atomic and
// exclusive), inspect it in isolation, and unlink only when the token is ours; if a stealer
// had already replaced it (this holder overran its TTL), restore it untouched.
export function releaseLease(loc: Loc, lease: Lease): void {
  const p = leasePath(loc);
  const held = p + ".release." + lease.token;
  try { renameSync(p, held); } catch { return; } // already released/stolen — nothing to do
  const cur = readLeaseFrom(held);
  if (cur && cur.token === lease.token) {
    try { unlinkSync(held); } catch { /* already gone */ }
  } else {
    try { renameSync(held, p); } catch { /* best-effort restore of a stealer's live lease */ }
  }
}

function readLeaseFrom(path: string): Lease | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as Lease; } catch { return null; }
}

// Fencing: is `lease` STILL the current holder? A mutating write must re-check this — a
// holder that overran its TTL and was stolen has no right to keep writing. Wired into the
// single write choke-point (Phase 3a); available now for callers that fence explicitly.
export function leaseHeldBy(loc: Loc, lease: Lease): boolean {
  const cur = readLease(loc);
  return cur !== null && cur.token === lease.token;
}

export function readLease(loc: Loc): Lease | null {
  const p = leasePath(loc);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as Lease; } catch { return null; }
}

// Run `fn` while holding the lease; always release, even on throw. Throws LeaseBusyError
// if a live holder is present, so the caller can report "someone else is metabolizing"
// instead of corrupting the store.
export async function withLease<T>(loc: Loc, opts: AcquireOptions, fn: (lease: Lease) => Promise<T> | T): Promise<T> {
  const lease = acquireLease(loc, opts);
  if (!lease) throw new LeaseBusyError(readLease(loc));
  try {
    return await fn(lease);
  } finally {
    releaseLease(loc, lease);
  }
}

export class LeaseBusyError extends Error {
  constructor(public held: Lease | null) {
    super(
      held
        ? `store is leased by "${held.holder}" until ${held.expires.slice(0, 19)}Z — another sync/metabolize is in progress`
        : "store is leased by another writer",
    );
    this.name = "LeaseBusyError";
  }
}
