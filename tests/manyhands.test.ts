import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { appendTraceTo, readTraces, makeTrace, journalFiles } from "../src/journal.js";
import { journalShard, privateLoc } from "../src/paths.js";
import { Store } from "../src/store.js";
import { reconcile } from "../src/reconcile.js";
import { mkTmp, rm, belief } from "./helpers.js";

const loc = (store: string) => ({ repo: store, store });
const T = (writer: string, ts: string, note: string) => ({ writer, ts, note });

describe("many hands — one journal shard per writer, deterministic fold", () => {
  it("folds interleaved writers into one order that is independent of write order", () => {
    const events = [T("alice", "2026-06-01T00:00:00Z", "a1"), T("bob", "2026-06-02T00:00:00Z", "b1"),
                    T("alice", "2026-06-03T00:00:00Z", "a2"), T("bob", "2026-06-04T00:00:00Z", "b2")];
    const foldOrder = (writeSeq: typeof events): string[] => {
      const store = mkTmp();
      try {
        for (const e of writeSeq) appendTraceTo(loc(store), e.writer, makeTrace("session", { ts: e.ts, note: e.note }));
        return readTraces(loc(store)).map((t) => t.note);
      } finally { rm(store); }
    };
    const forward = foldOrder(events);
    const shuffled = foldOrder([events[3], events[1], events[2], events[0]]); // different interleaving
    expect(forward).toEqual(["a1", "b1", "a2", "b2"]); // sorted by (ts, writer)
    expect(shuffled).toEqual(forward); // ...regardless of how the appends were interleaved
  });

  it("writes one shard file per writer", () => {
    const store = mkTmp();
    try {
      appendTraceTo(loc(store), "alice", makeTrace("x", { note: "a" }));
      appendTraceTo(loc(store), "bob", makeTrace("x", { note: "b" }));
      const writers = journalFiles(loc(store)).map((f) => f.writer).filter(Boolean).sort();
      expect(writers).toEqual(["alice", "bob"]);
    } finally { rm(store); }
  });

  it("a kill -9 torn line in one shard never loses another writer's traces", () => {
    const store = mkTmp();
    try {
      appendTraceTo(loc(store), "alice", makeTrace("x", { ts: "2026-06-01T00:00:00Z", note: "a1" }));
      appendTraceTo(loc(store), "bob", makeTrace("x", { ts: "2026-06-02T00:00:00Z", note: "b1" }));
      appendTraceTo(loc(store), "bob", makeTrace("x", { ts: "2026-06-03T00:00:00Z", note: "b2" }));
      // alice's process dies mid-append: a half-written JSON fragment, no newline.
      appendFileSync(journalShard(loc(store), "alice"), '{"ts":"2026-06-04","kind":"x","note":"tor');
      const notes = readTraces(loc(store)).map((t) => t.note);
      expect(notes).toEqual(["a1", "b1", "b2"]); // bob intact; only alice's torn line dropped
    } finally { rm(store); }
  });
});

describe("many hands — the team ⊕ private overlay", () => {
  it("mounts a private belief over the team belief of the same id, leaving team untouched", () => {
    const store = mkTmp();
    try {
      const claim = "`src/x.ts` is a tracked source file in this repository.";
      const ev = [{ kind: "file" as const, ref: "src/x.ts", note: "" }];
      const teamB = belief({ claim, evidence: ev, confidence: 0.6 });
      const privB = belief({ claim, evidence: ev, confidence: 0.95 }); // same id, local override
      Store.open(loc(store)).mint(teamB);
      Store.open(privateLoc(loc(store))).mint(privB);

      const merged = Store.mergedRead(loc(store), privateLoc(loc(store)));
      expect(merged.get(teamB.id)?.confidence).toBe(0.95); // private wins on collision
      // The team store itself never saw the override — shared memory stays clean.
      expect(Store.open(loc(store)).get(teamB.id)?.confidence).toBe(0.6);
    } finally { rm(store); }
  });

  it("surfaces a private-only belief on read but keeps it out of the team store", () => {
    const store = mkTmp();
    try {
      const priv = belief({ claim: "I prefer verbose test output locally.", subjects: ["tests"] });
      Store.open(privateLoc(loc(store))).mint(priv);
      expect(Store.mergedRead(loc(store), privateLoc(loc(store))).has(priv.id)).toBe(true);
      expect(Store.open(loc(store)).has(priv.id)).toBe(false); // never in team memory
    } finally { rm(store); }
  });
});

describe("many hands — a cross-principal contradiction escalates to a dispute", () => {
  it("two teammates asserting opposite things, indistinguishable by trust/recency, become one open question", () => {
    const store = mkTmp();
    try {
      const base = {
        kind: "told" as const, method: "user-told", subjects: ["deployments", "staging"],
        confidence: 0.85, born: "2026-06-01T00:00:00.000Z", lastVerified: "2026-06-01T00:00:00.000Z",
        watch: [{ kind: "expire" as const, target: "2027-01-01T00:00:00.000Z", expect: "" }],
        evidence: [{ kind: "told" as const, ref: "user@2026-06-01", note: "" }],
      };
      const alice = belief({ ...base, claim: "Deployments go through staging first.", origin: "user:alice" });
      const bob = belief({ ...base, claim: "Deployments do not go through staging first.", origin: "user:bob" });
      const s = Store.fromBeliefs(loc(store), [alice, bob]);

      const rep = reconcile(s, { now: new Date("2026-06-02T00:00:00Z") });
      expect(rep.disputes.length).toBe(1); // trust + recency tie → escalate, don't pick a side
      expect(s.get(alice.id)?.status).toBe("superseded");
      expect(s.get(bob.id)?.status).toBe("superseded");
      const dispute = s.all().find((b) => b.method === "dispute");
      expect(dispute?.status).toBe("live");
      expect(dispute?.lineage.sort()).toEqual([alice.id, bob.id].sort());
    } finally { rm(store); }
  });
});
