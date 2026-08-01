import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { serializeBelief, parseBelief, signBelief } from "../src/frontmatter.js";
import { recomputeId } from "../src/id.js";
import { Store } from "../src/store.js";
import { ingestGit } from "../src/ingest.js";
import { sweep } from "../src/watch.js";
import { verifyStore } from "../src/integrity.js";
import { belief, gitRepo, rm } from "./helpers.js";

// COR-1 — a space in a tracked filename used to mis-split the whitespace-delimited on-disk
// watch/evidence grammar, forging a false tombstone and a permanent "TAMPER DETECTED".
describe("COR-1: whitespace in watch/evidence fields round-trips (spaces in paths)", () => {
  it("serialize→parse preserves a spaced watch target + evidence ref; id and signature stay stable", () => {
    const b = belief({
      claim: "`f` (function) is defined in `src/my file.ts`.",
      subjects: ["src/my file.ts", "f"],
      method: "read-source",
      watch: [{ kind: "blob", target: "src/my file.ts", expect: "deadbeefcafe" }],
      evidence: [{ kind: "file", ref: "src/my file.ts", note: "def f in a spaced path" }],
    });
    const round = parseBelief(serializeBelief(b));
    expect(round.watch[0].target).toBe("src/my file.ts");
    expect(round.watch[0].expect).toBe("deadbeefcafe");
    expect(round.evidence[0].ref).toBe("src/my file.ts");
    expect(round.evidence[0].note).toBe("def f in a spaced path"); // the free-text tail is untouched
    // The id (over claim+evidence) and the signature (over watch) both survive the round-trip —
    // no false id-mismatch / TAMPER, which was the whole COR-1 failure.
    expect(recomputeId(round.claim, round.evidence)).toBe(b.id);
    expect(signBelief(round)).toBe(signBelief(b));
  });

  it("even a `%` in a field round-trips (the escape is fully reversible)", () => {
    const b = belief({
      claim: "weird path",
      subjects: ["src/a%b c.ts"],
      watch: [{ kind: "path", target: "src/a%b c.ts", expect: "present" }],
      evidence: [{ kind: "file", ref: "src/a%b c.ts", note: "n" }],
    });
    const round = parseBelief(serializeBelief(b));
    expect(round.watch[0].target).toBe("src/a%b c.ts");
    expect(round.evidence[0].ref).toBe("src/a%b c.ts");
  });

  it("a value with no whitespace or `%` encodes to itself — existing stores never churn", () => {
    const b = belief({
      claim: "plain",
      watch: [{ kind: "path", target: "src/plain.ts", expect: "present" }],
      evidence: [{ kind: "file", ref: "src/plain.ts", note: "note words" }],
    });
    const text = serializeBelief(b);
    expect(text).toContain("- path src/plain.ts present"); // byte-identical to the old grammar
    expect(text).toContain("- file src/plain.ts note words");
  });

  it("a repo with a spaced filename verifies clean and the file belief stays live (not a false tombstone)", () => {
    const repo = gitRepo([{ "src/my file.ts": "export function spacedFn(){}\n" }]);
    const loc = { repo, store: join(repo, ".muster") };
    try {
      const store = Store.open(loc);
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
      sweep(store);
      // Reopen forces the on-disk serialize→parse round-trip that COR-1 corrupted: the spaced
      // watch target used to come back as `src/my` (nonexistent) → false tombstone + id-mismatch.
      const reopened = Store.open(loc);
      const r = verifyStore(reopened);
      expect(r.fatal).toBe(false); // no forged TAMPER on a pristine store
      const sym = reopened.all().find((b) => b.claim.includes("spacedFn"));
      expect(sym).toBeTruthy();
      expect(sym!.status).not.toBe("dead"); // a live file is not advertised as removed
    } finally { rm(repo); }
  });
});
