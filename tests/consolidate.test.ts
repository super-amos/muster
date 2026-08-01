import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { consolidate } from "../src/consolidate.js";
import { compileBriefing } from "../src/linker.js";
import { belief, mkTmp, rm } from "./helpers.js";
import type { Belief } from "../src/types.js";

// A deterministic clock so principle horizons (and the whole run) are reproducible.
const NOW = new Date("2026-06-01T00:00:00.000Z");

function openStore(): { store: Store; dir: string } {
  const dir = mkTmp();
  const store = Store.open({ repo: dir, store: join(dir, ".muster") });
  return { store, dir };
}

// A co-change belief anchored on `src/a.ts` (lexicographically smallest, so every
// member lands in the same family/anchor group) paired with a distinct partner.
function cochange(i: number): Belief {
  const partner = `src/z${String(i).padStart(3, "0")}.ts`;
  const claim = `\`src/a.ts\` and \`${partner}\` change together (${i}×).`;
  return belief({
    claim,
    kind: "inferred",
    method: "git-cochange",
    subjects: ["src/a.ts", partner],
    evidence: [{ kind: "file", ref: "src/a.ts", note: `pair ${i}` }, { kind: "file", ref: partner, note: "" }],
    watch: [{ kind: "path", target: "src/a.ts", expect: "present" }, { kind: "path", target: partner, expect: "present" }],
    origin: "ingest:git",
    born: "2026-05-01T12:00:00.000Z",
    lastVerified: "2026-05-01T12:00:00.000Z",
  });
}

describe("consolidation — total-citation, retirement, and a flat live set", () => {
  it("folds a bloated family into ONE principle that cites every member", () => {
    const { store, dir } = openStore();
    try {
      const members: Belief[] = [];
      for (let i = 0; i < 10; i++) { const b = cochange(i); members.push(b); store.mint(b); }
      const before = store.all().filter((b) => b.status === "live").length;

      const r = consolidate(store, { threshold: 6, now: NOW });
      expect(r.principles.length).toBe(1);
      const principle = store.get(r.principles[0].principle)!;

      // Total-citation: the principle names every member in its lineage.
      for (const m of members) expect(principle.lineage).toContain(m.id);
      expect(principle.method).toBe("consolidation");
      expect(principle.status).toBe("live");

      // Every member is retired with a forwarding address — never deleted.
      for (const m of members) {
        const after = store.get(m.id)!;
        expect(after.status).toBe("retired");
        expect(after.supersededBy).toBe(principle.id);
        expect(after.tombstone?.death).toBe("consolidated");
      }

      const live = store.all().filter((b) => b.status === "live").length;
      expect(live).toBeLessThan(before);
      expect(live).toBe(1); // just the principle
    } finally { rm(dir); }
  });

  it("holds the live set FLAT across a synthetic year of journal growth", () => {
    const { store, dir } = openStore();
    try {
      let idx = 0;
      const liveCounts: number[] = [];
      // 12 monthly rounds, each adding 10 new co-change beliefs about the same anchor.
      for (let round = 0; round < 12; round++) {
        for (let k = 0; k < 10; k++) { const b = cochange(idx++); store.mint(b); }
        consolidate(store, { threshold: 6, now: NOW });
        liveCounts.push(store.all().filter((b) => b.status === "live").length);
      }
      // 120 members accreted over the "year", all folded into ONE content-addressed
      // principle — the record keeps everything, the live set stays tiny.
      expect(store.all().length).toBe(121); // 120 members + 1 principle (Store dedupes by id)
      // The flat-set guarantee: live count stays at 1 (the principle) every single round,
      // no matter how much the journal grows underneath it.
      for (const c of liveCounts) expect(c).toBe(1);
    } finally { rm(dir); }
  });

  it("is convergent: a second pass with no new members is a no-op", () => {
    const { store, dir } = openStore();
    try {
      for (let i = 0; i < 8; i++) store.mint(cochange(i));
      const first = consolidate(store, { threshold: 6, now: NOW });
      expect(first.retired).toBe(8);
      const second = consolidate(store, { threshold: 6, now: NOW });
      expect(second.retired).toBe(0);
      expect(second.principles.length).toBe(0);
      expect(store.all().filter((b) => b.status === "live").length).toBe(1);
    } finally { rm(dir); }
  });

  it("NEVER absorbs a live symbol belief or a directive (the scar + standing orders stay granular)", () => {
    const { store, dir } = openStore();
    try {
      for (let i = 0; i < 8; i++) store.mint(cochange(i));
      const sym = belief({
        claim: "`issueToken` (function) is defined in `src/a.ts`.",
        method: "read-source", subjects: ["src/a.ts", "issueToken"],
        watch: [{ kind: "symbol", target: "issueToken@src/a.ts", expect: "present" }],
        evidence: [{ kind: "file", ref: "src/a.ts", note: "line 4" }],
      });
      const dir1 = belief({
        claim: "Always run tests before pushing.", kind: "directive", method: "user-told",
        watch: [], evidence: [{ kind: "told", ref: "user@2026-05-01", note: "" }], origin: "user",
      });
      store.mint(sym);
      store.mint(dir1);

      consolidate(store, { threshold: 6, now: NOW });
      expect(store.get(sym.id)!.status).toBe("live"); // the scar-killer is untouched
      expect(store.get(dir1.id)!.status).toBe("live"); // the standing order is untouched
    } finally { rm(dir); }
  });

  it("a briefing carries the principle and NOT its retired members", () => {
    const { store, dir } = openStore();
    try {
      const members: Belief[] = [];
      for (let i = 0; i < 8; i++) { const b = cochange(i); members.push(b); store.mint(b); }
      const r = consolidate(store, { threshold: 6, now: NOW });
      const principleId = r.principles[0].principle;

      const brief = compileBriefing(store, "work on src/a.ts", 4000);
      expect(brief.text).toContain(principleId);
      for (const m of members) expect(brief.lines.some((l) => l.beliefId === m.id)).toBe(false);
    } finally { rm(dir); }
  });
});
