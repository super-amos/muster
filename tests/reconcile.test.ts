import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { resolveContradiction, arePolarOpposites, reconcile } from "../src/reconcile.js";
import { belief, mkTmp, rm } from "./helpers.js";
import type { Belief } from "../src/types.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");

function make(claim: string, over: Partial<Belief>): Belief {
  return belief({
    claim,
    subjects: ["src/auth.ts"],
    evidence: [{ kind: "file", ref: `src/auth.ts#${claim.length}`, note: "" }],
    watch: [{ kind: "path", target: "src/auth.ts", expect: "present" }],
    ...over,
  });
}

describe("resolveContradiction — the pure precedence protocol", () => {
  const t = "2026-05-01T00:00:00.000Z";
  it("evidence kind wins first: observed beats assumed", () => {
    const a = make("src/auth.ts uses bcrypt.", { kind: "observed", lastVerified: t, origin: "ingest:git" });
    const b = make("src/auth.ts does not use bcrypt.", { kind: "assumed", lastVerified: t, origin: "ingest:git" });
    expect(resolveContradiction(a, b)).toEqual({ verdict: "a", basis: "evidence-kind" });
  });

  it("recency breaks a same-kind tie: the newer reverification wins", () => {
    const a = make("src/auth.ts uses bcrypt.", { kind: "observed", lastVerified: "2026-05-10T00:00:00.000Z", origin: "ingest:git" });
    const b = make("src/auth.ts does not use bcrypt.", { kind: "observed", lastVerified: "2026-05-01T00:00:00.000Z", origin: "ingest:git" });
    expect(resolveContradiction(a, b)).toEqual({ verdict: "a", basis: "recency" });
  });

  it("principal trust breaks a same-kind, same-time tie: the user outranks ingest", () => {
    const a = make("src/auth.ts uses bcrypt.", { kind: "observed", lastVerified: t, origin: "user" });
    const b = make("src/auth.ts does not use bcrypt.", { kind: "observed", lastVerified: t, origin: "ingest:git" });
    expect(resolveContradiction(a, b)).toEqual({ verdict: "a", basis: "trust" });
  });

  it("escalates to a dispute when nothing separates them", () => {
    const a = make("src/auth.ts uses bcrypt.", { kind: "observed", lastVerified: t, origin: "ingest:git" });
    const b = make("src/auth.ts does not use bcrypt.", { kind: "observed", lastVerified: t, origin: "ingest:git" });
    expect(resolveContradiction(a, b).verdict).toBe("dispute");
  });
});

describe("arePolarOpposites — conservative negation detection", () => {
  it("flags same-claim-modulo-negation", () => {
    const a = make("src/auth.ts uses bcrypt for hashing.", {});
    const b = make("src/auth.ts does not use bcrypt for hashing.", {});
    expect(arePolarOpposites(a, b)).toBe(true);
  });
  it("does NOT flag two different positive claims", () => {
    const a = make("src/auth.ts uses bcrypt for hashing.", {});
    const b = make("src/auth.ts uses argon2 for hashing.", {});
    expect(arePolarOpposites(a, b)).toBe(false);
  });
});

describe("reconcile — applying the protocol to a live store", () => {
  function open(): { store: Store; dir: string } {
    const dir = mkTmp();
    return { store: Store.open({ repo: dir, store: join(dir, ".muster") }), dir };
  }

  it("resolves a decisive contradiction: the loser is superseded (kept in the record)", () => {
    const { store, dir } = open();
    try {
      const a = make("src/auth.ts uses bcrypt.", { kind: "observed", lastVerified: "2026-05-01T00:00:00.000Z", origin: "ingest:git" });
      const b = make("src/auth.ts does not use bcrypt.", { kind: "assumed", lastVerified: "2026-05-01T00:00:00.000Z", origin: "ingest:git" });
      store.mint(a); store.mint(b);

      const r = reconcile(store, { now: NOW });
      expect(r.resolved.length).toBe(1);
      expect(store.get(a.id)!.status).toBe("live");
      expect(store.get(b.id)!.status).toBe("superseded");
      expect(store.get(b.id)!.supersededBy).toBe(a.id);
    } finally { rm(dir); }
  });

  it("escalates a tie to a dispute belief that briefs as an open question (never both as truth)", () => {
    const { store, dir } = open();
    try {
      const a = make("src/auth.ts uses bcrypt.", { kind: "observed", lastVerified: "2026-05-01T00:00:00.000Z", origin: "ingest:git" });
      const b = make("src/auth.ts does not use bcrypt.", { kind: "observed", lastVerified: "2026-05-01T00:00:00.000Z", origin: "ingest:git" });
      store.mint(a); store.mint(b);

      const r = reconcile(store, { now: NOW });
      expect(r.disputes.length).toBe(1);
      const dispute = store.get(r.disputes[0].id)!;
      expect(dispute.method).toBe("dispute");
      expect(dispute.status).toBe("live");
      expect(dispute.lineage.sort()).toEqual([a.id, b.id].sort());
      // Neither disputant briefs as truth any more.
      expect(store.get(a.id)!.status).toBe("superseded");
      expect(store.get(b.id)!.status).toBe("superseded");
    } finally { rm(dir); }
  });
});
