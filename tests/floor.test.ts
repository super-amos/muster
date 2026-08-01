import { describe, it, expect } from "vitest";
import { Store } from "../src/store.js";
import { compileBriefing } from "../src/linker.js";
import { belief } from "./helpers.js";
import type { Belief } from "../src/types.js";

// Phase 3b / missed #1 (safety-grade) — a tripwire or standing order that does not fit the
// budget must be COUNTED as held back, never silently dropped while the footer claims "0".

describe("mandatory beliefs are never silently dropped below the budget floor", () => {
  const loc = { repo: "/tmp/x", store: "/tmp/x/.muster" };

  function directives(n: number): Belief[] {
    return Array.from({ length: n }, (_, i) =>
      belief({
        claim: `Always run the full pre-deploy checklist number ${i} through staging before production.`,
        kind: "directive",
        watch: [],
        evidence: [{ kind: "told", ref: `user@2026-06-0${i}`, note: "" }],
      }),
    );
  }

  it("counts dropped standing orders in omitted (footer can't claim completeness)", () => {
    const store = Store.fromBeliefs(loc, directives(8));
    const b = compileBriefing(store, "deploy the service", 120); // too small to fit all 8
    expect(b.used).toBeLessThanOrEqual(120); // budget adherence still holds
    expect(b.mandatoryOmitted).toBeGreaterThan(0); // some standing orders did not fit
    expect(b.omitted).toBe(b.mandatoryOmitted); // and they ARE counted (no optional here)
  });

  it("with a generous budget, nothing mandatory is held back", () => {
    const store = Store.fromBeliefs(loc, directives(8));
    const b = compileBriefing(store, "deploy the service", 4000);
    expect(b.mandatoryOmitted).toBe(0);
  });

  it("shown + omitted accounts for every mandatory belief", () => {
    const all = directives(8);
    const store = Store.fromBeliefs(loc, all);
    const b = compileBriefing(store, "deploy the service", 120);
    const shownMandatory = b.lines.filter((l) => l.section === "standing_orders").length;
    expect(shownMandatory + b.mandatoryOmitted).toBe(all.length);
  });
});
