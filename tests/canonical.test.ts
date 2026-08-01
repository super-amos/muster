import { describe, it, expect } from "vitest";
import { canonicalJson, sha256hex, beliefId, recomputeId } from "../src/id.js";
import type { Evidence } from "../src/types.js";

describe("canonicalJson", () => {
  it("sorts keys recursively and ignores insertion order", () => {
    const a = canonicalJson({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it("is stable across arrays (order preserved) and scalars", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson("x")).toBe('"x"');
  });
});

describe("sha256hex", () => {
  it("is the standard sha-256 of the utf-8 bytes", () => {
    expect(sha256hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("beliefId — content addressing", () => {
  const ev: Evidence[] = [{ kind: "file", ref: "src/a.ts", note: "line 5" }];

  it("is a 12-hex address under the e: namespace", () => {
    const id = beliefId("X is defined in a.ts", ev);
    expect(id).toMatch(/^e:[0-9a-f]{12}$/);
  });

  it("collapses the same claim+evidence to one id (idempotent ingest)", () => {
    const id1 = beliefId("Auth uses JWT", ev);
    const id2 = beliefId("Auth uses JWT", [{ kind: "file", ref: "src/a.ts", note: "line 5" }]);
    expect(id1).toBe(id2);
  });

  it("excludes the mutable evidence note from identity", () => {
    const withNote = beliefId("Auth uses JWT", [{ kind: "file", ref: "src/a.ts", note: "42 commits" }]);
    const otherNote = beliefId("Auth uses JWT", [{ kind: "file", ref: "src/a.ts", note: "99 commits" }]);
    expect(withNote).toBe(otherNote);
  });

  it("distinguishes different claims and different evidence", () => {
    expect(beliefId("A", ev)).not.toBe(beliefId("B", ev));
    expect(beliefId("A", ev)).not.toBe(beliefId("A", [{ kind: "file", ref: "src/b.ts", note: "" }]));
  });

  it("is order-independent over evidence (sorted before hashing)", () => {
    const e1: Evidence[] = [{ kind: "file", ref: "a", note: "" }, { kind: "commit", ref: "b", note: "" }];
    const e2: Evidence[] = [{ kind: "commit", ref: "b", note: "" }, { kind: "file", ref: "a", note: "" }];
    expect(beliefId("C", e1)).toBe(beliefId("C", e2));
  });

  it("recomputeId matches beliefId (the verify() anchor)", () => {
    expect(recomputeId("Z", ev)).toBe(beliefId("Z", ev));
  });
});
