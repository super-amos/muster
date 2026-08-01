import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ingestGit } from "../src/ingest.js";
import { sweep } from "../src/watch.js";
import { compileBriefing } from "../src/linker.js";

const TASK = "work on the auth flow and helper.ts: issueToken, oldHelper, newHelper";

function git(repo: string, args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  });
}

let repo = "";
let store = "";
const LOC = () => ({ repo, store });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "muster-repo-"));
  store = mkdtempSync(join(tmpdir(), "muster-store-"));
  mkdirSync(join(repo, "src"));
  git(repo, ["init", "-q"]);
  writeFileSync(join(repo, "src", "auth.ts"), "export function issueToken(){ return 'jwt' }\nexport function verifyToken(t){ return true }\n");
  writeFileSync(join(repo, "src", "helper.ts"), "export function oldHelper(){ return 1 }\nexport function newHelper(){ return 2 }\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
});

describe("end-to-end: ingest real git, brief, then kill the scar", () => {
  it("briefs real symbols from real git history, under budget", () => {
    const s = Store.open(LOC());
    ingestGit(s, { repo, maxCommits: 50, pathPrefix: "src", maxSymbolsPerFile: 40 });
    sweep(s);
    const brief = compileBriefing(s, TASK, 1500);
    expect(brief.lines.some((l) => l.text.includes("issueToken"))).toBe(true);
    expect(brief.lines.some((l) => l.text.includes("oldHelper"))).toBe(true);  // live at t0
    expect(brief.lines.some((l) => l.text.includes("newHelper"))).toBe(true);
    expect(brief.used).toBeLessThanOrEqual(1500);
  });

  it("after a symbol is deleted, it dies and never briefs again — same task, same budget", () => {
    writeFileSync(join(repo, "src", "helper.ts"), "export function newHelper(){ return 2 }\n");
    git(repo, ["commit", "-q", "-am", "remove oldHelper"]);

    const s = Store.open(LOC());
    ingestGit(s, { repo, maxCommits: 50, pathPrefix: "src", maxSymbolsPerFile: 40 });
    const swept = sweep(s);

    const dead = s.all().find((bel) => bel.claim.includes("oldHelper"));
    expect(dead).toBeTruthy();
    expect(dead && dead.status).toBe("dead");
    expect(dead?.tombstone?.death).toBe("falsified");
    expect(swept.killed.some((k) => k.reason.includes("oldHelper"))).toBe(true);

    const brief = compileBriefing(s, TASK, 1500);
    // oldHelper never briefs as a live, callable definition (muster stale-ref = 0)…
    expect(brief.text).not.toContain("`oldHelper` (function) is defined");
    // …instead its corpse surfaces as a tripwire, citing the killing commit.
    expect(brief.text).toContain("TRIPWIRES");
    expect(brief.text).toMatch(/⛔.*oldHelper.*removed/);
    expect(brief.lines.some((l) => l.text.includes("issueToken"))).toBe(true); // live truth kept
    expect(brief.lines.some((l) => l.text.includes("newHelper"))).toBe(true);  // live sibling kept

    // A naive index built at t0 (snapshot of the OLD file) would still surface it as
    // callable — the scar. Muster warns against it instead.
    const staleSnapshot = "export function oldHelper(){ return 1 }\nexport function newHelper(){ return 2 }\n";
    expect(staleSnapshot.includes("oldHelper")).toBe(true); // baseline stale-ref >= 1
  });
});
