# Security

Found a security problem in Muster? Please report it privately through GitHub: open the
repository's **Security** tab and click **"Report a vulnerability"** (GitHub's private
vulnerability reporting). That keeps the report between us until there's a fix — please
don't open a public issue for a vulnerability. Muster is maintained by one person, so
responses are best-effort, not same-day.

## Supported versions

Muster is pre-1.0 (0.0.1). Only the latest `main` is supported — fixes land there, and
there are no backports.

## What Muster already does to protect you

These are enforced by the test suite, not just claimed (`tests/redact.test.ts`,
`tests/confine.test.ts`, `tests/integrity.test.ts`):

- **Secrets are redacted** on both write and read, so a key that lands in a session note
  never reaches the store or a briefing.
- **File references can't escape the repo root** — every path is confined to the corpus.
- **Beliefs are content-addressed and signed at rest**, so a hand-edit to a stored claim
  is caught by `muster verify` as tamper.
- **The model is fenced to one place.** The only outbound network call is the optional
  extraction step in `muster metabolize`; it sends redacted session notes and nothing else
  (never your code or commits), and it's off unless you set `MUSTER_LLM_KEY`.

## Good to know

- `MUSTER_LLM_KEY` is read from the environment and is never written to disk by Muster or
  recorded in the journal. Keep it in your environment, not in a committed file.
- The store under `.muster/` is plain text you can audit with `cat`, `grep`, and `git`.
  Treat it like source: review what gets committed before you push it to a shared repo.
