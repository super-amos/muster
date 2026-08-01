# CLAUDE.md — working in Muster

Muster is a memory substrate for AI agents: mortal beliefs compiled into budget-shaped
briefings. Read [`README.md`](./README.md) for the pitch and [`PLAN.md`](./PLAN.md) for
the full design and the gated roadmap.

## Conventions (please keep them)

- **Zero runtime dependencies.** Pure Node + TypeScript. No `yaml`, no MCP SDK, no arg
  parser — everything is hand-rolled on purpose ("boring, auditable at rest"). Do not
  add a runtime dependency without a very good reason. Dev-only deps: `typescript`,
  `vitest`, `@types/node`.
- **ESM + NodeNext.** Source imports use explicit `.js` extensions. Build with `tsc`
  (`npm run build` → `dist/`), then run `node bin/muster.mjs …` or `node dist/cli.js …`.
- **Determinism is load-bearing.** `compileBriefing` must stay a pure function of
  `(store, task, budget)` — no wall clock (recency is measured against the journal head),
  no `Math.random`, no model calls, no network. The read path is model-free, forever.
- **The LLM is fenced to the write path.** In the *product*, the only place a model call
  is permitted is `metabolize` (via `llm.ts`), and only for extraction. Everything else in
  metabolism — promote, reconcile, consolidate, confidence — is mechanical. The key lives
  in one env var, is never journaled, and **its absence never fails a gate** (degraded mode
  is first-class). Never add a model call outside `llm.ts`, and **never on the read path.**
  The `muster-eval` skill puts a model in the loop, but that model is the *host agent's*
  (Claude Code spawning subagents to grade with-vs-without-Muster) — never a muster code
  path. Muster ships zero model calls outside `llm.ts`.
  `muster learn` is NOT a model call: the host agent (Claude Code, an MCP client) brings
  the candidates it distilled, and muster runs them through the *same* quarantine mint as
  `extractFromSpans` — provisional, single-source, promote-on-corroboration. It's the
  un-degraded write path when the caller is already an LLM, and it needs no key.

## Commands

```bash
npm run build      # tsc → dist/
npm test           # vitest: 232 tests, 37 suites
npm run typecheck  # tsc --noEmit
# /muster-eval     # agent-in-the-loop evaluation — a Claude Code skill, not an npm script
#                  # (.claude/skills/muster-eval); needs a host that can spawn subagents
```

## Invariants the tests defend (don't regress these)

- **The scar** (`tests/mortality.test.ts`): a deleted symbol dies at ingest and briefs
  as a tripwire, never as a live definition.
- **Budget-monotonicity + byte-reproducibility** (`tests/linker.test.ts`): the packer
  takes the maximal prefix of a budget-independent atom sequence, so a bigger budget
  only adds beliefs / raises altitude.
- **The constitution** (`tests/lint.test.ts`): no non-directive belief without ≥1 watch
  and ≥1 evidence.
- **Integrity** (`tests/integrity.test.ts`): a belief's id is a content address over
  `{claim, evidence}`; in-place edits are detected as tamper.
- **Security** (`tests/redact.test.ts`, `tests/confine.test.ts`): secrets redacted on
  read/write; every location confined to the corpus root.
- **The degraded-mode gate** (`tests/metabolize.test.ts`): the metabolizer runs fully —
  promote/reconcile/consolidate — with the LLM disabled, and a metabolized store still
  verifies clean.
- **A flat live set** (`tests/consolidate.test.ts`): consolidation folds a synthetic
  year of belief growth into cited principles; the live set stays flat and every member
  is retired with a forwarding address (total-citation). It never absorbs a live
  `read-source` symbol belief or a directive — the scar and standing orders stay granular.
- **Quarantine** (`tests/quarantine.test.ts`): a single-source `llm-extract` belief is
  provisional (derived from provenance, not a flag), capped at A0 in the caution section,
  and promoted in place — id preserved — only when an independent source corroborates it.
- **The reconciliation protocol** (`tests/reconcile.test.ts`): `resolveContradiction` is a
  pure precedence function (evidence kind → recency → trust → dispute).
- **Cross-language symbols** (`tests/languages.test.ts`): extraction and death-detection
  share ONE per-language pattern table (`src/symbols.ts`), so `extractSymbols` and
  `definesSymbol` cannot drift into false tombstones. The scar is proven cross-language
  (a deleted Rust `fn` and a deleted Java method both die). Symbol beliefs carry a
  non-identity `summary` (signature + first doc line), redacted and rendered at A1 —
  never part of the content address, so a reworded comment never churns an id.
- **Read-path ranking stays budget-monotone** (`tests/relevance.test.ts`): the linker
  weights an exported/`pub`/`public` symbol above a private helper (read off the
  non-identity `summary`, so no id churn) and pulls a co-changing file into the blast
  radius even when the task never named it — both are pure functions of `(store, task)`,
  budget-independent, so a smaller briefing stays a subset of a larger one.
- **Concurrency without coordination** (`tests/manyhands.test.ts`, `tests/chaos.test.ts`):
  one journal shard per writer (`src/principal.ts` + `src/journal.ts`), folded
  deterministically by `(ts, writer, position)` — the fold is independent of how appends
  interleave, and a `kill -9` torn line in one shard never loses another writer's traces.
  The **chaos gate**: N concurrent writers + torn tails → zero loss, `verify` stays clean.
- **The metabolizer lease** (`tests/lease.test.ts`): the mutating path (sweep + metabolize)
  runs under a single file lease (`src/lease.ts`) — atomic `O_EXCL` acquire, stealable once
  expired so a crashed holder never wedges the store. The **read path never takes the lease**
  (compilation stays pure and lock-free).
- **Team ⊕ private overlay** (`tests/manyhands.test.ts`): a local `tell --private` belief
  mounts OVER the team store on read (`Store.mergedRead`) but is never written to shared
  memory; a cross-principal contradiction (two teammates, indistinguishable by trust and
  recency) escalates to one honest dispute via the existing reconcile protocol.
- **Bring-your-own-agent quarantine** (`tests/learn.test.ts`): `learnCandidates` (the
  `learn` verb / `muster_learn` MCP tool) routes host-agent-supplied candidates through the
  *same* fence as fenced extraction — provisional, single-source, imperative/injection
  rejected, capped in §7, promoted in place only on independent corroboration. Evidence is
  keyed on the SESSION, so one session can never self-corroborate no matter how often it
  re-asserts; the agent's identity is journaled, never stored as evidence.
- **Reversible wiring** (`tests/wire.test.ts`): everything `muster init --wire` writes
  outside `.muster/` is marker-fenced (`src/wire.ts`) — a wire→uninstall round trip
  restores a user's CLAUDE.md byte-identical, foreign MCP servers and hooks survive
  both directions, malformed JSON is never clobbered, and a broken fence is refused,
  not guessed at. `uninstall` keeps the store unless `--purge`. The briefing hook
  (`muster hook`) is read-path only and silent on ANY doubt — no store, short prompt,
  bad payload — so it can never block or noise up a host agent's prompt.

## Layout

`src/` — one concern per file (see the architecture table in the README). `tests/` —
vitest suites. `.claude/skills/muster-eval/` — the agent-in-the-loop evaluation (with-vs-
without-Muster, run by the host). The store lives in `.muster/` (journal shards + beliefs are
canonical text; `.muster/cache/` is disposable; `.muster/private/` is the local overlay,
gitignored; `.muster/lease.json` is the transient mutation lock).
