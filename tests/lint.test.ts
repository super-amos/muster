import { describe, it, expect } from "vitest";
import { lintBelief } from "../src/lint.js";
import { belief } from "./helpers.js";

describe("the constitution — NO IMMORTAL BELIEFS", () => {
  it("accepts a well-formed mortal belief", () => {
    expect(lintBelief(belief({ claim: "X is defined in a.ts" }))).toEqual([]);
  });

  it("rejects a non-directive with no watch (an immortal belief)", () => {
    const b = belief({ claim: "eternal fact", watch: [] });
    expect(lintBelief(b).join(" ")).toMatch(/immortal/);
  });

  it("rejects a belief with no evidence (a rumor)", () => {
    const b = belief({ claim: "hearsay", evidence: [] });
    expect(lintBelief(b).join(" ")).toMatch(/no evidence/);
  });

  it("allows a directive to be eternal (no watch)", () => {
    const b = belief({ claim: "always run tests", kind: "directive", watch: [], evidence: [{ kind: "told", ref: "user", note: "" }] });
    expect(lintBelief(b)).toEqual([]);
  });

  it("rejects a directive that carries a mortal (content) watch", () => {
    const b = belief({ claim: "always run tests", kind: "directive", watch: [{ kind: "blob", target: "x", expect: "h" }], evidence: [{ kind: "told", ref: "user", note: "" }] });
    expect(lintBelief(b).join(" ")).toMatch(/must not decay/);
  });

  it("rejects a malformed symbol watch (not name@path)", () => {
    const b = belief({ claim: "sym", watch: [{ kind: "symbol", target: "justAName", expect: "present" }] });
    expect(lintBelief(b).join(" ")).toMatch(/name@path/);
  });

  it("rejects an out-of-range confidence", () => {
    expect(lintBelief(belief({ claim: "x", confidence: 1.5 })).join(" ")).toMatch(/confidence/);
  });
});
