import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { cmdBrief, cmdWhy } from "../src/verbs.js";
import { belief, mkTmp, rm } from "./helpers.js";

// Phase 1f (SEC-1) — the read path is the last gate before a secret reaches an agent's
// context. Even a belief whose STORED claim carries a secret (bypassing ingest redaction,
// e.g. imported memory or a rule that post-dates ingest) must render redacted in BOTH
// `brief` and `why`.

describe("render-time redaction covers brief AND why", () => {
  const SECRET = "AKIAIOSFODNN7EXAMPLE";

  function storeWithSecret() {
    const tmp = mkTmp();
    const loc = { repo: tmp, store: join(tmp, ".muster") };
    const store = Store.open(loc);
    // Construct a belief with an UN-redacted secret in its claim, straight to disk.
    const b = belief({
      claim: `The deploy key is ${SECRET} and lives in src/deploy.ts.`,
      subjects: ["src/deploy.ts"],
      watch: [{ kind: "path", target: "src/deploy.ts", expect: "present" }],
      evidence: [{ kind: "file", ref: "src/deploy.ts", note: "" }],
    });
    store.mint(b);
    return { loc, id: b.id };
  }

  it("brief does not emit a stored secret", () => {
    const { loc } = storeWithSecret();
    try {
      const out = cmdBrief({ repo: loc.repo, store: loc.store, task: "work on src/deploy.ts", budget: 4000 });
      expect(out).not.toContain(SECRET);
      expect(out).toContain("‹redacted");
    } finally { rm(loc.repo); }
  });

  it("why does not emit a stored secret", () => {
    const { loc, id } = storeWithSecret();
    try {
      const out = cmdWhy({ repo: loc.repo, store: loc.store, id });
      expect(out).not.toContain(SECRET);
      expect(out).toContain("‹redacted");
    } finally { rm(loc.repo); }
  });
});
