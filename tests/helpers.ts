import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { Belief } from "../src/types.js";
import { beliefId } from "../src/id.js";

export function mkTmp(prefix = "muster-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function rm(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

// A git repo seeded with a set of {path: content} snapshots, one commit each. Returns
// the repo root. Timestamps are fixed and monotonic so the fold stays deterministic.
export function gitRepo(commits: Record<string, string>[]): string {
  const repo = mkTmp("muster-repo-");
  const git = (args: string[], date?: string): void => {
    execFileSync("git", ["-C", repo, ...args], {
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t.co", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t.co" },
    });
  };
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.co"]);
  git(["config", "user.name", "T"]);
  let day = 1;
  for (const snapshot of commits) {
    for (const [rel, content] of Object.entries(snapshot)) {
      const abs = join(repo, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    }
    const date = `2026-05-0${day} 12:00:00 +0000`;
    git(["add", "-A"], date);
    git(["commit", "-qm", `commit ${day}`, "--allow-empty"], date);
    day++;
  }
  return repo;
}

// Write a file into an existing repo and commit it — used to simulate the world moving.
export function commitFile(repo: string, rel: string, content: string, msg = "edit"): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-qm", msg], {
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t.co", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t.co" },
  });
}

// A minimal valid belief for unit tests, with a content-addressed id.
export function belief(partial: Partial<Belief> & { claim: string }): Belief {
  const evidence = partial.evidence ?? [{ kind: "file", ref: "src/x.ts", note: "" }];
  const claim = partial.claim;
  return {
    id: beliefId(claim, evidence),
    kind: "observed",
    status: "live",
    claim,
    subjects: ["src/x.ts"],
    confidence: 0.8,
    method: "test",
    watch: [{ kind: "path", target: "src/x.ts", expect: "present" }],
    evidence,
    lineage: [],
    origin: "test",
    born: "2026-05-01T12:00:00.000Z",
    lastVerified: "2026-05-01T12:00:00.000Z",
    supersededBy: "",
    ...partial,
  };
}
