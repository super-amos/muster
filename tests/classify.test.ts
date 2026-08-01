import { describe, it, expect } from "vitest";
import { Store } from "../src/store.js";
import { compileBriefing } from "../src/linker.js";
import { belief } from "./helpers.js";

const LOC = { repo: "/tmp/x", store: "/tmp/x/.muster" };

// Every `tell` fact and every extraction is minted with a 180-day expire watch. The journal
// head here is 2026-05-01, so a horizon 180 days out is "distant" and one 14 days out is "soon".
const REF = "2026-05-01T12:00:00.000Z";
function told(claim: string, subjects: string[], expireTarget: string) {
  return belief({
    claim,
    subjects,
    kind: "told",
    method: "user-told",
    confidence: 0.7,
    watch: [{ kind: "expire", target: expireTarget, expect: "" }],
    evidence: [{ kind: "session", ref: "sess#1", note: "2026-05-01" }],
    born: REF,
    lastVerified: REF,
  });
}

// COR-3 — "carries an expire watch" was conflated with "expiring soon," so the user's own
// hand-entered knowledge (and the sanctioned two-source promotion) briefed under §7 "verify
// before you trust" for its whole 180-day life instead of §4 THE SITUATION.
describe("COR-3: an expire watch is a §7 caution only when its horizon is near the journal head", () => {
  it("a told fact with a distant (180-day) horizon briefs in §4 THE SITUATION, not §7", () => {
    const b = told("`issueToken` mints a 15-minute JWT.", ["src/auth/token.ts", "issueToken"], "2026-10-28T12:00:00.000Z");
    const store = Store.fromBeliefs(LOC, [b]);
    const brief = compileBriefing(store, "work on issueToken in src/auth/token.ts", 4000);
    const line = brief.lines.find((l) => l.beliefId === b.id);
    expect(line?.section).toBe("situation"); // was "cautions" before the fix
  });

  it("a told fact whose horizon is within 30 days of the journal head still briefs in §7", () => {
    const b = told("`legacyFlag` is deprecated soon.", ["src/auth/token.ts", "legacyFlag"], "2026-05-15T12:00:00.000Z");
    const store = Store.fromBeliefs(LOC, [b]);
    const brief = compileBriefing(store, "work on legacyFlag in src/auth/token.ts", 4000);
    const line = brief.lines.find((l) => l.beliefId === b.id);
    expect(line?.section).toBe("cautions"); // genuinely expiring → verify before you trust
  });

  it("determinism holds: the same store/task/budget compiles byte-identically", () => {
    const b = told("`issueToken` mints a 15-minute JWT.", ["src/auth/token.ts", "issueToken"], "2026-10-28T12:00:00.000Z");
    const store = Store.fromBeliefs(LOC, [b]);
    const a = compileBriefing(store, "work on issueToken in src/auth/token.ts", 4000).text;
    const c = compileBriefing(store, "work on issueToken in src/auth/token.ts", 4000).text;
    expect(a).toBe(c);
  });
});
