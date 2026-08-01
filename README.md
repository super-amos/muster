# Muster

Muster gives an AI coding agent memory between sessions. It stores what the agent learns about your repo as small, checkable facts, and before each task it compiles the relevant ones into a briefing that fits a token budget. Every fact knows which change in the code would make it false — when that change lands, the fact dies, and the next briefing carries a warning instead of stale advice.

It's plain Node + TypeScript with zero runtime dependencies, and everything it stores is text you can inspect with `cat`, `grep`, and `git`.

## Quickstart

```bash
npm install && npm run build
node bin/muster.mjs init      # build initial memory from this repo's git history
node bin/muster.mjs brief "refactor token issuance in src/auth/token.ts" --budget 2000
```

`init` needs no LLM and no API key — it scans git history and records facts mechanically: which files exist, which functions they define, which files change together.

The examples below write `muster` for brevity. Run `npm link` once to put that command on your PATH, or keep typing `node bin/muster.mjs` — they're the same thing.

**Requirements:** Node 18 or newer, git, and **macOS or Linux**. Windows isn't supported yet: the store is committed to git, and Windows' default line-ending conversion mangles it on checkout, so a store written on macOS or Linux would fail to load on a Windows teammate's machine. It's on the roadmap.

## The failure it's built around

Anyone who's used agent memory has seen this one: the agent confidently calls a function that was deleted three weeks ago, because a note about it is still sitting in some file or vector index. In Muster that can't happen. Each stored fact carries a "watch" on the code it describes; the commit that deletes `refreshToken()` kills the fact the next time you run `muster sync`, and the next briefing opens with a warning that cites the deleting commit:

```
## §3 TRIPWIRES — deleted/removed things in your blast radius. DO NOT USE THESE.
⛔ `refreshToken` was defined in `src/auth/token.ts` until it was removed (commit c19e8de). Do not call it. ⟦e:8dd87a933013⟧

## §4 THE SITUATION — what is true in the code you are touching
• `issueToken` (function) is defined in `src/auth/token.ts`. ⟦e:f768430dfe44⟧
```

(The test suite calls this scenario "the scar.") The dead fact keeps its id, so its whole life and death stay one query away:

```
$ muster why e:8dd87a933013
e:8dd87a933013  observed · dead · confidence 0.80 (read-source)
  claim:    `refreshToken` (function) is defined in `src/auth/token.ts`.
  ✝ DIED:   falsified on 2026-07-30 — killed by c19e8de
  evidence: file src/auth/token.ts
```

## How it works

Three ideas carry the design:

**Facts are mortal.** Muster calls its facts *beliefs*: one statement, plus evidence for where it came from, plus a watch describing what would make it false. A linter refuses to store any belief that has no evidence or no way to die — standing instructions you give by hand are the one exception.

**Briefings are compiled, not searched.** `muster brief` is a pure function of the stored beliefs, your task, and the budget. Same inputs, byte-identical output — no model call, no network, ever, on the read path. A bigger budget only adds material, so the 4k briefing is always a subset of the 200k one, never a contradiction of it.

**Every line is traceable.** Each briefing line ends in an id that `muster why` resolves to the belief behind it, and from there to the commits and events that produced it.

## The commands

```bash
muster init                          # first sync, then offers to wire your agent (see below)
muster sync                          # re-check every belief against the repo as it is now
muster brief "<task>" --budget 8k    # compile the briefing for a task
muster why  e:7f3a91c0b2d0           # trace any briefing line back to its source
muster tell "deploys go through staging first" --directive   # a standing order; never expires
muster learn --json '[{"claim":"…"}]'   # feed in facts distilled by the agent you're already running
muster metabolize                    # maintenance: merge redundant beliefs, resolve conflicts, extract from notes
```

Also: `verify` (recompute every id and catch tampering), `deny` (kill a belief by hand — you outrank the evidence), `status`, `uninstall` (undo the wiring; `--purge` deletes the memory too), and `mcp`, a built-in Model Context Protocol server so agents like Claude Code can call these as tools.

