import { execFileSync } from "node:child_process";

// ─────────────────────────────────────────────────────────────────────────────
// Principals & writers (PLAN §M4 — many hands).
//
// A "writer" is one journal author: a person or an agent process. Muster gets
// concurrency WITHOUT coordination from a single rule — one journal shard per writer.
// Appends to different shards never contend (no lock on the write path), and the fold
// merges them into one deterministic sequence regardless of interleaving. So two agents
// (or an agent and a metabolizer) can write at the same instant and neither can corrupt
// or lose the other's traces; at worst a `kill -9` costs the one torn trailing line of
// the one shard being written.
//
// The writer id is resolved once per process (env override → git identity → "local")
// and slugged to a filesystem-safe token that names the shard file and stamps the lease.
// It is deliberately distinct from a belief's `origin` (semantic provenance like
// "ingest:git" or "user:alice"): the writer is the physical author of the shard.
// ─────────────────────────────────────────────────────────────────────────────

const UNSAFE = /[^a-z0-9._-]+/gi;

export function slugWriter(s: string): string {
  const out = s.trim().toLowerCase().replace(UNSAFE, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return out || "local";
}

let cached: string | null = null;

// The writer id for this process. Order: MUSTER_WRITER / MUSTER_PRINCIPAL, then the
// git committer email (so a real team gets one shard per teammate for free), then
// "local". Cached so every append in a run lands in the same shard.
export function currentWriter(): string {
  if (cached !== null) return cached;
  const env = process.env.MUSTER_WRITER || process.env.MUSTER_PRINCIPAL || "";
  cached = slugWriter(env || gitEmail() || "local");
  return cached;
}

// Test/CLI seam: force the writer id (the multi-writer simulation and chaos suite use
// this to stand up N distinct authors in one process).
export function setWriter(w: string): void { cached = slugWriter(w); }
export function resetWriter(): void { cached = null; }

function gitEmail(): string {
  try {
    return execFileSync("git", ["config", "user.email"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    return "";
  }
}
