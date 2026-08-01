import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { Store } from "../src/store.js";
import { ingestGit } from "../src/ingest.js";
import { sweep, evalWatch } from "../src/watch.js";
import { readTraces } from "../src/journal.js";
import { verifyStore } from "../src/integrity.js";
import { cmdWhy } from "../src/verbs.js";
import { splitSymbolTarget } from "../src/symbols.js";
import { journalPath, ensureDir } from "../src/paths.js";
import { gitRepo, rm } from "./helpers.js";

// Phase 1d — the read path degrades, never crashes. A shapeless journal line, a watch
// target that is a directory or a permission-error, and a scoped-path symbol name are all
// survivable: they drop, demote to stale, or parse correctly — they never throw.

describe("readTraces / why tolerate a shapeless journal line (TYP-1)", () => {
  it("drops a ts-less line and `why` still renders", () => {
    const repo = gitRepo([{ "a.ts": "export function f(){}\n" }]);
    const loc = { repo, store: join(repo, ".muster") };
    try {
      const store = Store.open(loc);
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
      const id = store.all()[0].id;

      // Poison the journal with a JSON line that parses but has no `ts`.
      ensureDir(join(loc.store));
      appendFileSync(journalPath(loc), JSON.stringify({ kind: "noise", subject: id }) + "\n", "utf8");

      expect(() => readTraces(loc)).not.toThrow();
      expect(readTraces(loc).every((t) => typeof t.ts === "string" && t.ts.length > 0)).toBe(true);
      expect(() => cmdWhy({ repo, store: loc.store, id })).not.toThrow();
    } finally { rm(repo); }
  });
});

describe("evalWatch never aborts the sweep on an inconclusive read (ERR-2)", () => {
  it("a symbol watch whose path is a DIRECTORY demotes to stale, not dead, and never throws", () => {
    const repo = gitRepo([{ "keep.ts": "export function keep(){}\n" }]);
    try {
      // Make the watched 'file' actually a directory → readFileSync throws EISDIR.
      mkdirSync(join(repo, "asdir"), { recursive: true });
      const res = evalWatch(repo, { kind: "symbol", target: "Foo@asdir", expect: "present" }, new Date());
      expect(res.fired).toBe(true);
      expect(res.fate).toBe("stale"); // inconclusive, NOT a forged tombstone
    } catch {
      throw new Error("evalWatch threw on an inconclusive read");
    } finally { rm(repo); }
  });

  it("a whole sweep + verify survive a belief whose watch target became a directory", () => {
    const repo = gitRepo([{ "a.ts": "export function f(){}\n" }]);
    const loc = { repo, store: join(repo, ".muster") };
    try {
      const store = Store.open(loc);
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
      // Replace the watched file with a directory of the same name.
      rm(join(repo, "a.ts"));
      mkdirSync(join(repo, "a.ts"), { recursive: true });
      expect(() => sweep(store)).not.toThrow();
      expect(() => verifyStore(Store.open(loc))).not.toThrow();
    } finally { rm(repo); }
  });
});

describe("symbol targets split on the FIRST @ (COR-3)", () => {
  it("keeps a scoped path intact instead of false-tombstoning", () => {
    expect(splitSymbolTarget("Login@app/@auth/page.ts")).toEqual({ name: "Login", file: "app/@auth/page.ts" });
    expect(splitSymbolTarget("plainName@src/x.ts")).toEqual({ name: "plainName", file: "src/x.ts" });
    expect(splitSymbolTarget("noAtSign")).toEqual({ name: "noAtSign", file: "" });
  });

  it("evaluates a symbol watch against the correct scoped file (present → not fired)", () => {
    const repo = gitRepo([{ "app/@auth/page.ts": "export function Login(){}\n" }]);
    try {
      const res = evalWatch(repo, { kind: "symbol", target: "Login@app/@auth/page.ts", expect: "present" }, new Date());
      expect(res.fired).toBe(false); // the symbol IS defined in the scoped path
    } finally { rm(repo); }
  });
});