## Making your agent actually use it

Installing muster changes nothing by itself — an agent will keep grepping out of habit. `muster init` closes that gap. After the first sync it offers to wire the repo; in a script or agent session, pass the answer as a flag:

```bash
muster init --wire        # register the MCP server (.mcp.json) + append a fenced
                          # standing order to CLAUDE.md/AGENTS.md: brief first, grep to verify
muster init --wire-hook   # the above, plus a Claude Code hook that compiles a briefing
                          # for every prompt and injects it before the agent does anything
muster init --no-wire     # just sync, ask nothing
```

The hook is safe to run on every prompt because the read path is deterministic and model-free — no key, no network, no latency worth noticing. When an *agent* runs a bare `muster init`, the offer prints addressed to the agent itself, telling it to run `--wire`.

Everything wiring writes is marker-fenced, so `muster uninstall` removes exactly what was added and leaves your own config and instruction files untouched. Your memory in `.muster/` survives an uninstall unless you say `--purge`.

## Where the LLM is allowed — and where it never is

Briefings never involve a model. The one place Muster may call an LLM is the extraction step of `muster metabolize`, which turns session notes into candidate beliefs — and it's optional. When it does call out, it sends only redacted session notes, one turn at a time, to the Anthropic Messages API (`api.anthropic.com/v1/messages`) with a cheap write-time model — never your code, your commits, or the belief store. Redaction on that path can't be turned off. Without `MUSTER_LLM_KEY`, everything else in maintenance (merging, conflict resolution, promotion) still runs, and the full test suite passes.

Any belief with only one source — from a model or anywhere else — goes into quarantine: marked unverified and kept in a clearly labeled verify-first section near the bottom of the briefing. It's promoted, keeping its id, only when an independent second source states the same thing. One confident hallucination can't reach the top of a briefing.

You may not need a key at all. If you're running Muster from inside an agent session, the agent *is* the model: `muster learn` lets it hand over the facts it distilled, and they go through the same quarantine. Corroboration is keyed on the session, so a session can't promote its own claims by repeating them:

```
$ muster learn --json '[{"claim":"Auth issues a 15-minute JWT via issueToken.","subjects":["src/auth/token.ts"]}]' --session alice
learn        1 candidate(s) from agent "claude-code" → 1 quarantined · 0 rejected
$ muster learn --json '[…same claim…]' --session bob
  promote     1 corroborated → trusted (an independent source agreed)
```

## Teams

A team is just several people (and their agents) writing to one store in git. There's no server: each writer appends to its own journal file, and reads merge the files in a deterministic order — so simultaneous writes never conflict, and a `kill -9` mid-write costs at most the interrupted line in that one writer's file. A chaos test proves it: N concurrent writers plus forced kills lose nothing, and `verify` stays clean.

Only `sync` and `metabolize`, which rewrite belief files, take a lock — a lock file with a timeout, so a crashed process can't wedge the store. Reading never locks. `muster tell --private` keeps a belief on your machine: it shapes your briefings but is never written to shared memory. And when two teammates assert opposite things and nothing separates them, Muster records a dispute and briefs it as an open question — never both sides as truth.

## Does it actually help a real agent?

The honest test isn't Muster versus a strawman retriever — it's the *same capable coding agent doing the same task twice*: once with Muster wired, once without, both free to grep, read files, and dig through git history as they like. Only the memory differs. That's what the **`muster-eval` skill** runs ([`.claude/skills/muster-eval/`](./.claude/skills/muster-eval)), and it's built to be honest in both directions:

