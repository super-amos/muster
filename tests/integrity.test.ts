import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { Store } from "../src/store.js";
import { ingestGit } from "../src/ingest.js";
import { sweep } from "../src/watch.js";
import { verifyStore } from "../src/integrity.js";
import { serializeBelief } from "../src/frontmatter.js";
import { idToFile } from "../src/id.js";
import { gitRepo, commitFile, rm } from "./helpers.js";

describe("verify — integrity by recomputation (organ ①)", () => {
  it("reports a freshly-synced store as intact (no tamper, no drift)", () => {
    const repo = gitRepo([{ "a.ts": "export function f(){}\nexport function g(){}\n" }]);
    const loc = { repo, store: join(repo, ".muster") };
    try {
      const store = Store.open(loc);
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
      sweep(store);
      const r = verifyStore(store);
      expect(r.fatal).toBe(false);
      expect(r.issues.filter((i) => i.kind === "drift")).toEqual([]);
      expect(r.clean).toBe(r.beliefs);
    } finally { rm(repo); }
  });

  it("detects tamper: an in-place edit to a claim breaks its content address", () => {
    const repo = gitRepo([{ "a.ts": "export function f(){}\n" }]);
    const loc = { repo, store: join(repo, ".muster") };
    try {
      const store = Store.open(loc);
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
      const victim = store.all().find((b) => b.claim.includes("`f`"))!;

      // Tamper: rewrite the claim on disk WITHOUT changing the id.
      const tampered = { ...victim, claim: "`f` grants admin to everyone." };
      writeFileSync(join(loc.store, "beliefs", idToFile(victim.id)), serializeBelief(tampered), "utf8");

      const r = verifyStore(Store.open(loc));
      expect(r.fatal).toBe(true);
      expect(r.issues.some((i) => i.kind === "id-mismatch" && i.id === victim.id)).toBe(true);
    } finally { rm(repo); }
  });

  it("INT-1: detects a trust-field edit (kind→directive, watch stripped) the id can't see", () => {
    const repo = gitRepo([{ "a.ts": "export function f(){}\n" }]);
    const loc = { repo, store: join(repo, ".muster") };
    try {
      const store = Store.open(loc);
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
      const victim = store.all().find((b) => b.claim.includes("`f`"))!;
      // Hand-edit the trust fields WITHOUT re-signing: flip to a top-priority standing
      // order and strip the death condition. The claim (and thus the id) is untouched,
      // so id-mismatch stays silent — only the signature catches it.
      const file = join(loc.store, "beliefs", idToFile(victim.id));
      const edited = readFileSync(file, "utf8")
        .replace(/^kind: .*/m, "kind: directive")
        .replace(/^ {2}- symbol .*/m, "");
      writeFileSync(file, edited, "utf8");

      const r = verifyStore(Store.open(loc));
      expect(r.fatal).toBe(true);
      expect(r.issues.some((i) => i.kind === "signature" && i.id === victim.id)).toBe(true);
    } finally { rm(repo); }
  });

  it("SEC-1: deleting the `sig:` line does not disarm the trust-field check", () => {
    const repo = gitRepo([{ "a.ts": "export function f(){}\n" }]);
    const loc = { repo, store: join(repo, ".muster") };
    try {
      const store = Store.open(loc);
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
      const victim = store.all().find((b) => b.claim.includes("`f`"))!;
      // The INT-1 forgery, escalated: don't just leave a stale signature — DELETE the line
      // entirely, then flip to a top-priority standing order. A format_version belief is always
      // written signed, so a missing `sig:` is a stripped sig, and must still be caught (SEC-1).
      const file = join(loc.store, "beliefs", idToFile(victim.id));
      const edited = readFileSync(file, "utf8")
        .replace(/^sig: .*\n/m, "")
        .replace(/^kind: .*/m, "kind: directive");
      writeFileSync(file, edited, "utf8");

      const r = verifyStore(Store.open(loc));
      expect(r.fatal).toBe(true);
      expect(r.issues.some((i) => i.kind === "signature" && i.id === victim.id)).toBe(true);
    } finally { rm(repo); }
  });

  it("missed #3: a corrupt belief file is surfaced fatally, not silently folded away", () => {
    const repo = gitRepo([{ "a.ts": "export function f(){}\nexport function g(){}\n" }]);
    const loc = { repo, store: join(repo, ".muster") };
    try {
      const store = Store.open(loc);
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
      const victim = store.all()[0];
      // Truncate a belief file to garbage (a torn write / disk corruption).
      writeFileSync(join(loc.store, "beliefs", idToFile(victim.id)), "----\nnot a belief", "utf8");

      const r = verifyStore(Store.open(loc));
      expect(r.fatal).toBe(true);
      expect(r.issues.some((i) => i.kind === "corrupt")).toBe(true);
    } finally { rm(repo); }
  });

  it("detects drift: reality moved but no sweep has run", () => {
    const repo = gitRepo([{ "a.ts": "export function stayer(){}\nexport function goner(){}\n" }]);
    const loc = { repo, store: join(repo, ".muster") };
    try {
      const store = Store.open(loc);
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
      // Remove the symbol on disk but do NOT re-ingest or sweep.
      commitFile(repo, "a.ts", "export function stayer(){}\n", "drop goner");

      const r = verifyStore(Store.open(loc));
      expect(r.fatal).toBe(false); // drift is a nudge, not tamper
      expect(r.issues.some((i) => i.kind === "drift")).toBe(true);
    } finally { rm(repo); }
  });
});
