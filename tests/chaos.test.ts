import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ingestGit } from "../src/ingest.js";
import { sweep } from "../src/watch.js";
import { verifyStore } from "../src/integrity.js";
import { appendTraceTo, readTraces, makeTrace } from "../src/journal.js";
import { journalShard } from "../src/paths.js";
import { acquireLease, releaseLease, readLease, withLease } from "../src/lease.js";
import { gitRepo, rm } from "./helpers.js";

// The M4 gate (PLAN §M4): under concurrent writers and kill -9 mid-append, the store
// suffers zero corruption and zero loss. We model concurrency deterministically —
// round-robin interleaving of N writers, half of them crashing mid-append — which
// exercises exactly the failure the design must survive: torn shards and a stolen lease.

describe("chaos — concurrent writers, torn tails: zero loss, zero corruption", () => {
  it("loses only torn trailing lines; every complete trace across every shard survives", () => {
    const repo = gitRepo([{ "src/a.ts": "export function a(){return 1}\n", "src/b.ts": "export function b(){return 2}\n" }]);
    const loc = { repo, store: join(repo, ".muster") };
    try {
      const store = Store.open(loc);
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
      sweep(store, new Date("2026-05-10T00:00:00Z"));
      const base = readTraces(loc).length;

      // N writers, K traces each, interleaved round-robin (concurrency, deterministically).
      const N = 8, K = 20;
      let clock = 0;
      for (let round = 0; round < K; round++) {
        for (let w = 0; w < N; w++) {
          const ts = new Date(1_800_000_000_000 + clock++ * 1000).toISOString();
          appendTraceTo(loc, `agent-${w}`, makeTrace("session", { ts, actor: `agent-${w}`, note: `w${w}r${round}` }));
        }
      }
      // Half the writers are kill -9'd mid-append: a partial JSON fragment, no newline.
      const crashed = N / 2;
      for (let w = 0; w < crashed; w++) {
        appendFileSync(journalShard(loc, `agent-${w}`), `{"ts":"2099","kind":"session","note":"tor`);
      }

      const after = readTraces(loc);
      expect(after.length).toBe(base + N * K); // every complete trace survived; torn dropped
      // No phantom, no duplication: the N*K notes are exactly present.
      const notes = new Set(after.map((t) => t.note));
      for (let w = 0; w < N; w++) for (let r = 0; r < K; r++) expect(notes.has(`w${w}r${r}`)).toBe(true);

      // The belief set is untouched by journal chaos — verify sees no tamper, and it
      // counts exactly the torn lines it tolerated.
      const v = verifyStore(store, new Date("2026-05-10T00:00:00Z"));
      expect(v.fatal).toBe(false);
      expect(v.journalTorn).toBe(crashed);
    } finally { rm(repo); }
  });
});

describe("chaos — the lease is mutually exclusive under a stampede", () => {
  it("elects exactly one holder per round across many contenders", () => {
    const repo = gitRepo([{ "src/a.ts": "export function a(){return 1}\n" }]);
    const loc = { repo, store: join(repo, ".muster") };
    try {
      const now = new Date("2026-07-01T00:00:00Z");
      for (let round = 0; round < 25; round++) {
        // 10 contenders stampede the lease at the same instant.
        const grants = [];
        for (let c = 0; c < 10; c++) {
          const l = acquireLease(loc, { holder: `c${c}`, ttlMs: 60_000, now });
          if (l) grants.push(l);
        }
        expect(grants.length).toBe(1); // O_EXCL: exactly one winner, the rest back off
        releaseLease(loc, grants[0]); // winner finishes; next round re-elects
        expect(readLease(loc)).toBeNull();
      }
    } finally { rm(repo); }
  });

  it("a crashed holder (expired lease, never released) never permanently wedges the store", async () => {
    const repo = gitRepo([{ "src/a.ts": "export function a(){return 1}\n" }]);
    const loc = { repo, store: join(repo, ".muster") };
    try {
      const t0 = new Date("2026-07-01T00:00:00Z");
      // A metabolizer acquires the lease and is kill -9'd — it never releases.
      acquireLease(loc, { holder: "crashed-metabolizer", ttlMs: 1000, now: t0 });
      // Long after the TTL, the next writer reclaims the store and does real work.
      let ran = false;
      await withLease(loc, { holder: "recoverer", now: new Date(t0.getTime() + 10 * 60_000) }, () => { ran = true; });
      expect(ran).toBe(true);
      expect(readLease(loc)).toBeNull(); // cleanly released after recovery
    } finally { rm(repo); }
  });
});
