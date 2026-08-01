import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { appendTrace, readTraces, makeTrace } from "../src/journal.js";
import { journalPath } from "../src/paths.js";
import { mkTmp, rm } from "./helpers.js";

describe("the journal (append-only, torn-tail tolerant)", () => {
  it("appends and reads back traces in order", () => {
    const store = mkTmp();
    try {
      const loc = { repo: store, store };
      appendTrace(loc, makeTrace("commit", { ts: "2026-05-01T00:00:00Z", actor: "a", note: "one" }));
      appendTrace(loc, makeTrace("commit", { ts: "2026-05-02T00:00:00Z", actor: "b", note: "two" }));
      const traces = readTraces(loc);
      expect(traces.map((t) => t.note)).toEqual(["one", "two"]);
    } finally { rm(store); }
  });

  it("tolerates a torn trailing line (a kill -9 mid-append)", () => {
    const store = mkTmp();
    try {
      const loc = { repo: store, store };
      appendTrace(loc, makeTrace("commit", { note: "good1" }));
      appendTrace(loc, makeTrace("commit", { note: "good2" }));
      // Simulate a partial write: a half-flushed JSON fragment with no newline.
      appendFileSync(join(store, "journal.jsonl"), '{"ts":"2026","kind":"comm', "utf8");
      const traces = readTraces(loc);
      expect(traces.length).toBe(2);
      expect(traces.map((t) => t.note)).toEqual(["good1", "good2"]);
    } finally { rm(store); }
  });

  it("returns [] for a missing journal", () => {
    const store = mkTmp();
    try {
      expect(readTraces({ repo: store, store })).toEqual([]);
    } finally { rm(store); }
  });
});