- **The scar (Muster's weak case).** It renames a symbol on a throwaway branch so the old name survives only in git history, then hands both agents a task that references the old name — the way a stale ticket or a half-remembered API actually poisons you. A capable agent usually *isn't* fooled: it reads current source, finds the truth, and even digs up the commit. So here Muster often just saves a step or two and hands over the removing commit for free — and the skill says so, reporting "no difference" when that's the truth.
- **The ungreppable fact (Muster's strong case).** It records a standing directive or a past decision that is *nowhere in the current source*, then sets a task whose correct answer depends on it. Grep can't find what was never written into the code; Muster briefs it in §2. This is where the with-Muster arm pulls clearly ahead — it honors a convention the without-Muster arm can't even see.

Each scenario spins up two subagents, grades their answers against a known-correct key, and scores correctness, poisoning (did it call a deleted symbol?), effort (tool calls, tokens), and provenance. It needs a host that can spawn subagents (Claude Code) — the agent in the loop is the *host's* model, never Muster's: the read path still makes zero model calls.

Run it from an agent session: `/muster-eval`.

## Guarantees the tests enforce

- Same store + task + budget → byte-identical briefing, every time.
- A bigger budget only adds; briefings at different budgets never contradict each other.
- No belief without evidence and a way to die (standing instructions exempt).
- Every briefing line resolves to a belief and a real recorded event.
- Ids are content hashes; `verify` recomputes them and catches in-place edits.
- Secrets are redacted on write and on every read; file references can't escape the repo root.
- Everything except LLM extraction runs — and the whole suite passes — with the model disabled.
- Old beliefs fold into summary principles that cite every belief they absorbed, so the active set stays flat over years while the record keeps everything.

## Layout

| Layer | What it does | Files |
|---|---|---|
| Traces | append-only log of evidence events — the one permanent record | `journal.ts` |
| Beliefs | one falsifiable statement + evidence + watches | `types.ts` `frontmatter.ts` `id.ts` `store.ts` `lint.ts` `watch.ts` |
| Bootstrap | mechanical beliefs from git: files, symbols, co-change, churn, tests | `ingest.ts` `symbols.ts` |
| Compiler | task → relevant beliefs → packed, budget-shaped briefing | `linker.ts` `tokens.ts` |
| Metabolizer | write-path maintenance: extraction + quarantine, merging, conflict resolution, confidence | `metabolize.ts` `extract.ts` `consolidate.ts` `reconcile.ts` `confidence.ts` `llm.ts` |
| Many writers | per-writer journals, deterministic merge, the mutation lock, the private overlay | `principal.ts` `journal.ts` `lease.ts` `store.ts` |
| Verbs | the commands, plus integrity, redaction, and path confinement | `verbs.ts` `integrity.ts` `redact.ts` `confine.ts` |
| Interfaces | CLI, the built-in MCP server, and agent wiring (`init --wire`, `uninstall`, the briefing hook) | `cli.ts` `mcp.ts` `wire.ts` |

## Testing and status

```bash
npm test            # 232 tests, 37 suites
/muster-eval        # agent-in-the-loop evaluation (a Claude Code skill; see above)
```

The evaluation used to live in `npm run bench`, but a benchmark that races a strawman retriever can't show what actually matters — how a real agent behaves — so it became the `muster-eval` skill. The deterministic guarantees that bench used to assert live where they belong: in the test suite (mortality/tripwires, integrity by recomputation, budget-monotonicity, byte-identical briefings).

Five milestones are built and green: the git bootstrap, the expiry engine, the model-free briefing compiler, the fenced maintenance step, and multi-writer team support with crash-safety proven under chaos testing. The roadmap and full design rationale live in [`PLAN.md`](./PLAN.md); [`docs/origin-engram.md`](./docs/origin-engram.md) records the original solo design this grew from.

## License

Free to read, run, modify, and embed — including in commercial products and internal repos. The one restriction: you may not give others a product that competes with Muster — anything marketed as a substitute for its functionality or value — no matter how it's built or delivered (a rewrite, a port, a hosted service, a plugin). That's the [PolyForm Perimeter License 1.0.0](./LICENSE) — source-available, deliberately not an OSI "open source" license. Copyright 2026 Amos Shlomovich.
