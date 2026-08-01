import { readFileSync } from "node:fs";
import type { Belief } from "./types.js";
import { Store } from "./store.js";
import { recomputeId } from "./id.js";
import { signBelief } from "./frontmatter.js";
import { lintBelief } from "./lint.js";
import { schemaIssues } from "./schema.js";
import { evalWatch } from "./watch.js";
import { journalFiles } from "./journal.js";

// Organ ① — integrity by recomputation. A belief's id is a content address over its
// immutable core (claim + evidence). `verify` recomputes that address and recomputes
// the mutable projection (what a fresh reverification would say), then reports every
// divergence. Because the store is a deterministic fold of the journal + reality, any
// mismatch is either tamper (someone edited a belief in place) or drift (a sweep is
// overdue). Nothing here trusts the on-disk status; it re-derives it.

// The `format_version` at which the at-rest signature became mandatory. A belief at or past
// this version is ALWAYS written signed, so a missing `sig:` is tamper, not legacy tolerance
// (SEC-1). It is the introduction version, deliberately a constant — NOT `FORMAT_VERSION`, which
// may advance — so a future bump can never re-open the disarm on already-signed versions.
const SIGNED_SINCE = 1;

export type IssueKind = "id-mismatch" | "signature" | "corrupt" | "schema" | "constitution" | "drift" | "tombstone";

export interface VerifyIssue {
  id: string;
  kind: IssueKind;
  fatal: boolean; // tamper is fatal; drift is a nudge to re-sync
  detail: string;
}

export interface VerifyReport {
  beliefs: number;
  clean: number;
  issues: VerifyIssue[];
  journalLines: number;
  journalTorn: number;
  fatal: boolean;
}

export function verifyStore(store: Store, now: Date = new Date()): VerifyReport {
  const issues: VerifyIssue[] = [];
  const beliefs = store.all();

  for (const b of beliefs) {
    // 1) Content-address integrity. An in-place edit to a load-bearing field yields
    //    a different id — so a stored id that no longer matches its content is tamper.
    const expect = recomputeId(b.claim, b.evidence);
    if (expect !== b.id) {
      issues.push({ id: b.id, kind: "id-mismatch", fatal: true, detail: `content hashes to ${expect}; the id was edited or the claim/evidence was tampered` });
    }

    // 1a) Trust-field integrity (INT-1 / SEC-1). The id pins {claim, evidence}; the signature
    //     pins the fields it does NOT — kind, origin, status, method, confidence, watch, death.
    //     A hand-edit that flips `kind: observed` → `directive` to brief poison as a standing
    //     order leaves the id intact but breaks the signature. Crucially, a MISSING signature
    //     is fatal on any belief at/after the version signatures became mandatory: deleting the
    //     `sig:` line must NOT disarm the check (SEC-1) — that was the whole INT-1 forgery. Only
    //     a genuinely pre-signature belief (no `format_version`) is allowed to carry none.
    if (b.signature !== undefined) {
      if (signBelief(b) !== b.signature) {
        issues.push({ id: b.id, kind: "signature", fatal: true, detail: `trust fields (kind/origin/status/watch/confidence) were edited in place — signature does not match` });
      }
    } else if ((b.formatVersion ?? 0) >= SIGNED_SINCE) {
      issues.push({ id: b.id, kind: "signature", fatal: true, detail: `no signature on a format_version ${b.formatVersion} belief — the \`sig:\` line was stripped (tamper)` });
    }

    // 1b) Schema integrity. A darkened enum or a format version from the future is
    //     structural corruption / incompatibility — fatal, and NOT something a re-sync
    //     can repair (unlike drift), so it never advertises `muster sync` as the cure.
    for (const s of schemaIssues(b)) {
      issues.push({ id: b.id, kind: "schema", fatal: true, detail: s });
    }

    // 2) The constitution still holds.
    for (const v of lintBelief(b)) {
      issues.push({ id: b.id, kind: "constitution", fatal: false, detail: v });
    }

    // 3) Reproducible projection: does the on-disk status match a fresh reverification?
    const expected = expectedStatus(store.loc.repo, b, now);
    if (expected && expected !== b.status) {
      issues.push({ id: b.id, kind: "drift", fatal: false, detail: `status is "${b.status}" but reality now says "${expected}" — run \`muster sync\`` });
    }

    // 4) A dead belief must still be dead for the reason on its tombstone.
    if (b.status === "dead" && b.tombstone && expected === "live") {
      issues.push({ id: b.id, kind: "tombstone", fatal: false, detail: `tombstoned as ${b.tombstone.death} but the world now supports it again (resurrectable)` });
    }
  }

  // 4b) Corrupt belief files. A truncated `.md` that fails to load is not silently folded
  //     away (which would report "intact" at a lower count) — it is surfaced as fatal.
  for (const le of store.loadErrors) {
    issues.push({ id: le.file, kind: "corrupt", fatal: true, detail: `belief file failed to load: ${le.detail}` });
  }

  // 5) Journal: torn-tail tolerance means a crash costs at most one unparsable line —
  //    per shard. We tally across the legacy file and every writer shard.
  let journalLines = 0;
  let journalTorn = 0;
  for (const { path } of journalFiles(store.loc)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      journalLines++;
      try { JSON.parse(s); } catch { journalTorn++; }
    }
  }

  const fatal = issues.some((i) => i.fatal);
  // `clean` counts LOADED beliefs with no issue; corrupt-file issues (id = filename) must
  // not deflate it below the true clean-belief count.
  const beliefIds = new Set(beliefs.map((b) => b.id));
  const dirtyIds = new Set(issues.map((i) => i.id).filter((id) => beliefIds.has(id)));
  return { beliefs: beliefs.length, clean: beliefs.length - dirtyIds.size, issues, journalLines, journalTorn, fatal };
}

// What a fresh sweep would conclude for this belief right now. Returns null when the
// belief carries no evaluable watch (e.g., a directive), meaning "no opinion".
function expectedStatus(repo: string, b: Belief, now: Date): Belief["status"] | null {
  if (b.status === "superseded" || b.status === "retired") return null;
  if (b.tombstone?.death === "executed") return "dead"; // the user is the highest court
  if (b.watch.length === 0) return null;
  let sawStale = false;
  for (const w of b.watch) {
    const f = evalWatch(repo, w, now);
    if (f.fired && f.fate === "dead") return "dead";
    if (f.fired && f.fate === "stale") sawStale = true;
  }
  return sawStale ? "stale" : "live";
}
