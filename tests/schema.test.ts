import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { Store } from "../src/store.js";
import { verifyStore } from "../src/integrity.js";
import { serializeBelief } from "../src/frontmatter.js";
import { idToFile } from "../src/id.js";
import { schemaIssues, FORMAT_VERSION } from "../src/schema.js";
import { assertBelief, LintError } from "../src/lint.js";
import { beliefsDir, ensureDir } from "../src/paths.js";
import { belief, gitRepo, rm } from "./helpers.js";
import type { Belief } from "../src/types.js";

// Phase 0a — the versioned, validated boundary. A darkened enum or a format from the
// future is STRUCTURAL corruption: `verify` flags it fatally and never advertises a
// re-sync as the cure, and the write boundary refuses it before it can be persisted.

describe("schema — versioned, validated boundary (Phase 0a)", () => {
  function loc(repo: string) { return { repo, store: join(repo, ".muster") }; }

  // A belief written to disk with one field mutated, id preserved.
  function writeRaw(l: { store: string }, b: Belief, mutate: (s: string) => string): void {
    ensureDir(beliefsDir(l));
    writeFileSync(join(beliefsDir(l), idToFile(b.id)), mutate(serializeBelief(b)), "utf8");
  }

  it("stamps the current format_version and round-trips it", () => {
    const repo = gitRepo([{ "a.ts": "export function f(){}\n" }]);
    try {
      const l = loc(repo);
      const b = belief({ claim: "x is defined" });
      writeRaw(l, b, (s) => s);
      const loaded = Store.open(l).get(b.id)!;
      expect(loaded.formatVersion).toBe(FORMAT_VERSION);
    } finally { rm(repo); }
  });

  it("a darkened status is a FATAL schema issue, not soft drift, and never says `sync`", () => {
    const repo = gitRepo([{ "a.ts": "export function f(){}\n" }]);
    try {
      const l = loc(repo);
      const b = belief({ claim: "x is defined" });
      writeRaw(l, b, (s) => s.replace("status: live", "status: undead"));
      const r = verifyStore(Store.open(l));
      const schema = r.issues.filter((i) => i.kind === "schema");
      expect(r.fatal).toBe(true);
      expect(schema.some((i) => /unknown status "undead"/.test(i.detail))).toBe(true);
      expect(schema.every((i) => !/sync/.test(i.detail))).toBe(true);
    } finally { rm(repo); }
  });

  it("a format_version from the future is fatal (a re-sync cannot read it)", () => {
    const repo = gitRepo([{ "a.ts": "export function f(){}\n" }]);
    try {
      const l = loc(repo);
      const b = belief({ claim: "x is defined" });
      writeRaw(l, b, (s) => s.replace(`format_version: ${FORMAT_VERSION}`, `format_version: ${FORMAT_VERSION + 9}`));
      const r = verifyStore(Store.open(l));
      expect(r.fatal).toBe(true);
      expect(r.issues.some((i) => i.kind === "schema" && /newer than this muster/.test(i.detail))).toBe(true);
    } finally { rm(repo); }
  });

  it("schemaIssues covers kind/status/watch/evidence/death; a clean belief is empty", () => {
    expect(schemaIssues(belief({ claim: "ok" }))).toEqual([]);
    expect(schemaIssues({ ...belief({ claim: "x" }), kind: "wat" as Belief["kind"] })).toHaveLength(1);
    expect(schemaIssues({ ...belief({ claim: "x" }), watch: [{ kind: "quantum" as never, target: "a@b", expect: "" }] })).toHaveLength(1);
  });

  it("the write boundary refuses a structurally-invalid belief", () => {
    const bad = { ...belief({ claim: "x" }), status: "zombie" as Belief["status"] };
    expect(() => assertBelief(bad)).toThrow(LintError);
  });

  it("verify still passes clean on a freshly-versioned store (no false schema issues)", () => {
    const repo = gitRepo([{ "a.ts": "export function f(){}\n" }]);
    try {
      const l = loc(repo);
      const b = belief({ claim: "x is defined" });
      Store.open(l).mint(b);
      const r = verifyStore(Store.open(l));
      expect(r.issues.filter((i) => i.kind === "schema")).toEqual([]);
    } finally { rm(repo); }
  });
});
