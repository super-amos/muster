import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ingestGit } from "../src/ingest.js";
import { sweep } from "../src/watch.js";
import { metabolize } from "../src/metabolize.js";
import { verifyStore } from "../src/integrity.js";
import { disabledLlm } from "../src/llm.js";
import { gitRepo, rm } from "./helpers.js";

// A repo with 8 source files in one directory — enough file-orientation beliefs for
// consolidation to fire — each exporting a symbol so the scar-killers are present too.
function eightFileRepo(): string {
  const snap: Record<string, string> = {};
  for (let i = 0; i < 8; i++) snap[`src/f${i}.ts`] = `export function f${i}(){ return ${i}; }\n`;
  return gitRepo([snap]);
}

function sync(repo: string): { store: Store; loc: { repo: string; store: string } } {
  const loc = { repo, store: join(repo, ".muster") };
  const store = Store.open(loc);
  ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
  sweep(store);
  return { store, loc };
}

describe("metabolize — the fenced orchestrator runs fully in degraded mode", () => {
  it("promotes/reconciles/consolidates with NO model, and consolidation shrinks the live set", async () => {
    const repo = eightFileRepo();
    try {
      const { store } = sync(repo);
      const liveBefore = store.all().filter((b) => b.status === "live").length;

      const r = await metabolize(store, { llm: disabledLlm });
      expect(r.model).toBe("disabled"); // the whole run was mechanical
      expect(r.consolidate.principles.length).toBeGreaterThanOrEqual(1);
      expect(r.liveAfter).toBeLessThan(r.liveBefore);
      expect(r.liveBefore).toBe(liveBefore);

      // The scar-killers survive consolidation: every symbol belief is still live.
      const symbols = store.all().filter((b) => b.method === "read-source");
      expect(symbols.length).toBe(8);
      expect(symbols.every((b) => b.status === "live")).toBe(true);
    } finally { rm(repo); }
  });

  it("is convergent: a second metabolize is a no-op", async () => {
    const repo = eightFileRepo();
    try {
      const { store } = sync(repo);
      await metabolize(store, { llm: disabledLlm });
      const mid = store.all().filter((b) => b.status === "live").length;
      const r2 = await metabolize(store, { llm: disabledLlm });
      expect(r2.liveBefore).toBe(mid);
      expect(r2.liveAfter).toBe(mid);
      expect(r2.consolidate.retired).toBe(0);
    } finally { rm(repo); }
  });

  it("a metabolized store still verifies clean — no tamper, no drift, no constitution breach", async () => {
    const repo = eightFileRepo();
    try {
      const { store, loc } = sync(repo);
      await metabolize(store, { llm: disabledLlm });

      const v = verifyStore(Store.open(loc));
      expect(v.fatal).toBe(false);
      expect(v.issues.filter((i) => i.kind === "id-mismatch")).toEqual([]);
      expect(v.issues.filter((i) => i.kind === "constitution")).toEqual([]);
      expect(v.issues.filter((i) => i.kind === "drift")).toEqual([]);
    } finally { rm(repo); }
  });
});
