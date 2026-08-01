import { describe, it, expect } from "vitest";
import { Store } from "../src/store.js";
import { compileBriefing } from "../src/linker.js";
import { beliefId } from "../src/id.js";
import type { Belief } from "../src/types.js";

// Phase 3b (PERF-1) — the packer is O(atoms), not O(atoms²). A 4k-belief brief at 128k
// tokens took ~8.7s before; the running-total packer makes it linear. This is a coarse
// guard (generous bound to survive CI variance) that a quadratic regression would blow.

function bigStore(n: number): Store {
  const beliefs: Belief[] = [];
  for (let i = 0; i < n; i++) {
    const claim = `symbol sym${i} (function) is defined in src/mod${i % 50}.ts with descriptive text.`;
    const evidence = [{ kind: "file" as const, ref: `src/mod${i % 50}.ts`, note: "" }];
    beliefs.push({
      id: beliefId(claim, evidence), kind: "observed", status: "live", claim,
      subjects: [`src/mod${i % 50}.ts`, `sym${i}`], confidence: 0.8, method: "read-source",
      watch: [{ kind: "symbol", target: `sym${i}@src/mod${i % 50}.ts`, expect: "present" }],
      evidence, lineage: [], origin: "test", born: "2026-05-01T00:00:00.000Z",
      lastVerified: "2026-05-01T00:00:00.000Z", supersededBy: "", summary: `function sym${i}(a, b)`,
    });
  }
  return Store.fromBeliefs({ repo: "/x", store: "/x/.muster" }, beliefs);
}

describe("packer is linear-time and budget-adherent at scale", () => {
  const store = bigStore(4000);
  const task = "refactor src/mod0.ts and src/mod1.ts touching sym0 sym1 sym50 sym51";

  it("compiles a 128k briefing on a 4k-belief store well under the old quadratic time", () => {
    const t = performance.now();
    const b = compileBriefing(store, task, 128_000);
    const ms = performance.now() - t;
    expect(b.used).toBeLessThanOrEqual(128_000);
    expect(ms).toBeLessThan(2000); // the old O(n²) packer took ~8.7s here
  });

  it("stays budget-monotone at scale (128k brief ⊇ 8k brief)", () => {
    const small = new Set(compileBriefing(store, task, 8_000).lines.map((l) => l.beliefId));
    const big = new Set(compileBriefing(store, task, 128_000).lines.map((l) => l.beliefId));
    for (const id of small) expect(big.has(id)).toBe(true);
  });
});
