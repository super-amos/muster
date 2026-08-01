import { describe, it, expect } from "vitest";
import { serializeBelief, parseBelief } from "../src/frontmatter.js";
import { belief } from "./helpers.js";
import type { Belief } from "../src/types.js";

describe("belief <-> markdown round-trip", () => {
  it("preserves a live belief through serialize/parse", () => {
    const b = belief({
      claim: "`issueToken` (function) is defined in `src/auth/token.ts`.",
      subjects: ["src/auth/token.ts", "issueToken"],
      watch: [{ kind: "symbol", target: "issueToken@src/auth/token.ts", expect: "present" }],
      evidence: [{ kind: "file", ref: "src/auth/token.ts", note: "line 1" }],
    });
    const out = parseBelief(serializeBelief(b));
    expect(out.id).toBe(b.id);
    expect(out.kind).toBe(b.kind);
    expect(out.status).toBe(b.status);
    expect(out.claim).toBe(b.claim);
    expect(out.subjects).toEqual(b.subjects);
    expect(out.watch).toEqual(b.watch);
    expect(out.evidence).toEqual(b.evidence);
    expect(out.confidence).toBeCloseTo(b.confidence, 2);
  });

  it("parses a CRLF-mangled belief byte-identically to its LF twin (no false tamper)", () => {
    // A store checked out under core.autocrlf (Windows' default) arrives with \r\n. The
    // content-addressed id must be immune: a CRLF file has to parse to the SAME belief as
    // its LF twin, or `verify` would report tamper on a store nobody touched.
    const b = belief({
      claim: "`canRelease` (function) is defined in `src/gate.ts`.",
      subjects: ["src/gate.ts", "canRelease"],
      watch: [{ kind: "symbol", target: "canRelease@src/gate.ts", expect: "present" }],
      evidence: [{ kind: "file", ref: "src/my dir/gate.ts", note: "line 1" }],
    });
    const lf = serializeBelief(b);
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(crlf).toContain("\r\n"); // the mangling is real
    const out = parseBelief(crlf);
    expect(out.id).toBe(b.id); // the id recomputes identically — no false tamper
    expect(out.claim).toBe(b.claim);
    expect(out.watch).toEqual(b.watch);
    expect(out.evidence).toEqual(b.evidence);
    expect(out.kind).toBe(b.kind);
  });

  it("preserves a tombstone (the obituary survives on disk)", () => {
    const b: Belief = belief({
      claim: "`refreshToken` (function) is defined in `src/auth/token.ts`.",
      status: "dead",
      watch: [{ kind: "symbol", target: "refreshToken@src/auth/token.ts", expect: "present" }],
      tombstone: { death: "falsified", at: "2026-06-03T10:00:00.000Z", by: "9c1e4a7", note: "`refreshToken` was defined until it was removed (commit 9c1e4a7). Do not call it." },
    });
    const out = parseBelief(serializeBelief(b));
    expect(out.status).toBe("dead");
    expect(out.tombstone?.death).toBe("falsified");
    expect(out.tombstone?.by).toBe("9c1e4a7");
    expect(out.tombstone?.note).toContain("Do not call it");
  });
});
