import { describe, it, expect } from "vitest";
import { redact, containsSecret } from "../src/redact.js";

describe("secret redaction (organ ②)", () => {
  const secrets: [string, string][] = [
    ["aws-key", "AKIAIOSFODNN7EXAMPLE"],
    ["gh-token", "ghp_" + "a".repeat(40)],
    ["openai-key", "sk-" + "A1b2C3d4".repeat(4)],
    // split so the verbatim token never appears in source (dodges secret scanners,
    // like the ghp_/sk-/AIza fixtures above); the runtime value is the full token.
    ["slack-token", "xoxb-" + "123456789012-abcdefghijklmnop"],
    ["google-key", "AIza" + "B".repeat(35)],
    ["jwt", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
  ];

  for (const [kind, sample] of secrets) {
    it(`redacts a ${kind}`, () => {
      const out = redact(`token is ${sample} ok`);
      expect(out).not.toContain(sample);
      expect(out).toContain("‹redacted");
    });
  }

  it("redacts a private key block", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIBVwIBADANBg\n-----END PRIVATE KEY-----";
    expect(redact(pem)).not.toContain("MIIBVwIBADANBg");
  });

  it("redacts the value but keeps the key name for assigned secrets", () => {
    const out = redact("AUTH_SECRET=hunter2hunter2hunter2");
    expect(out).toContain("AUTH_SECRET=");
    expect(out).not.toContain("hunter2hunter2hunter2");
  });

  it("redacts a long high-entropy blob", () => {
    const blob = "Zx9Kq2Lm8Pv3Wn5Ry7Tb1Fd4Hg6Jc0Ns_aB-cD"; // mixed, entropic
    expect(containsSecret(blob)).toBe(true);
  });

  it("is idempotent", () => {
    const once = redact("key AKIAIOSFODNN7EXAMPLE end");
    expect(redact(once)).toBe(once);
  });

  describe("allowlist — corpus-structural ids survive", () => {
    const safe = [
      "e:7f3a91c0b2d0", // muster belief id
      "9c1e4a7", // git short sha
      "0123456789abcdef0123456789abcdef01234567", // git full sha (40 hex)
      "88ab1c2d3e4f", // content hash (12 hex)
      "#4213", // issue number
      "src/auth/token.ts", // in-corpus path
      "session-6b2#12", // session ref
    ];
    for (const tok of safe) {
      it(`keeps ${tok}`, () => {
        expect(redact(`ref ${tok} here`)).toContain(tok);
      });
    }
  });

  describe("SEC-1 — the single-charset / path-shaped leak class (Phase 1f)", () => {
    const leaks: [string, string][] = [
      ["aws secret with slashes", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
      ["bare 64-hex digest", "deadbeef0123456789abcdefdeadbeef0123456789abcdefdeadbeef01234567"],
      ["48-hex secret", "deadbeefcafe0123456789abcdefdeadbeefcafe01234567"],
      ["lowercase-key assignment", "password=hunter2hunter2hunter2"],
      ["config-key assignment", "db_token: s3cr3ts3cr3ts3cr3tvalue"],
    ];
    for (const [name, sample] of leaks) {
      it(`redacts ${name}`, () => {
        expect(containsSecret(sample)).toBe(true);
        expect(redact(`x ${sample} y`)).not.toContain(sample);
      });
    }

    it("still keeps the git full-sha (40-hex) — provenance depends on it", () => {
      expect(redact("0123456789abcdef0123456789abcdef01234567")).toBe("0123456789abcdef0123456789abcdef01234567");
    });

    it("does not false-positive on prose that merely contains a secret keyword", () => {
      for (const s of ["the tokenizer produces tokens", "a secretary organizes files", "tokenization matters"]) {
        expect(containsSecret(s)).toBe(false);
      }
    });

    // #5: the assigned-secret rule fires on ANY key ending in a credential word, so a config
    // key like `crystallizationTokens` was clobbering a placeholder/indirection value. A value
    // that is unmistakably a non-secret (placeholder, ${ENV} indirection, keyword) is now spared.
    it("spares a placeholder / indirection value under a credential-named config key", () => {
      const benign = [
        "crystallizationTokens=<default>",
        "maxTokens=<computed>",
        "apiToken=${API_TOKEN}",
        "AUTH_TOKEN=$AUTH_TOKEN",
        "refreshToken=%REFRESH_TOKEN%",
        "sessionSecret=disabled",
        "accessToken=changeme",
      ];
      for (const s of benign) {
        expect(containsSecret(s)).toBe(false); // value left intact
      }
    });

    // …but a REAL value under such a key still redacts: sparing placeholders must never
    // become a leak. (These are the pre-existing SEC-1 cases, kept green alongside the fix.)
    it("still redacts a real value under a compound credential key", () => {
      for (const s of ["crystallizationTokens=hunter2hunter2hunter2", "csrfToken: s3cr3ts3cr3ts3cr3tvalue", "AUTH_SECRET=hunter2hunter2hunter2"]) {
        expect(containsSecret(s)).toBe(true);
      }
    });
  });

  describe("SEC-2 — bounded and ReDoS-proof (Phase 0b)", () => {
    it("a flood of unterminated BEGIN markers returns fast (no catastrophic backtracking)", () => {
      const attack = "-----BEGIN RSA PRIVATE KEY-----\n".repeat(70000); // ~2.2MB, no END
      const t = performance.now();
      redact(attack);
      expect(performance.now() - t).toBeLessThan(500); // was ~28s before the bound+guard
    });

    it("many BEGIN markers plus one END still returns fast", () => {
      const attack = "-----BEGIN RSA PRIVATE KEY-----\n".repeat(70000) + "-----END RSA PRIVATE KEY-----";
      const t = performance.now();
      redact(attack);
      expect(performance.now() - t).toBeLessThan(500);
    });

    it("truncates oversize input with a visible marker; the dropped tail cannot leak", () => {
      const huge = "x".repeat(1024 * 1024) + " AKIAIOSFODNN7EXAMPLE" + "y".repeat(1000);
      const out = redact(huge);
      expect(out).toContain("‹redacted:oversize"); // truncation is announced, not silent
      expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE"); // the past-cap secret is gone unread
      expect(out).not.toContain("y".repeat(1000)); // the whole tail past the cap is dropped
    });

    it("still redacts a real key body despite the bounded gap", () => {
      const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAabc123+/=def\n-----END RSA PRIVATE KEY-----";
      const out = redact(pem);
      expect(out).toContain("‹redacted:private-key›");
      expect(out).not.toContain("MIIEpAIBAAKCAQEAabc123");
    });
  });

  describe("false-positive budget (≤1% on benign tokens)", () => {
    it("leaves ordinary English/code tokens untouched", () => {
      const benign = (
        "the quick brown fox jumps over the lazy dog function issueToken export const " +
        "compileBriefing reverification altitude ladder knapsack packing deterministic " +
        "src index linker verbs ingest watch tombstone obituary tripwire budget monotone " +
        "readFileSync writeFileSync execFileSync createHash configuration repository " +
        "authentication middleware controller repository serializer deserializer"
      ).split(/\s+/);
      const flagged = benign.filter((t) => containsSecret(t));
      expect(flagged.length / benign.length).toBeLessThanOrEqual(0.01);
    });
  });
});
