import type { Belief, BeliefKind, BeliefStatus, WatchClause, Evidence, Tombstone } from "./types.js";
import { FORMAT_VERSION } from "./schema.js";
import { sha256hex, canonicalJson } from "./id.js";

// A per-belief at-rest signature over the load-bearing fields the content-address does
// NOT cover — kind, origin, status, method, confidence, watch, forwarding address, death.
// The id pins {claim, evidence}; this pins the trust/mortality projection, so a hand-edit
// that flips `kind: observed` → `directive` (INT-1) or strips a watch is caught by `verify`
// even though the claim (and the id) are unchanged. Unkeyed and deterministic, exactly like
// the id: it detects naive tamper and corruption, not a forger who also re-signs. Signed
// over the SAME normalized forms serialize writes (confidence via fmtConf), so it round-trips.
const SIG_DOMAIN = "muster-belief-sig-v1|";
export function signBelief(b: Belief): string {
  const basis = canonicalJson({
    kind: b.kind,
    status: b.status,
    origin: b.origin,
    method: b.method,
    confidence: fmtConf(b.confidence),
    supersededBy: b.supersededBy,
    watch: b.watch.map((w) => [w.kind, w.target, w.expect]),
    death: b.tombstone?.death ?? "",
  });
  return sha256hex(SIG_DOMAIN + basis).slice(0, 16);
}

// Belief <-> plain-text markdown. A controlled, greppable format we fully own:
// human-eyeball scalars up top, structured lists in a regular line grammar, and
// the claim as the body. Auditable at rest with nothing but an editor and grep.
export function serializeBelief(b: Belief): string {
  const L: string[] = [];
  L.push("---");
  L.push(`format_version: ${FORMAT_VERSION}`);
  L.push(`id: ${b.id}`);
  // Recomputed fresh from the current fields on every write — never carried over from
  // `b.signature` (which may be a stale/tampered value read off disk).
  L.push(`sig: ${signBelief(b)}`);
  L.push(`kind: ${b.kind}`);
  L.push(`status: ${b.status}`);
  L.push(`confidence: ${fmtConf(b.confidence)}`);
  L.push(`method: ${b.method}`);
  L.push(`origin: ${b.origin}`);
  L.push(`born: ${b.born}`);
  L.push(`last_verified: ${b.lastVerified}`);
  if (b.supersededBy) L.push(`superseded_by: ${b.supersededBy}`);
  if (b.summary) L.push(`summary: ${b.summary.replace(/\s+/g, " ").trim()}`);
  if (b.tombstone) {
    L.push(`tombstone: ${b.tombstone.death} ${b.tombstone.at} ${b.tombstone.by || "-"}`);
    L.push(`obituary: ${b.tombstone.note}`);
  }
  L.push(`subjects: ${JSON.stringify(b.subjects)}`);
  if (b.lineage.length) L.push(`lineage: ${JSON.stringify(b.lineage)}`);
  L.push("watch:");
  for (const w of b.watch) L.push(`  - ${w.kind} ${encField(w.target)} ${w.expect ? encField(w.expect) : "-"}`);
  L.push("evidence:");
  for (const e of b.evidence) L.push(`  - ${e.kind} ${encField(e.ref)}${e.note ? " " + e.note : ""}`);
  L.push("---");
  L.push(b.claim.trim());
  L.push("");
  return L.join("\n");
}

