// Organ ② — secret redaction. Ingested exhaust (commit messages, diffs, session
// transcripts) is attacker-authorable, and a belief is fed into a future agent's
// context, so ingest is a memory-poisoning surface. We redact secrets at two sites:
// (a) before anything is persisted, and (b) on every dereference read (`muster why`,
// raw spans). Offline only — a fixed regex + entropy ruleset, no network, no model.
//
// Corpus-structural identifiers (git SHAs, muster ids, issue numbers, in-corpus
// paths) are ALLOWLISTED: redacting them would corrupt the provenance gates that
// `muster why` and `muster verify` depend on. Target: zero unredacted secrets on any
// read path, zero corpus-structural ids redacted, ≤1% false positives on benign text.

const PLACEHOLDER = (kind: string): string => `‹redacted:${kind}›`;

// The most text any single redact pass will scan. Claims, notes, and spans are short by
// construction; a pathologically large blob is truncated with a VISIBLE marker (never
// silently dropped) so a downstream reader can't mistake the vanished tail for vetted
// content — and, paired with the bounded/guarded private-key rule below, this keeps
// redaction linear and immune to the catastrophic-backtracking DoS (SEC-2).
// Sized above any realistic briefing (which is bounded by its token budget) so the
// render-path re-redaction (SEC-1) never truncates a legitimate brief, while still capping
// a pathological blob. The ReDoS immunity comes from the bounded/guarded private-key rule,
// NOT from this cap, so raising it is safe.
const REDACT_MAX = 1024 * 1024;

// A rule may carry a cheap `guard`: an O(n) precondition that must hold before its regex
// runs. The private-key rule's gap is the one super-linear pattern in the set, so it only
// runs when a matching END marker is actually present — a stream of unterminated BEGIN
// markers (the DoS shape) skips it entirely instead of backtracking to EOF per marker.
// High-signal, low-false-positive named patterns. Order matters: specific first.
const RULES: { kind: string; re: RegExp; guard?: (t: string) => boolean }[] = [
  // Gap is BOUNDED ({0,8192}) and GUARDED: a real PEM key body is a few KB, and the guard
  // requires an END marker so junk-after-BEGIN can never make the engine scan to EOF.
  { kind: "private-key", guard: (t) => t.includes("-----END") && t.includes("PRIVATE KEY"),
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]{0,8192}?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { kind: "aws-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "gh-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "bearer", re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*\b/g },
  { kind: "basic-auth", re: /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/g },
  // A long hex run that is NOT a git full-sha (40) or a muster id (12) — a SHA-256-length
  // digest or hex secret. Git shas stay allowlisted (provenance depends on them); 64+ hex
  // has no corpus meaning here, so it redacts.
  { kind: "long-hex", re: /\b[0-9a-fA-F]{64,}\b/g },
  // KEY = high-entropy-value assignments (SECRET, PASSWORD, TOKEN, API_KEY, …). Case-
  // INSENSITIVE now: `password=…`, `db_token: …` leaked before because the key had to be
  // uppercase (SEC-1).
  { kind: "assigned-secret", re: /\b([A-Za-z0-9_]*(?:secret|password|passwd|token|apikey|api_key|private_key|access_key|credential)s?)\b\s*[:=]\s*["']?([^\s"']{8,})["']?/gi },
];

