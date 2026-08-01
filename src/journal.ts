import { appendFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Loc } from "./paths.js";
import { journalPath, journalDir, journalShard, ensureDir } from "./paths.js";
import { currentWriter } from "./principal.js";
import { FORMAT_VERSION } from "./schema.js";
import type { Trace } from "./types.js";

// Append a trace to THIS writer's shard. Different writers hit different files, so
// concurrent appends never contend and no lock is taken on the write path.
export function appendTrace(loc: Loc, t: Trace): void {
  appendTraceTo(loc, currentWriter(), t);
}

// Explicit-writer append — the seam the multi-writer simulation and chaos suite drive
// to stand up N distinct authors in one process. `appendFileSync` is atomic for a
// single line at these sizes; a crash mid-append leaves at most one torn trailing line
// in THIS shard, never a tear in another writer's data.
export function appendTraceTo(loc: Loc, writer: string, t: Trace): void {
  ensureDir(journalDir(loc));
  appendFileSync(journalShard(loc, writer), JSON.stringify(t) + "\n", "utf8");
}

// store = fold(journal). The fold merges the legacy single file + every writer shard
// into ONE deterministic sequence, ordered by (timestamp, writer, position-in-shard).
// Each file is torn-tail tolerant independently: an unparsable line (a kill -9 mid-
// append) is dropped, and only that one line — the rest of every shard survives. The
// order is a pure function of the bytes on disk, so the fold is reproducible no matter
// how the appends were interleaved across processes.
export function readTraces(loc: Loc): Trace[] {
  const rows: { t: Trace; w: string; i: number }[] = [];
  for (const { path, writer } of journalFiles(loc)) {
    let i = 0;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const t = coerceTrace(JSON.parse(s));
        // A row with no usable timestamp can't be ordered in the fold OR rendered by
        // `why` (which slices `ts`); drop it rather than let one shapeless line — a
        // hand-edit, a partial write, a foreign writer — crash a read verb (TYP-1).
        if (!t.ts) continue;
        rows.push({ t, w: writer, i: i++ });
      } catch {
        /* torn line — advisory journal, canonical beliefs are elsewhere */
      }
    }
  }
  rows.sort((a, b) =>
    (a.t.ts < b.t.ts ? -1 : a.t.ts > b.t.ts ? 1 : 0) || a.w.localeCompare(b.w) || a.i - b.i,
  );
  return rows.map((r) => r.t);
}

// Every journal file to fold, in a stable order: the legacy single file first (writer
// ""), then each writer shard by name. Missing files are simply absent.
export function journalFiles(loc: Loc): { path: string; writer: string }[] {
  const out: { path: string; writer: string }[] = [];
  const legacy = journalPath(loc);
  if (existsSync(legacy)) out.push({ path: legacy, writer: "" });
  const dir = journalDir(loc);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith(".jsonl")) out.push({ path: join(dir, f), writer: f.replace(/\.jsonl$/, "") });
    }
  }
  return out;
}

// Coerce a parsed journal row into a well-typed Trace: every field a string (so `.slice`
// and friends on the read path never throw), version numeric-or-absent. A row is only
// KEPT if it yields a non-empty `ts` (see readTraces) — the journal is advisory, and a
// malformed line degrades to "dropped", never to a crash.
function coerceTrace(raw: unknown): Trace {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    v: typeof r.v === "number" ? r.v : undefined,
    ts: typeof r.ts === "string" ? r.ts : "",
    kind: String(r.kind ?? ""),
    actor: String(r.actor ?? ""),
    subject: String(r.subject ?? ""),
    ref: String(r.ref ?? ""),
    note: String(r.note ?? ""),
  };
}

export function makeTrace(kind: string, fields: Partial<Trace>): Trace {
  return {
    v: fields.v ?? FORMAT_VERSION,
    ts: fields.ts ?? new Date().toISOString(),
    kind,
    actor: fields.actor ?? "ingest",
    subject: fields.subject ?? "",
    ref: fields.ref ?? "",
    note: fields.note ?? "",
  };
}
