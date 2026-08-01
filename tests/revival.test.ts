import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { cmdTell, cmdDeny } from "../src/verbs.js";
import { privateLoc } from "../src/paths.js";
import { belief, mkTmp, rm } from "./helpers.js";
import type { Belief, DeathKind } from "../src/types.js";

// Phase 1a — a plain `sync` re-mints live symbol beliefs; it must NOT resurrect one that
// metabolism or the user already adjudicated (COR-1). The scar still heals (a falsified
// belief revives when its symbol returns); a superseded/retired/denied one stays buried
// with its forwarding address intact.

describe("revival guard — sync must not revert metabolize (Phase 1a)", () => {
  function freshStore(): { store: Store; loc: { repo: string; store: string } } {
    const tmp = mkTmp();
    const loc = { repo: tmp, store: join(tmp, ".muster") };
    return { store: Store.open(loc), loc };
  }

  // Seed a live belief, drive it into `state`, then re-mint the same content as `sync`
  // would, re-open from disk, and return the re-read belief.
  function afterReMint(state: Partial<Belief>): Belief {
    const { store, loc } = freshStore();
    try {
      const b = belief({ claim: "`X` is defined in `a.ts`.", watch: [{ kind: "symbol", target: "X@a.ts", expect: "present" }] });
      store.mint(b);
      const adjudicated = { ...store.get(b.id)!, ...state };
      store.persist(adjudicated);
      store.mint({ ...b, status: "live" }); // a plain sync re-mints the same id, live
      return Store.open(loc).get(b.id)!;
    } finally { rm(loc.repo); }
  }

  const tomb = (death: DeathKind): Belief["tombstone"] =>
    ({ death, at: "2026-06-01T00:00:00.000Z", by: "e:newer0000000", note: "adjudicated" });

  it("does not revive a superseded belief; forwarding address survives", () => {
    const after = afterReMint({ status: "superseded", supersededBy: "e:newer0000000", tombstone: tomb("superseded") });
    expect(after.status).toBe("superseded");
    expect(after.supersededBy).toBe("e:newer0000000");
  });

  it("does not revive a retired (consolidated) member; it stays folded into its principle", () => {
    const after = afterReMint({ status: "retired", supersededBy: "e:principle00000", tombstone: tomb("consolidated") });
    expect(after.status).toBe("retired");
    expect(after.supersededBy).toBe("e:principle00000");
  });

  it("does not revive a denied belief (the user is the highest court)", () => {
    const after = afterReMint({ status: "dead", tombstone: tomb("executed") });
    expect(after.status).toBe("dead");
    expect(after.tombstone?.death).toBe("executed");
  });

  it("STILL revives a falsified belief when its symbol returns (the scar heals)", () => {
    const after = afterReMint({ status: "dead", tombstone: tomb("falsified") });
    expect(after.status).toBe("live");
    expect(after.tombstone).toBeUndefined();
  });

  it("does not raise a terminal belief's confidence on re-observation (Math.max is skipped)", () => {
    const { store, loc } = freshStore();
    try {
      const b = belief({ claim: "`Y` is defined in `a.ts`.", confidence: 0.4, watch: [{ kind: "symbol", target: "Y@a.ts", expect: "present" }] });
      store.mint(b);
      store.persist({ ...store.get(b.id)!, status: "superseded", supersededBy: "e:z", tombstone: tomb("superseded") });
      store.mint({ ...b, status: "live", confidence: 0.99 });
      expect(Store.open(loc).get(b.id)!.confidence).toBe(0.4);
    } finally { rm(loc.repo); }
  });
});

describe("deny reaches a --private belief (Phase 1a, missed #2)", () => {
  it("the highest court can kill a belief that lives only in the private overlay", async () => {
    const tmp = mkTmp();
    const loc = { repo: tmp, store: join(tmp, ".muster") };
    try {
      const out = await cmdTell({ repo: loc.repo, store: loc.store, text: "`localOnly` lives in scratch.ts and is mine.", private: true });
      const id = out.match(/→ (e:[0-9a-f]+)/)![1];
      // it lives ONLY in the private store, not the team store
      expect(Store.open(loc).get(id)).toBeUndefined();
      expect(Store.open(privateLoc(loc)).get(id)).toBeTruthy();

      const denied = await cmdDeny({ repo: loc.repo, store: loc.store, id, reason: "wrong" });
      expect(denied).toContain("denied and tombstoned");
      const b = Store.open(privateLoc(loc)).get(id)!;
      expect(b.status).toBe("dead");
      expect(b.tombstone?.death).toBe("executed");
    } finally { rm(loc.repo); }
  });
});