// Allowlist: things that LOOK secret-ish but are load-bearing corpus structure. Redacting
// any of these would corrupt the provenance gates `why`/`verify` depend on. Note the
// EXACT-LENGTH hex rules: only git's 7/40-hex and muster's 12-hex are exempt — a 64-hex
// digest or a 32-hex hash is NOT structural here and must redact (SEC-1). The former loose
// "anything with a slash or dot is a path" line is GONE: it exempted AWS secret keys
// (`…/…/…`), so path-shaped tokens are now judged by entropy in `looksLikeSecret` instead.
function isCorpusStructural(tok: string): boolean {
  if (/^e:[0-9a-f]{6,64}$/.test(tok)) return true; // muster belief id
  if (/^[0-9a-f]{7}$/.test(tok)) return true; // git short sha
  if (/^[0-9a-f]{40}$/.test(tok)) return true; // git full sha
  if (/^[0-9a-f]{12}$/.test(tok)) return true; // muster content hash
  if (/^#\d+$/.test(tok)) return true; // issue / PR number
  if (/^[\w.@/-]+#\d+$/.test(tok)) return true; // session ref, e.g. session-6b2#12
  return false;
}

// The `assigned-secret` rule matches any identifier ENDING in a credential word, so it also
// fires on innocent compound keys (`crystallizationTokens`, `maxTokens`, `csrfToken`) whose
// value is a config default, not a secret — `crystallizationTokens=<default>` used to be
// clobbered (SEC-1 false positive). Entropy is the WRONG gate here: `<default>` (all-distinct
// chars) scores HIGHER than a real value like `hunter2hunter2hunter2`, so an entropy floor
// would both spare nothing useful and start leaking. The real tell is SHAPE — a redacted
// value is redacted UNLESS it is an unmistakable non-secret: a `<placeholder>`, an ${ENV}/
// $VAR/%WIN% indirection, or a config keyword. This is deliberately conservative: a security
// function must never trade a false positive for a leak, so anything not provably a
// placeholder still redacts (even under a compound key), and every real value string does.
const CONFIG_KEYWORD = /^(?:true|false|null|none|nil|undefined|default|changeme|change-me|example|placeholder|redacted|disabled|enabled|todo|tbd|n\/?a|localhost)$/i;

function assignedValueIsSecret(value: string): boolean {
  const v = value.trim();
  if (/^<[^<>]*>$/.test(v)) return false;               // <default>, <your-token-here>
  if (/^\$\{?[A-Za-z_]\w*\}?$/.test(v)) return false;    // ${ENV_VAR} or $ENV indirection
  if (/^%[A-Za-z_]\w*%$/.test(v)) return false;          // %WINDOWS_VAR%
  if (CONFIG_KEYWORD.test(v)) return false;
  return true;
}

// Shannon entropy in bits/char — the tell for a random secret vs. English or a path.
export function shannonBits(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// A long, high-entropy token with no corpus meaning is treated as a secret. The old rule
// gated on `classes >= 3` (three of lower/upper/digit/symbol), which exempted EVERY single-
// or double-charset secret — long hex, all-lowercase, all-digit — no matter its entropy
// (SEC-1). It now judges by charset shape AND entropy, tuned to keep long code identifiers
// and low-entropy paths safe while catching those single-charset secrets:
function looksLikeSecret(tok: string): boolean {
  if (tok.length < 24 || tok.length > 512) return false;
  if (isCorpusStructural(tok)) return false;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(tok)) return false; // base64/hex-ish only
  const bits = shannonBits(tok);
  const hasLower = /[a-z]/.test(tok), hasUpper = /[A-Z]/.test(tok);
  const hasDigit = /[0-9]/.test(tok), hasSym = /[+/_=-]/.test(tok);
  const classes = Number(hasLower) + Number(hasUpper) + Number(hasDigit) + Number(hasSym);
  if (classes >= 3) return bits >= 3.8; // mixed charset (incl. slash-bearing AWS keys) — clearly secret-like

  // Single/double-charset. Only flag shapes real secrets take, and require more length +
  // entropy so long camelCase identifiers and dotless words are spared.
  if (/^[0-9a-fA-F]+$/.test(tok)) return tok.length >= 32 && bits >= 3.2; // hex digest/secret not on the sha allowlist
  if (/^[0-9]+$/.test(tok)) return tok.length >= 24 && bits >= 3.0; // long all-digit secret
  if (hasSym) return tok.length >= 28 && bits >= 4.0; // base64-ish with symbols but few classes
  return false; // plain alpha runs (identifiers, words) — too much false-positive risk
}

export interface RedactOptions {
  enabled?: boolean; // default true; false = identity (for `--no-redact` debugging)
}

// Redact secrets from a block of text. Idempotent and deterministic. Linear-time and
// bounded: input over REDACT_MAX is truncated with a visible marker before any regex runs.
export function redact(text: string, opts: RedactOptions = {}): string {
  if (opts.enabled === false || !text) return text;
  let out = text.length > REDACT_MAX
    ? text.slice(0, REDACT_MAX) + `\n‹redacted:oversize — ${text.length - REDACT_MAX} bytes past the ${REDACT_MAX}-byte cap were dropped unread›`
    : text;
  for (const { kind, re, guard } of RULES) {
    if (guard && !guard(out)) continue; // skip a super-linear rule when its precondition fails
    out = out.replace(re, (m, ...g) => {
      // For assigned-secret, keep the KEY and redact the value — UNLESS the value is an
      // unmistakable non-secret (a placeholder / env indirection / config keyword), so a
      // config default under a `…Tokens`/`…Secret` key is left intact (see assignedValueIsSecret).
      if (kind === "assigned-secret" && typeof g[0] === "string" && typeof g[1] === "string") {
        return assignedValueIsSecret(g[1]) ? `${g[0]}=${PLACEHOLDER(kind)}` : m;
      }
      return PLACEHOLDER(kind);
    });
  }
  // Entropy sweep over remaining word-ish tokens.
  out = out.replace(/[A-Za-z0-9+/_=-]{24,}/g, (tok) =>
    looksLikeSecret(tok) ? PLACEHOLDER("high-entropy") : tok,
  );
  return out;
}

// True iff redaction would change the text — used to flag poisoned exhaust in reports.
export function containsSecret(text: string): boolean {
  return redact(text) !== text;
}

// Prompt-injection shapes. A REJECT-side guard (never a promote-side matcher): text that
// looks like an attempt to override an agent's instructions must never be minted into a
// belief — least of all an eternal directive briefed first (SEC-3). Shared by every ingest
// boundary (fenced extraction, the host-agent `learn` path, AND the mechanical session-log
// directive path) so none of them can forget it.
export const INJECTION = /\b(ignore (?:the |all |previous|above)|disregard (?:the|all|previous)|system prompt|you are now|new instructions?)\b/i;
export function looksLikeInjection(text: string): boolean {
  return INJECTION.test(text);
}
