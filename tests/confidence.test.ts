import { describe, it, expect } from "vitest";
import { isProvisional, independentEvidence, describeConfidence, METHOD_EXTRACT } from "../src/confidence.js";
import { belief } from "./helpers.js";

describe("confidence — a shown derivation, and provenance-derived quarantine", () => {
  it("independentEvidence counts distinct (kind, ref) traces", () => {
    const b = belief({
      claim: "x",
      evidence: [
        { kind: "session", ref: "s1#1", note: "a" },
        { kind: "session", ref: "s1#1", note: "b" }, // dup by (kind,ref) — note is not identity
        { kind: "session", ref: "s2#4", note: "" },
      ],
    });
    expect(independentEvidence(b)).toBe(2);
  });

  it("a single-source llm-extract is provisional; a second source clears it", () => {
    const one = belief({ claim: "y", method: METHOD_EXTRACT, kind: "inferred", watch: [{ kind: "expire", target: "2027-01-01T00:00:00.000Z", expect: "" }], evidence: [{ kind: "session", ref: "s1#1", note: "" }] });
    expect(isProvisional(one)).toBe(true);

    const two = belief({ claim: "y", method: METHOD_EXTRACT, kind: "inferred", watch: [{ kind: "expire", target: "2027-01-01T00:00:00.000Z", expect: "" }], evidence: [{ kind: "session", ref: "s1#1", note: "" }, { kind: "session", ref: "s2#9", note: "" }] });
    expect(isProvisional(two)).toBe(false); // ≥2 independent traces
  });

  it("promotion by method (corroborated) lifts quarantine without touching evidence", () => {
    const b = belief({ claim: "z", method: "corroborated", kind: "inferred", watch: [{ kind: "expire", target: "2027-01-01T00:00:00.000Z", expect: "" }], evidence: [{ kind: "session", ref: "s1#1", note: "" }] });
    expect(isProvisional(b)).toBe(false);
  });

  it("a non-extraction belief is never provisional", () => {
    const b = belief({ claim: "w", method: "read-source", kind: "observed" });
    expect(isProvisional(b)).toBe(false);
  });

  it("describeConfidence shows the number AND its inputs", () => {
    const b = belief({ claim: "q", kind: "observed", method: "read-source", confidence: 0.8 });
    const d = describeConfidence(b);
    expect(d).toContain("0.80");
    expect(d).toContain("read-source");
    expect(d).toContain("corroborating trace");
  });

  it("describeConfidence flags a provisional belief", () => {
    const b = belief({ claim: "p", method: METHOD_EXTRACT, kind: "inferred", confidence: 0.4, watch: [{ kind: "expire", target: "2027-01-01T00:00:00.000Z", expect: "" }], evidence: [{ kind: "session", ref: "s1#1", note: "" }] });
    expect(describeConfidence(b)).toContain("PROVISIONAL");
  });
});
