import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ingestGit } from "../src/ingest.js";
import { sweep } from "../src/watch.js";
import { compileBriefing } from "../src/linker.js";
import { gitRepo, commitFile, rm } from "./helpers.js";

// The M1 gate: the deleted-function scar must be unreproducible. A symbol that is
// deleted must never brief as callable again — instead its corpse must surface as a
// tripwire that cites the killing commit.
describe("the deleted-function scar is structurally impossible", () => {
  it("kills the belief at ingest of the deleting diff and briefs a tripwire", () => {
    const repo = gitRepo([{
      "src/auth/token.ts":
        "export function issueToken(u){ return sign(u); }\n" +
        "export function refreshToken(o){ return sign(o); }\n" +
        "function sign(s){ return 'tok:'+s; }\n",
    }]);
    const loc = { repo, store: join(repo, ".muster") };
    try {
      const store = Store.open(loc);
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });

      const task = "refactor token issuance in src/auth/token.ts and drop refreshToken";
      let brief = compileBriefing(store, task, 900);
      // Before deletion: refreshToken briefs as a live definition.
      expect(brief.text).toContain("`refreshToken` (function) is defined");
      expect(brief.text).not.toContain("TRIPWIRES");

      // The deleting diff.
      commitFile(repo, "src/auth/token.ts",
        "export function issueToken(u){ return sign(u); }\n" +
        "function sign(s){ return 'tok:'+s; }\n", "drop refreshToken");

      // Re-sync: re-mint (refreshToken is no longer minted) then reverify.
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
      const sw = sweep(store);
      expect(sw.killed.some((k) => /refreshToken/.test(k.reason))).toBe(true);

      const dead = store.all().find((b) => b.claim.includes("refreshToken"));
      expect(dead?.status).toBe("dead");
      expect(dead?.tombstone?.death).toBe("falsified");
      expect(dead?.tombstone?.by).toMatch(/^[0-9a-f]{7,}$/); // cites the killing commit

      // After deletion: a tripwire, never the ghost.
      brief = compileBriefing(store, task, 900);
      expect(brief.text).toContain("TRIPWIRES");
      expect(brief.text).toMatch(/⛔.*refreshToken.*removed/);
      expect(brief.text).not.toContain("`refreshToken` (function) is defined");
    } finally { rm(repo); }
  });

  it("resurrects a belief if the symbol comes back — but a denied belief stays dead", () => {
    const repo = gitRepo([{ "m.ts": "export function alpha(){}\n" }]);
    const loc = { repo, store: join(repo, ".muster") };
    try {
      const store = Store.open(loc);
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
      commitFile(repo, "m.ts", "// alpha gone\n", "remove alpha");
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
      sweep(store);
      expect(store.all().find((b) => b.claim.includes("alpha"))?.status).toBe("dead");

      // The symbol returns.
      commitFile(repo, "m.ts", "export function alpha(){}\n", "restore alpha");
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
      expect(store.all().find((b) => b.claim.includes("alpha"))?.status).toBe("live");
    } finally { rm(repo); }
  });
});
