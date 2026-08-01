import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { acquireLease, releaseLease, readLease, leaseHeldBy, withLease, LeaseBusyError } from "../src/lease.js";
import { mkTmp, rm } from "./helpers.js";

const loc = (store: string) => ({ repo: store, store });

// A child process that races to steal an expired lease and prints WON:<token> or LOST.
// Real OS-level concurrency — the only way to actually exercise the steal race (CON-1).
// `dist` is ESM, so the child loads it with dynamic import() via a file:// URL — a plain
// require() throws ERR_REQUIRE_ESM on Node 18 (TOOL-1: the CI Node-18 job was red-on-arrival).
const RACER = `
const path = require("path");
const { pathToFileURL } = require("url");
(async () => {
  const { acquireLease } = await import(pathToFileURL(path.join(process.cwd(), "dist", "lease.js")).href);
  const store = process.argv[1], nowIso = process.argv[2];
  const l = acquireLease({ repo: store, store }, { holder: "p" + process.pid, ttlMs: 60000, now: new Date(nowIso) });
  process.stdout.write(l ? "WON:" + l.token : "LOST");
})();
`;

describe("the metabolizer lease — one mutating writer at a time", () => {
  it("grants to the first holder and refuses a live second holder", () => {
    const store = mkTmp();
    try {
      const l = acquireLease(loc(store), { holder: "alice", ttlMs: 60_000 });
      expect(l).toBeTruthy();
      const second = acquireLease(loc(store), { holder: "bob", ttlMs: 60_000 });
      expect(second).toBeNull(); // a live holder blocks
      expect(readLease(loc(store))?.holder).toBe("alice");
    } finally { rm(store); }
  });

  it("frees on release so the next writer can acquire", () => {
    const store = mkTmp();
    try {
      const l = acquireLease(loc(store), { holder: "alice" })!;
      releaseLease(loc(store), l);
      expect(readLease(loc(store))).toBeNull();
      const next = acquireLease(loc(store), { holder: "bob" });
      expect(next?.holder).toBe("bob"); // reclaimed cleanly
    } finally { rm(store); }
  });

  it("a crashed holder never wedges the store: an EXPIRED lease is stealable", () => {
    const store = mkTmp();
    try {
      const t0 = new Date("2026-07-01T00:00:00Z");
      const held = acquireLease(loc(store), { holder: "crasher", ttlMs: 1000, now: t0 })!;
      // Still live 500ms later — no steal.
      expect(acquireLease(loc(store), { holder: "thief", now: new Date(t0.getTime() + 500) })).toBeNull();
      // Past the TTL — the next writer steals it, and the survivor is unambiguous.
      const stolen = acquireLease(loc(store), { holder: "thief", now: new Date(t0.getTime() + 2000) });
      expect(stolen).toBeTruthy();
      expect(stolen!.token).not.toBe(held.token);
      expect(readLease(loc(store))?.token).toBe(stolen!.token);
    } finally { rm(store); }
  });

  it("CON-1: N processes racing to steal ONE expired lease yield exactly one holder", async () => {
    const store = mkTmp();
    try {
      const t0 = new Date("2026-07-01T00:00:00Z");
      acquireLease(loc(store), { holder: "crasher", ttlMs: 1000, now: t0 }); // expires t0+1s
      const nowIso = new Date(t0.getTime() + 10_000).toISOString(); // all racers are past expiry

      const N = 12;
      const runs = await Promise.all(
        Array.from({ length: N }, () => new Promise<string>((resolve) => {
          execFile("node", ["-e", RACER, store, nowIso], { cwd: process.cwd() }, (_e, out) => resolve(out ?? ""));
        })),
      );
      const winners = runs.filter((s) => s.startsWith("WON:"));
      expect(winners.length).toBe(1); // exactly one — never two "winners"
      expect(readLease(loc(store))?.token).toBe(winners[0].slice(4)); // and it's the file's holder
    } finally { rm(store); }
  });

  it("releaseLease will not delete a lease a stealer already replaced (TOCTOU)", () => {
    const store = mkTmp();
    try {
      const t0 = new Date("2026-07-01T00:00:00Z");
      const mine = acquireLease(loc(store), { holder: "overrun", ttlMs: 1000, now: t0 })!;
      // My lease expired; a stealer took over.
      const thief = acquireLease(loc(store), { holder: "thief", now: new Date(t0.getTime() + 5000) })!;
      // I belatedly release — I must NOT delete the thief's live lease.
      releaseLease(loc(store), mine);
      expect(readLease(loc(store))?.token).toBe(thief.token);
      expect(leaseHeldBy(loc(store), thief)).toBe(true);
      expect(leaseHeldBy(loc(store), mine)).toBe(false);
    } finally { rm(store); }
  });

  it("withLease runs the body, then releases even if it throws", async () => {
    const store = mkTmp();
    try {
      let ran = false;
      await withLease(loc(store), { holder: "alice" }, () => { ran = true; });
      expect(ran).toBe(true);
      expect(readLease(loc(store))).toBeNull(); // released

      // A held lease makes a concurrent withLease refuse rather than corrupt.
      const held = acquireLease(loc(store), { holder: "alice", ttlMs: 60_000 })!;
      await expect(withLease(loc(store), { holder: "bob" }, () => 1)).rejects.toBeInstanceOf(LeaseBusyError);
      releaseLease(loc(store), held);

      // A body that throws still releases the lease (finally).
      await expect(withLease(loc(store), { holder: "alice" }, () => { throw new Error("boom"); })).rejects.toThrow("boom");
      expect(readLease(loc(store))).toBeNull();
    } finally { rm(store); }
  });
});
