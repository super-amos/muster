import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { definesSymbol, yieldsAnySymbol, hasCode } from "../src/symbols.js";
import { evalWatch } from "../src/watch.js";
import { gitRepo, rm } from "./helpers.js";

// Phase 3c — extraction and death-detection see the SAME code-only view. A definition
// shape inside a comment or a string is not a definition (COR-2); and a symbol's absence
// is only a tombstone when the file demonstrably parses (item 17).

describe("scan() is comment/string aware (COR-2)", () => {
  it("a definition-shape inside a comment does not count as defined", () => {
    expect(definesSymbol("// export function ghost(){}\n", "ghost", ".ts")).toBe(false);
    expect(definesSymbol("/* export function ghost(){} */\n", "ghost", ".ts")).toBe(false);
  });

  it("a definition-shape inside a string literal does not count as defined", () => {
    expect(definesSymbol('const doc = "export function ghost() {}";\n', "ghost", ".ts")).toBe(false);
  });

  it("a real, uncommented definition still counts", () => {
    expect(definesSymbol("export function real(){}\n", "real", ".ts")).toBe(true);
  });

  it("a Python docstring mentioning a def does not mint a symbol", () => {
    expect(definesSymbol('def real():\n    """see def ghost() for details"""\n    pass\n', "ghost", ".py")).toBe(false);
    expect(definesSymbol('def real():\n    pass\n', "real", ".py")).toBe(true);
  });
});

describe("uncertainty predicate — real absence vs scanner-blind (item 17)", () => {
  function watch(repo: string, target: string) {
    return evalWatch(repo, { kind: "symbol", target, expect: "present" }, new Date());
  }

  it("falsifies HARD when the file still yields other symbols (the scar)", () => {
    const repo = gitRepo([{ "x.ts": "export function other(){}\n" }]);
    try {
      const r = watch(repo, "Foo@x.ts");
      expect(r.fired).toBe(true);
      expect(r.fate).toBe("dead"); // scanner can read the file; Foo is genuinely gone
    } finally { rm(repo); }
  });

  it("falsifies HARD when the file is reduced to only comments (genuinely gone)", () => {
    const repo = gitRepo([{ "x.ts": "// Foo was here\n" }]);
    try {
      const r = watch(repo, "Foo@x.ts");
      expect(r.fate).toBe("dead");
    } finally { rm(repo); }
  });

  it("demotes to STALE for a non-empty file the scanner cannot parse (reformat)", () => {
    const repo = gitRepo([{ "x.ts": "if (cond) { doThing(); returnValue(); }\n" }]);
    try {
      expect(hasCode("if (cond) { doThing(); }", ".ts")).toBe(true);
      expect(yieldsAnySymbol("if (cond) { doThing(); }", ".ts")).toBe(false);
      const r = watch(repo, "Foo@x.ts");
      expect(r.fired).toBe(true);
      expect(r.fate).toBe("stale"); // inconclusive — do not forge a tombstone
    } finally { rm(repo); }
  });
});
