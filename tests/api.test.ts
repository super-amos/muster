import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { cmdBrief, cmdWhy, cmdVerify, cmdStatus, cmdDeny, NotFoundError } from "../src/verbs.js";
import * as publicApi from "../src/index.js";
import * as internalApi from "../src/internal.js";
import { belief, mkTmp, rm } from "./helpers.js";

// API-1 (Phase 4) — the read verbs gained a machine-readable `--json` mode and the CLI
// gained meaningful exit codes. The library contract those rest on: read verbs emit valid,
// structured JSON on demand (redaction still applied), and a missing id throws a typed
// NotFoundError the edges can map to an exit code / soft tool text — never a silent string.

function storeWith(claim: string): { loc: { repo: string; store: string }; id: string } {
  const tmp = mkTmp();
  const loc = { repo: tmp, store: join(tmp, ".muster") };
  const b = belief({ claim, subjects: ["src/x.ts"] });
  Store.open(loc).mint(b);
  return { loc, id: b.id };
}

describe("read verbs emit valid, structured --json", () => {
  it("brief --json is parseable and carries the same metrics as the human footer", () => {
    const { loc } = storeWith("src/x.ts holds the token issuer.");
    try {
      const j = JSON.parse(cmdBrief({ repo: loc.repo, store: loc.store, task: "work on src/x.ts", budget: 4000, json: true }));
      expect(typeof j.budget).toBe("number");
      expect(typeof j.used).toBe("number");
      expect(Array.isArray(j.lines)).toBe(true);
      expect(j).toHaveProperty("mandatoryOmitted");
      expect(typeof j.text).toBe("string");
    } finally { rm(loc.repo); }
  });

  it("why --json exposes the provenance record with redaction still applied", () => {
    const SECRET = "AKIAIOSFODNN7EXAMPLE";
    const { loc, id } = storeWith(`the deploy key is ${SECRET}.`);
    try {
      const raw = cmdWhy({ repo: loc.repo, store: loc.store, id, json: true });
      expect(raw).not.toContain(SECRET); // the JSON is not a redaction bypass
      const j = JSON.parse(raw);
      expect(j.id).toBe(id);
      expect(Array.isArray(j.evidence)).toBe(true);
      expect(typeof j.claim).toBe("string");
    } finally { rm(loc.repo); }
  });

  it("verify --json reports counts, fatality, and an issues array", () => {
    const { loc } = storeWith("src/x.ts exists.");
    try {
      const j = JSON.parse(cmdVerify({ repo: loc.repo, store: loc.store, json: true }).text);
      expect(typeof j.beliefs).toBe("number");
      expect(typeof j.clean).toBe("number");
      expect(typeof j.fatal).toBe("boolean");
      expect(Array.isArray(j.issues)).toBe(true);
    } finally { rm(loc.repo); }
  });

  it("status --json reports counts keyed by status and kind", () => {
    const { loc } = storeWith("src/x.ts exists.");
    try {
      const j = JSON.parse(cmdStatus({ repo: loc.repo, store: loc.store, json: true }));
      expect(j.beliefs).toBeGreaterThanOrEqual(1);
      expect(typeof j.byStatus).toBe("object");
      expect(typeof j.byKind).toBe("object");
    } finally { rm(loc.repo); }
  });
});

describe("a missing id is a typed NotFoundError, not a swallowed string", () => {
  it("why throws NotFoundError for an unknown id", () => {
    const { loc } = storeWith("src/x.ts exists.");
    try {
      expect(() => cmdWhy({ repo: loc.repo, store: loc.store, id: "e:deadbeefdead" })).toThrow(NotFoundError);
    } finally { rm(loc.repo); }
  });

  it("deny rejects with NotFoundError for an unknown id", async () => {
    const { loc } = storeWith("src/x.ts exists.");
    try {
      await expect(cmdDeny({ repo: loc.repo, store: loc.store, id: "e:deadbeefdead" })).rejects.toBeInstanceOf(NotFoundError);
    } finally { rm(loc.repo); }
  });
});

// API-2 (Phase 4) — `.` (index) is the curated, semver-committed public surface; the deep
// primitives live behind `muster/internal`. The split must not silently drift: the public
// surface stays the embed essentials, and never leaks the internals it deliberately hides.
describe("public `.` is curated; `internal` is the wide escape hatch", () => {
  it("public exposes the embed essentials but hides deep primitives", () => {
    expect(publicApi.Store).toBeDefined();
    expect(publicApi.compileBriefing).toBeDefined();
    expect(publicApi.NotFoundError).toBeDefined();
    // deep primitives are NOT on the public surface — reach them via `muster/internal`.
    expect((publicApi as Record<string, unknown>).sweep).toBeUndefined();
    expect((publicApi as Record<string, unknown>).contentHash).toBeUndefined();
    expect((publicApi as Record<string, unknown>).reconcile).toBeUndefined();
  });
  it("internal is a superset that also carries the deep primitives", () => {
    expect(internalApi.Store).toBeDefined();
    expect(internalApi.NotFoundError).toBeDefined();
    expect(internalApi.sweep).toBeDefined();
    expect(internalApi.contentHash).toBeDefined();
    expect(internalApi.reconcile).toBeDefined();
  });
});
