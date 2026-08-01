import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { evalWatch, definesSymbol } from "../src/watch.js";
import { contentHash } from "../src/id.js";
import { mkTmp, rm } from "./helpers.js";

const NOW = new Date("2026-07-01T00:00:00Z");

describe("definesSymbol — declaration, not call site", () => {
  it("matches declarations across languages", () => {
    expect(definesSymbol("export function issueToken() {}", "issueToken")).toBe(true);
    expect(definesSymbol("class Foo {}", "Foo")).toBe(true);
    expect(definesSymbol("const bar = () => 1", "bar")).toBe(true);
    expect(definesSymbol("def snake_case(): pass", "snake_case")).toBe(true);
    expect(definesSymbol("func Handler() {}", "Handler")).toBe(true);
  });

  it("does NOT match a mere call site (so a deleted def fires)", () => {
    expect(definesSymbol("  issueToken(user)\n  return refreshToken(x)", "issueToken")).toBe(false);
  });
});

describe("evalWatch — the death conditions", () => {
  function repoWith(rel: string, content: string): string {
    const root = mkTmp();
    const abs = join(root, rel);
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return root;
  }

  it("symbol present → not fired; removed → dead/falsified", () => {
    const root = repoWith("a.ts", "export function keep() {}\nexport function gone() {}");
    try {
      expect(evalWatch(root, { kind: "symbol", target: "gone@a.ts", expect: "present" }, NOW).fired).toBe(false);
      writeFileSync(join(root, "a.ts"), "export function keep() {}");
      const r = evalWatch(root, { kind: "symbol", target: "gone@a.ts", expect: "present" }, NOW);
      expect(r.fired).toBe(true);
      expect(r.fate).toBe("dead");
      expect(r.death).toBe("falsified");
    } finally { rm(root); }
  });

  it("blob unchanged → not fired; changed → stale; deleted → dead", () => {
    const content = "hello world";
    const root = repoWith("f.ts", content);
    try {
      const hash = contentHash(content);
      expect(evalWatch(root, { kind: "blob", target: "f.ts", expect: hash }, NOW).fired).toBe(false);
      writeFileSync(join(root, "f.ts"), "hello mutated");
      const changed = evalWatch(root, { kind: "blob", target: "f.ts", expect: hash }, NOW);
      expect(changed.fired).toBe(true);
      expect(changed.fate).toBe("stale");
      rmSync(join(root, "f.ts"));
      const deleted = evalWatch(root, { kind: "blob", target: "f.ts", expect: hash }, NOW);
      expect(deleted.fired).toBe(true);
      expect(deleted.fate).toBe("dead");
    } finally { rm(root); }
  });

  it("path exists → not fired; deleted → dead", () => {
    const root = repoWith("p.ts", "x");
    try {
      expect(evalWatch(root, { kind: "path", target: "p.ts", expect: "present" }, NOW).fired).toBe(false);
      rmSync(join(root, "p.ts"));
      expect(evalWatch(root, { kind: "path", target: "p.ts", expect: "present" }, NOW).fate).toBe("dead");
    } finally { rm(root); }
  });

  it("expire in the future → not fired; in the past → dead/expired", () => {
    const root = mkTmp();
    try {
      expect(evalWatch(root, { kind: "expire", target: "2099-01-01T00:00:00Z", expect: "" }, NOW).fired).toBe(false);
      const past = evalWatch(root, { kind: "expire", target: "2020-01-01T00:00:00Z", expect: "" }, NOW);
      expect(past.fired).toBe(true);
      expect(past.death).toBe("expired");
    } finally { rm(root); }
  });

  it("refuses a watch target that escapes the corpus (no read, no fire)", () => {
    const root = mkTmp();
    try {
      expect(evalWatch(root, { kind: "path", target: "../../../../etc/passwd", expect: "present" }, NOW).fired).toBe(false);
    } finally { rm(root); }
  });
});
