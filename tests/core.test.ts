import { describe, it, expect } from "vitest";
import { beliefId, canonicalJson, idToFile, fileToId } from "../src/id.js";
import { countTokens } from "../src/tokens.js";
import { serializeBelief, parseBelief } from "../src/frontmatter.js";
import { definesSymbol, evalWatch } from "../src/watch.js";
import { extractSymbols } from "../src/ingest.js";
import { readTraces, appendTrace, makeTrace } from "../src/journal.js";
import { mkdtempSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Belief } from "../src/types.js";

function belief(over: Partial<Belief> = {}): Belief {
  return {
    id: "e:aaaaaa", kind: "observed", status: "live", claim: "x", subjects: ["a"],
    confidence: 0.8, method: "read-source", watch: [], evidence: [{ kind: "file", ref: "a.ts", note: "" }],
    lineage: [], origin: "test", born: "2026-01-01T00:00:00Z", lastVerified: "2026-01-02T00:00:00Z",
    supersededBy: "", ...over,
  };
}

describe("identity", () => {
  it("is content-addressed and idempotent (note excluded)", () => {
    const a = beliefId("JWTs are 15m", [{ kind: "file", ref: "src/auth.ts", note: "line 3" }]);
    const b = beliefId("JWTs are 15m", [{ kind: "file", ref: "src/auth.ts", note: "OTHER" }]);
    expect(a).toBe(b);
    expect(a.startsWith("e:")).toBe(true);
  });
  it("changes when the claim changes", () => {
    const ev = [{ kind: "file" as const, ref: "a", note: "" }];
    expect(beliefId("one", ev)).not.toBe(beliefId("two", ev));
  });
  it("canonicalJson sorts keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
  it("file <-> id round trips", () => {
    expect(fileToId(idToFile("e:7f3a1c"))).toBe("e:7f3a1c");
  });
});

describe("frontmatter round-trip", () => {
  it("serialize then parse yields the same belief", () => {
    const b = belief({
      id: "e:abc123", kind: "directive", claim: "Never deploy on Fridays.",
      subjects: ["deploy", "release process"],
      watch: [{ kind: "expire", target: "2027-01-01T00:00:00Z", expect: "" }],
      evidence: [{ kind: "session", ref: "s#3", note: "2026-05-02" }],
      lineage: ["e:zzz999"], supersededBy: "e:new999",
    });
    const r = parseBelief(serializeBelief(b));
    expect(r.id).toBe(b.id);
    expect(r.kind).toBe(b.kind);
    expect(r.claim).toBe(b.claim);
    expect(r.subjects).toEqual(b.subjects);
    expect(r.watch).toEqual(b.watch);
    expect(r.evidence).toEqual(b.evidence);
    expect(r.lineage).toEqual(b.lineage);
    expect(r.supersededBy).toBe(b.supersededBy);
  });
});

describe("tokens", () => {
  it("is deterministic and monotone in text", () => {
    expect(countTokens("hello world")).toBe(countTokens("hello world"));
    expect(countTokens("a b c d e")).toBeGreaterThan(countTokens("a b"));
  });
});

describe("symbols", () => {
  it("detects definitions, not call sites", () => {
    expect(definesSymbol("export function issueToken(){}\n", "issueToken")).toBe(true);
    expect(definesSymbol("issueToken()\n", "issueToken")).toBe(false);
  });
  it("extracts top-level names", () => {
    const names = extractSymbols("export function a(){}\nclass B {}\nconst c = () => 1\nexport const d = 2\n")
      .map((s) => s.name).sort();
    expect(names).toEqual(["B", "a", "c", "d"]);
  });
});

describe("watch evaluation", () => {
  it("expire fires only once the date passes", () => {
    expect(evalWatch("/tmp", { kind: "expire", target: "2020-01-01T00:00:00Z", expect: "" }, new Date("2026-01-01")).fired).toBe(true);
    expect(evalWatch("/tmp", { kind: "expire", target: "2099-01-01T00:00:00Z", expect: "" }, new Date("2026-01-01")).fired).toBe(false);
  });
});

describe("journal", () => {
  it("is torn-line tolerant", () => {
    const store = mkdtempSync(join(tmpdir(), "muster-j-"));
    const loc = { repo: store, store };
    appendTrace(loc, makeTrace("commit", { note: "one" }));
    appendTrace(loc, makeTrace("commit", { note: "two" }));
    appendFileSync(join(store, "journal.jsonl"), '{"partial": "torn line no newline');
    const traces = readTraces(loc);
    expect(traces.length).toBe(2);
    expect(traces.map((t) => t.note)).toEqual(["one", "two"]);
    rmSync(store, { recursive: true, force: true });
  });
});
