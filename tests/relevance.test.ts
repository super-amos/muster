import { describe, it, expect } from "vitest";
import { Store } from "../src/store.js";
import { compileBriefing } from "../src/linker.js";
import { belief } from "./helpers.js";

const LOC = { repo: "/tmp/x", store: "/tmp/x/.muster" };

// A read-source symbol belief with a signature summary — the shape ingest mints.
function sym(name: string, file: string, signature: string) {
  return belief({
    claim: `\`${name}\` (function) is defined in \`${file}\`.`,
    subjects: [file, name],
    method: "read-source",
    confidence: 0.8,
    watch: [{ kind: "symbol", target: `${name}@${file}`, expect: "present" }],
    evidence: [{ kind: "file", ref: file, note: `def ${name}` }],
    summary: signature,
  });
}

describe("read path — exported surface outranks a private helper", () => {
  it("puts the public API line above the internal one at equal relevance", () => {
    const store = Store.fromBeliefs(LOC, [
      sym("issueToken", "src/x.ts", "export function issueToken(u: string): string"),
      sym("signPayload", "src/x.ts", "function signPayload(p: string): string"),
    ]);
    // The task names both symbols and the file — identical direct relevance, so the
    // only tiebreak is the surface weight (exported > unmarked).
    const brief = compileBriefing(store, "work on issueToken and signPayload in src/x.ts", 4000);
    const iA = brief.text.indexOf("issueToken");
    const iB = brief.text.indexOf("signPayload");
    expect(iA).toBeGreaterThanOrEqual(0);
    expect(iB).toBeGreaterThanOrEqual(0);
    expect(iA).toBeLessThan(iB); // the exported definition leads
  });
});

describe("read path — the co-change blast radius pulls in a coupled file", () => {
  const symA = sym("funcApple", "src/a.ts", "export function funcApple(): number");
  const symB = sym("funcBanana", "src/b.ts", "export function funcBanana(): number");
  const cochange = belief({
    claim: "`src/a.ts` and `src/b.ts` change together — edits to one usually need the other (5×).",
    subjects: ["src/a.ts", "src/b.ts", "src", "src"],
    kind: "inferred",
    method: "git-cochange",
    confidence: 0.6,
    watch: [{ kind: "path", target: "src/a.ts", expect: "present" }, { kind: "path", target: "src/b.ts", expect: "present" }],
    evidence: [{ kind: "file", ref: "src/a.ts", note: "co-changed with src/b.ts 5×" }],
  });
  const TASK = "edit funcApple in src/a.ts";

  it("surfaces a belief about a co-changing file the task never named", () => {
    const store = Store.fromBeliefs(LOC, [symA, symB, cochange]);
    const brief = compileBriefing(store, TASK, 2000);
    expect(brief.text).toContain("funcBanana"); // b.ts is in a.ts's blast radius
  });

  it("does NOT surface that file when there is no co-change coupling", () => {
    const store = Store.fromBeliefs(LOC, [symA, symB]); // same beliefs, no edge
    const brief = compileBriefing(store, TASK, 2000);
    expect(brief.text).not.toContain("funcBanana"); // unrelated → stays out
  });
});

describe("read path — the new weights preserve budget-monotonicity", () => {
  it("a smaller briefing is a subset of a larger one", () => {
    const store = Store.fromBeliefs(LOC, [
      sym("issueToken", "src/x.ts", "export function issueToken(u: string): string"),
      sym("signPayload", "src/x.ts", "function signPayload(p: string): string"),
      sym("verifyToken", "src/x.ts", "export function verifyToken(t: string): boolean"),
    ]);
    const task = "work on issueToken, verifyToken and signPayload in src/x.ts";
    const small = new Set(compileBriefing(store, task, 300).lines.map((l) => l.beliefId));
    const big = new Set(compileBriefing(store, task, 4000).lines.map((l) => l.beliefId));
    for (const id of small) expect(big.has(id)).toBe(true);
  });
});
