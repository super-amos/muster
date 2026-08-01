import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ingestGit } from "../src/ingest.js";
import { gitRepo, rm } from "./helpers.js";

// test-topology maps a test to the source it exercises. The directory heuristics miss a
// flat tests/ dir sitting over a nested src/ tree — the unique-basename fallback recovers
// it, but must refuse when the name is ambiguous rather than guess wrong.
describe("ingest test-topology — unique-basename fallback (flat tests, nested src)", () => {
  const link = (repo: string): string[] => {
    const loc = { repo, store: join(repo, ".muster") };
    const store = Store.open(loc);
    ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
    return store.all()
      .filter((b) => b.method === "test-topology")
      .map((b) => b.claim);
  };

  it("links tests/foo.test.ts → src/engine/foo.ts across the tree", () => {
    const repo = gitRepo([{
      "tests/arbiter.test.ts": `import { arbitrate } from "../src/engine/arbiter.js";\ntest("x", () => arbitrate());\n`,
      "src/engine/arbiter.ts": `export function arbitrate() { return 1; }\n`,
    }]);
    try {
      const claims = link(repo);
      expect(claims.some((c) => c.includes("tests/arbiter.test.ts") && c.includes("src/engine/arbiter.ts"))).toBe(true);
    } finally { rm(repo); }
  });

  it("refuses to link when the basename is ambiguous (two candidate sources)", () => {
    const repo = gitRepo([{
      "tests/arbiter.test.ts": `test("x", () => {});\n`,
      "src/engine/arbiter.ts": `export function a() { return 1; }\n`,
      "src/other/arbiter.ts": `export function b() { return 2; }\n`,
    }]);
    try {
      const claims = link(repo);
      // ambiguous → no test-topology belief for arbiter at all (never a wrong guess)
      expect(claims.some((c) => c.includes("tests/arbiter.test.ts"))).toBe(false);
    } finally { rm(repo); }
  });

  it("does not attribute one test file to another test with the same stem", () => {
    const repo = gitRepo([{
      "tests/foo.test.ts": `test("x", () => {});\n`,
      "tests/helpers/foo.test.ts": `test("y", () => {});\n`,
    }]);
    try {
      const claims = link(repo);
      // no non-test source named foo.ts exists → nothing to link, and never test↔test
      expect(claims.length).toBe(0);
    } finally { rm(repo); }
  });
});