function fmtConf(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export function parseBelief(text: string): Belief {
  // Split on CRLF or LF. A store checked out under `core.autocrlf` (or hand-edited in a
  // Windows editor) arrives with `\r\n`; without this, every `key: value` line fails the
  // scalar match (`.` stops before `\r`, so `$` never anchors), the `id:` line is skipped,
  // and the belief loads blank — a false tamper on a content-addressed store. Normalizing
  // here makes a CRLF file parse byte-identically to its LF twin, so ids never churn.
  // (`.gitattributes` in the store is the systemic guard; this is defense-in-depth on read.)
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() !== "---") i++;
  i++; // past opening ---
  const fm: string[] = [];
  while (i < lines.length && lines[i].trim() !== "---") { fm.push(lines[i]); i++; }
  i++; // past closing ---
  const body = lines.slice(i).join("\n").trim();

  const b = blankBelief();
  b.claim = body;
  let section: "" | "watch" | "evidence" = "";
  for (const line of fm) {
    if (/^\s*-\s+/.test(line)) {
      const item = line.replace(/^\s*-\s+/, "").trim();
      if (section === "watch") b.watch.push(parseWatch(item));
      else if (section === "evidence") b.evidence.push(parseEvidence(item));
      continue;
    }
    const m = line.match(/^([a-z_]+):\s?(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();
    switch (key) {
      case "format_version": { const n = Number(val); if (Number.isFinite(n)) b.formatVersion = n; break; }
      case "id": b.id = val; break;
      case "sig": b.signature = val; break;
      // kind/status are cast, not validated, HERE on purpose: an unknown value is
      // preserved so `verify` (via schemaIssues) can flag it fatally rather than a
      // silent coerce hiding the corruption. The boundary records; verify judges.
      case "kind": b.kind = val as BeliefKind; break;
      case "status": b.status = val as BeliefStatus; break;
      case "confidence": b.confidence = Number(val) || 0; break;
      case "method": b.method = val; break;
      case "origin": b.origin = val; break;
      case "born": b.born = val; break;
      case "last_verified": b.lastVerified = val; break;
      case "superseded_by": b.supersededBy = val; break;
      case "summary": b.summary = val; break;
      case "subjects": b.subjects = safeArr(val); break;
      case "lineage": b.lineage = safeArr(val); break;
      case "tombstone": {
        const [death, at, by] = val.split(/\s+/);
        b.tombstone = {
          death: (death || "falsified") as Tombstone["death"],
          at: at || "",
          by: by === "-" ? "" : (by || ""),
          note: "",
        };
        break;
      }
      case "obituary": if (b.tombstone) b.tombstone.note = val; break;
      case "watch": section = "watch"; break;
      case "evidence": section = "evidence"; break;
      default: break;
    }
  }
  return b;
}

function parseWatch(s: string): WatchClause {
  const parts = s.split(/\s+/);
  const kind = (parts[0] || "path") as WatchClause["kind"];
  const target = decField(parts[1] || "");
  const raw = parts[2] || "";
  return { kind, target, expect: raw === "-" ? "" : decField(raw) };
}

function parseEvidence(s: string): Evidence {
  const parts = s.split(/\s+/);
  const kind = (parts[0] || "derived") as Evidence["kind"];
  const ref = decField(parts[1] || "");
  const note = parts.slice(2).join(" ");
  return { kind, ref, note };
}

// The on-disk watch/evidence grammar is whitespace-delimited (`- <kind> <target> <expect>`),
// so a target or ref that itself contains whitespace — a tracked path like `src/my file.ts`
// (Xcode groups, "My App/", asset dirs) — would mis-split on read: the watch target becomes
// the nonexistent `src/my`, forging a false tombstone on first sync and an id-mismatch +
// signature TAMPER on the round-trip (COR-1). We percent-encode `%` and any whitespace in
// those fields on write and reverse it on read. A value containing neither — the overwhelming
// common case (a path with no spaces) — encodes to itself, so existing stores stay
// byte-identical and no id/signature churns. Only these delimited list fields are encoded;
// the evidence `note` is the free-text tail and keeps its spaces as before.
function encField(s: string): string {
  return s.replace(/[%\s]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}
function decField(s: string): string {
  return s.replace(/%([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

function safeArr(val: string): string[] {
  try {
    const a = JSON.parse(val);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

function blankBelief(): Belief {
  return {
    id: "", kind: "observed", status: "live", claim: "", subjects: [],
    confidence: 0, method: "", watch: [], evidence: [], lineage: [],
    origin: "", born: "", lastVerified: "", supersededBy: "",
  };
}
