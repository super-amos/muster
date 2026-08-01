import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ingestGit } from "../src/ingest.js";
import { compileBriefing } from "../src/linker.js";
import { cmdTell } from "../src/verbs.js";
import { gitRepo, rm, belief } from "./helpers.js";
import type { Belief, BriefLine } from "../src/types.js";

// A repo with several files that co-change and enough symbols to force omission at
// small budgets — the substrate the linker's guarantees are proved against.
async function buildStore(): Promise<{ store: Store; repo: string }> {
  const repo = gitRepo([
    { "src/auth/token.ts": "export function issueToken(){}\nexport function verifyToken(){}\n", "src/auth/session.ts": "export function openSession(){}\n" },
    { "src/auth/token.ts": "export function issueToken(){}\nexport function verifyToken(){}\nexport function rotateToken(){}\n", "src/auth/session.ts": "export function openSession(){}\nexport function closeSession(){}\n" },
    { "src/db/pool.ts": "export function getPool(){}\nexport function endPool(){}\n" },
  ]);
  const loc = { repo, store: join(repo, ".muster") };
  const store = Store.open(loc);
  ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
  await cmdTell({ repo, store: loc.store, text: "Always run the tests before pushing." });
  return { store: Store.open(loc), repo };
}

const TASK = "refactor token issuance in src/auth/token.ts, touch verifyToken and rotateToken";
const BUDGETS = [250, 500, 1000, 2000, 4000];

describe("the linker — deterministic, budget-monotone, budget-adherent", () => {
  let store: Store;
  let repo: string;
  beforeAll(async () => { ({ store, repo } = await buildStore()); });
  afterAll(() => { rm(repo); });

  it("is byte-reproducible across 100 compiles of the same (store, task, budget)", () => {
    const first = compileBriefing(store, TASK, 1000).text;
    for (let i = 0; i < 100; i++) {
      expect(compileBriefing(store, TASK, 1000).text).toBe(first);
    }
  });

  it("never exceeds the token budget (100% adherence)", () => {
    for (const b of BUDGETS) {
      expect(compileBriefing(store, TASK, b).used).toBeLessThanOrEqual(b);
    }
  });

  it("is budget-monotone: a bigger budget only ADDS beliefs and RAISES altitude", () => {
    const plans = BUDGETS.map((b) => new Map(compileBriefing(store, TASK, b).lines.map((l: BriefLine) => [l.beliefId, l.altitude])));
    for (let i = 1; i < plans.length; i++) {
      for (const [id, alt] of plans[i - 1]) {
        expect(plans[i].has(id)).toBe(true); // inclusion monotone
        expect(plans[i].get(id)! >= alt).toBe(true); // altitude monotone (never coarser)
      }
    }
  });

  it("always briefs directives first, regardless of task or budget", () => {
    const brief = compileBriefing(store, "something totally unrelated", 1000);
    expect(brief.text).toContain("STANDING ORDERS");
    expect(brief.text).toContain("Always run the tests before pushing");
    expect(brief.text.indexOf("STANDING ORDERS")).toBeLessThan(brief.text.indexOf("HOW TO READ THIS"));
  });

  it("ranks a directly-named file into THE SITUATION", () => {
    const brief = compileBriefing(store, TASK, 2000);
    expect(brief.text).toContain("THE SITUATION");
    expect(brief.text).toContain("issueToken");
  });
});

// Pure-store tests (no git) that isolate classification and packing invariants.
describe("the linker — classification & packing (in-memory)", () => {
  const LOC = { repo: "/none", store: "/none" };

  it("briefs a live belief as truth but never a dead one as truth", () => {
    const live = belief({ claim: "`issueToken` is defined in `auth.ts`", subjects: ["auth.ts", "issueToken"] });
    const dead: Belief = belief({
      claim: "`oldHelper` is defined in `auth.ts`", subjects: ["auth.ts", "oldHelper"], status: "dead",
      watch: [{ kind: "symbol", target: "oldHelper@auth.ts", expect: "present" }],
      tombstone: { death: "falsified", at: "2026-06-01T00:00:00.000Z", by: "abc1234", note: "`oldHelper` was removed (commit abc1234). Do not call it." },
    });
    const store = Store.fromBeliefs(LOC, [live, dead]);
    const brief = compileBriefing(store, "work on auth.ts issueToken and oldHelper", 2000);
    expect(brief.text).toContain("issueToken");
    // The ghost never briefs as a live definition…
    expect(brief.text).not.toContain("`oldHelper` is defined");
    // …but its corpse briefs as a tripwire.
    expect(brief.text).toContain("TRIPWIRES");
    expect(brief.text).toMatch(/⛔.*oldHelper.*removed/);
  });

  it("never exceeds the budget even with 200 competing beliefs", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      belief({ claim: `fact ${i} concerning the auth subsystem and its tokens`, subjects: ["auth.ts"], evidence: [{ kind: "file", ref: `f${i}.ts`, note: "" }] }));
    const store = Store.fromBeliefs(LOC, many);
    for (const budget of [300, 800, 2000]) {
      expect(compileBriefing(store, "auth.ts tokens", budget).used).toBeLessThanOrEqual(budget);
    }
  });
});
