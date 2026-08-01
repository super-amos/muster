import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { cmdTell } from "../src/verbs.js";
import { mkTmp, rm } from "./helpers.js";

// tell safety: the directive-vs-fact classification is a footgun when it is silent.
// A passing "must" in an otherwise ordinary fact must not mint an ETERNAL standing order
// without saying so, and the user must have an explicit override to keep a fact mortal.
describe("tell — directive auto-promotion is loud and overridable (--fact)", () => {
  const withStore = async (fn: (loc: { repo: string; store: string }) => Promise<void>) => {
    const tmp = mkTmp();
    const loc = { repo: tmp, store: join(tmp, ".muster") };
    try { await fn(loc); } finally { rm(loc.repo); }
  };
  const idOf = (out: string) => out.match(/→ (e:[0-9a-f]+)/)![1];

  it("a plain fact stays mortal — kind 'told', with an expire watch", async () => {
    await withStore(async (loc) => {
      const out = await cmdTell({ ...loc, text: "`issueToken` lives in src/auth/token.ts." });
      expect(out).toContain("mortal");
      expect(out).not.toContain("auto-promoted");
      const b = Store.open(loc).get(idOf(out))!;
      expect(b.kind).toBe("told");
      expect(b.watch.some((w) => w.kind === "expire")).toBe(true);
    });
  });

  it("directive wording auto-promotes to an eternal directive — and SAYS so", async () => {
    await withStore(async (loc) => {
      const out = await cmdTell({ ...loc, text: "always run the tests before pushing" });
      expect(out).toContain("auto-promoted");
      expect(out).toContain("--fact"); // the override is advertised
      const b = Store.open(loc).get(idOf(out))!;
      expect(b.kind).toBe("directive");
      expect(b.watch).toHaveLength(0); // eternal — no way to die but `deny`
    });
  });

  it("--fact forces a mortal fact even when the wording reads like a directive", async () => {
    await withStore(async (loc) => {
      const out = await cmdTell({ ...loc, text: "you must pass a budget to brief", fact: true });
      expect(out).toContain("mortal");
      expect(out).not.toContain("auto-promoted"); // the override suppresses the promotion
      const b = Store.open(loc).get(idOf(out))!;
      expect(b.kind).toBe("told");
      expect(b.watch.some((w) => w.kind === "expire")).toBe(true);
    });
  });

  it("an explicit --directive is NOT reported as an auto-promotion (the user asked for it)", async () => {
    await withStore(async (loc) => {
      const out = await cmdTell({ ...loc, text: "deploys go through staging first", directive: true });
      expect(out).not.toContain("auto-promoted");
      const b = Store.open(loc).get(idOf(out))!;
      expect(b.kind).toBe("directive");
      expect(b.watch).toHaveLength(0);
    });
  });

  it("--fact wins over --directive (the explicit keep-mortal override is decisive)", async () => {
    await withStore(async (loc) => {
      const out = await cmdTell({ ...loc, text: "always brief before grepping", directive: true, fact: true });
      const b = Store.open(loc).get(idOf(out))!;
      expect(b.kind).toBe("told");
      expect(b.watch.some((w) => w.kind === "expire")).toBe(true);
    });
  });
});
