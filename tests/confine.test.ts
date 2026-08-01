import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { confine, isConfined, ConfinementError } from "../src/confine.js";
import { mkTmp, rm } from "./helpers.js";

describe("corpus confinement (organ ②)", () => {
  it("resolves an in-corpus path", () => {
    const root = mkTmp();
    try {
      expect(confine(root, "src/auth/token.ts")).toBe(join(root, "src/auth/token.ts"));
      expect(isConfined(root, "a/b/c.ts")).toBe(true);
    } finally { rm(root); }
  });

  it("rejects a ../ escape", () => {
    const root = mkTmp();
    try {
      expect(() => confine(root, "../../../../etc/passwd")).toThrow(ConfinementError);
      expect(isConfined(root, "../secrets")).toBe(false);
    } finally { rm(root); }
  });

  it("rejects an absolute path outside the root", () => {
    const root = mkTmp();
    try {
      expect(isConfined(root, "/etc/shadow")).toBe(false);
    } finally { rm(root); }
  });

  it("allows the root itself", () => {
    const root = mkTmp();
    try {
      expect(confine(root, ".")).toBe(root);
    } finally { rm(root); }
  });
});
