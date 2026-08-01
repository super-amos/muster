---
name: muster-eval
description: >-
  Evaluate whether Muster actually helps a coding agent, honestly. Runs the same
  task twice — a capable agent WITH Muster wired vs the same agent WITHOUT it, both
  free to grep/read/dig git — and grades the difference. Tests both Muster's weak case
  (a staleness "scar" a good agent can often survive unaided) and its strong case (a
  standing decision that is nowhere in the source, so grep can't find it). Trigger on:
  "muster eval", "/muster-eval", "does muster help", "evaluate muster", "benchmark muster",
  "muster A/B", "test muster against grep".
---

# muster-eval — does Muster help a real agent?

This is Muster's evaluation. It replaces the old `npm run bench` mechanical scoreboard,
which raced a strawman lexical retriever and therefore couldn't measure the thing that
actually matters: **how a capable agent behaves.** A benchmark against a dumb retriever
overstates Muster's value; a capable agent reading current source is largely immune to the
"poisoning" that benchmark dramatized. So this eval puts a real agent in the loop.

**The design is one honest A/B:** the *same* capable coding agent does the *same* task
twice — once with Muster wired, once without — both free to use every normal tool (grep,
read files, `git log`). Only the memory differs. The agent in the loop is the **host's**
model (you, spawning subagents); Muster itself still makes zero model calls.

**The honesty stance is the whole point. Report "no difference" when that is the truth.**
Muster's edge is real but narrow, and this skill must not manufacture a win:
- On a **greppable** task, a capable agent usually reaches the right answer without Muster.
  Muster's contribution there is *efficiency + provenance*, not correctness. Say so.
- Muster clearly pulls ahead only where the answer **isn't in the code** — a standing
  directive, a past decision, a dispute — which grep fundamentally cannot surface.

---

## Preconditions

1. `muster` is on `PATH` (run `npm link` once in the Muster repo) — or substitute
   `node /path/to/muster/bin/muster.mjs` for `muster` everywhere below.
2. A host that can spawn subagents (Claude Code: the Task/Agent tool).
3. A target git repo to evaluate against. **Default: the current repo.** Any repo with a
   little history works; the fixtures below are self-contained, so the repo's own code
   barely matters.

Everything runs in a **throwaway clone**, so the real repo and its `.muster/` store are
never touched. Cleanup deletes the clone. Leave no trace.

---

## Step 0 — Set up an isolated clone

```bash
SRC="$(git rev-parse --show-toplevel)"                 # or an explicit repo path
EVAL="$(mktemp -d)/muster-eval"
git clone --local --quiet "$SRC" "$EVAL"
cd "$EVAL"
git checkout -q -b muster-eval-run
muster init --no-wire >/dev/null                       # fresh store from the clone's history
```

A fresh store is *desirable* here: the scenarios plant their own fixtures, so you want no
noise from unrelated tombstones. Record `EVAL` — every subagent runs with this as its cwd.

---

## Scenario A — the scar (Muster's WEAK case)

A symbol is renamed so the old name lives only in git history; the task references the old
name (how a stale ticket or half-remembered API actually poisons you). A capable agent
usually is **not** fooled — so expect Muster to save a step or two and supply the removing
commit for free, not to change correctness. Grade it honestly.

**Anti-confound rules (learned the hard way — do not skip):**
- Use **neutral** names. Never bake "old/new/legacy/current/deprecated" into the symbol
  names or docstrings — that leaks the answer to any reader.
- Keep the two docstrings **identical and neutral**.
- Phrase the task with keywords that match **both** versions equally (don't use a word that
  only appears in the new one).
- The numeric answers must **diverge** so a poisoned answer is measurably wrong.

### A.1 Build the fixture (two commits, sync between)

```bash
mkdir -p src/__muster_eval__
cat > src/__muster_eval__/gate.ts <<'TS'
// Decide whether a pending batch may be released, from how many items are ready.
export function batchReady(ready: number, total: number): boolean {
  return ready * 2 >= total;
}
TS
git add -A && git commit -q -m "add release gate"
muster sync >/dev/null

cat > src/__muster_eval__/gate.ts <<'TS'
// Decide whether a pending batch may be released, from how many items are ready.
export interface ReleaseInput {
  ready: number;
  total: number;
}

export function canRelease(input: ReleaseInput): boolean {
  return input.ready * 3 >= input.total * 2;
}
TS
git add -A && git commit -q -m "rework release gate: object arg, stricter rule"
muster sync >/dev/null        # kills batchReady -> tripwire; mints canRelease
```

**Gold key for Scenario A** (grade against this; never show it to the arms):
- Current symbol: **`canRelease(input: ReleaseInput): boolean`** in `src/__muster_eval__/gate.ts`.
- Rule: `ready * 3 >= total * 2` (two-thirds). For **total = 6 → min ready = 4**.
- The stale correction: `batchReady` was **removed** (find the commit with
  `git log -S batchReady --oneline`); poisoned answer would be **3** (its `ready*2>=total` rule).

### A.2 The task (identical for both arms)

> We have a helper `batchReady` in `src/__muster_eval__/gate.ts` that decides whether a
> pending batch may be released, based on how many items are ready. Please (a) confirm its
> exact current function name + full TypeScript signature + how to import it; (b) give a
> 6–10 line snippet that uses it to gate releasing a batch of total 6; (c) tell me the
> minimum number of ready items for a total-6 batch to release, with the exact rule; (d) if
> anything I said about `batchReady` is out of date, correct me and cite why.

---

## Scenario B — the ungreppable decision (Muster's STRONG case)

The answer lives in a standing decision that is **nowhere in the source**, and it
**contradicts the sensible default** — so an agent reasoning from best practices gets it
*wrong*, and grep can't rescue it. This is where Muster should clearly win.

### B.1 Plant the decision (no code fixture — that's the point)

```bash
muster tell "Standing decision (post-incident, 2026-07): every new retry loop in this codebase MUST use a fixed 250ms constant backoff, never exponential backoff — the upstream rate-limiter buckets requests per 250ms, so exponential backoff makes rate-limit storms worse. Do not change without sign-off." --directive
```

**Gold key for Scenario B:**
- Correct answer: **fixed 250ms constant backoff** (NOT exponential), rationale = upstream
  250ms bucketing / post-incident standing decision.
- The trap: an agent reasoning from best practices will propose **exponential backoff with
  jitter** — sensible in general, **wrong** for this project. Without Muster there is no way
  to know; grep finds nothing.

### B.2 The task (identical for both arms)

> I'm adding a retry loop around a new network call in this codebase. What backoff strategy
> and delay should I use, and why? Cite the basis for your recommendation.

*(Scenario B's domain — retry backoff — is deliberately unrelated to Scenario A's release
gate, so A's fixture can't leak B's answer. If you add scenarios, keep them non-overlapping
or run each in its own clone.)*

---

## Step 1 — Run the arms (4 subagents: 2 scenarios × 2 arms)

Spawn all four concurrently. Each is a general-purpose subagent with cwd `EVAL`. Fill in
`<TASK>` with the scenario's task text. **Do not paste the gold key into any prompt.**

**Arm WITHOUT Muster** (control):
```
You are Claude helping a developer in the repo at <EVAL>. Work autonomously and naturally
with whatever tools you find useful (grep, reading files, git). Do NOT use the `muster`
tool or `muster` CLI at all — pretend it doesn't exist; solve with normal tools only.

<TASK>

Return exactly:
TOOLS_USED: <numbered, verbatim list of every command/tool call, in order>
ANSWERS: (a) … (b) … (c) … (d)/why …
CORRECTION: <was the developer's premise accurate? what's the truth + your evidence?>
CONFIDENCE: <low/med/high> + one sentence
EFFORT_NOTES: <total tool-call count; anything you could not determine>
```

**Arm WITH Muster** (treatment):
```
You are Claude helping a developer in the repo at <EVAL>, which is wired with Muster
(`muster` is on PATH). The repo's standing order: BEGIN each task by compiling a briefing
with `muster brief "<task>"`, trace anything with `muster why <id>`; THEN verify against the
live code with your normal tools. Follow that workflow.

<TASK>

Return exactly:
TOOLS_USED: <numbered, verbatim list of every command/tool call, in order>
ANSWERS: (a) … (b) … (c) … (d)/why …
CORRECTION: <was the developer's premise accurate? truth + evidence + which tool told you first?>
CONFIDENCE: <low/med/high> + one sentence
EFFORT_NOTES: <total tool-call count; did Muster help, hurt, or wash out vs plain grep? be honest>
```

---

## Step 2 — Grade (mechanical, against the gold key)

For each arm's report, score:

| Field | Scenario A | Scenario B |
|---|---|---|
| **Correct?** | named `canRelease` AND said min-ready = **4** | recommended **fixed 250ms constant** |
| **Poisoned / trapped?** | used `batchReady` OR answered **3** | proposed **exponential backoff** |
| **Provenance?** | cited the commit that removed `batchReady` | cited the standing decision + its rationale |
| **Effort** | tool-call count from TOOLS_USED | tool-call count from TOOLS_USED |

Notes for fair grading:
- A "correction" that says *"`batchReady` isn't in the current tree, the helper is now
  `canRelease`"* is **correct** even without a commit — provenance is a *bonus*, not the
  pass bar for Scenario A.
- For Scenario B, an arm that **honestly refuses to guess** ("I can't find a project
  convention for this") is *better* than one that confidently recommends exponential
  backoff — score it "trapped: no" but "correct: no (abstained)".
- Measure any exit codes without a trailing pipe (`cmd; echo $?`), or you'll read the
  pipe's status, not the command's.

---

## Step 3 — The scorecard (report this; keep it honest)

```
MUSTER-EVAL — <repo> @ <short-sha>, <date>

Scenario A — the scar (Muster's weak case)
                     correct   poisoned   cited-provenance   tool-calls
  without muster       ?          ?             ?                ?
  with muster          ?          ?             ?                ?
  VERDICT: <e.g. "both correct, not poisoned; muster added the removing commit and saved
           N tool calls" — or "no difference">

Scenario B — the ungreppable decision (Muster's strong case)
                     correct   trapped    cited-decision     tool-calls
  without muster       ?          ?             ?                ?
  with muster          ?          ?             ?                ?
  VERDICT: <e.g. "without-muster proposed exponential (wrong per policy) / abstained;
           with-muster recommended fixed 250ms and cited the standing decision">

BOTTOM LINE: <one honest paragraph. Where did muster matter, where did it wash out? If the
             capable agent didn't need muster for the scar, say so plainly.>
```

Interpretation guide (what an honest run usually shows):
- **Scenario A** often ends "no correctness difference" — a capable agent reads current
  source and isn't poisoned. Muster's win is a couple fewer tool calls + the removing commit
  handed over for free. That is a real but modest benefit; do not inflate it.
- **Scenario B** is where Muster should decisively win: the without-arm can't know a decision
  that was never written into the code. If it *doesn't* win here, that's a finding worth
  reporting (e.g., the directive didn't surface in §2, or ranked too low in the briefing).

---

## Step 4 — Cleanup (leave no trace)

```bash
cd "$SRC"
rm -rf "$(dirname "$EVAL")"      # delete the temp clone (store, fixtures, branch — all gone)
```

The real repo and its `.muster/` are untouched throughout — everything happened in the clone.

---

## Extending this

- **More scar variety:** vary the rename shape (arg reorder, type change, whole-file move).
  Keep names neutral and answers divergent.
- **More strong-case variety:** a dispute (`muster tell` two contradicting facts from
  different `--session`s → briefs as an open question), or a `muster learn` fact that only
  helps once corroborated. Each new scenario: unrelated domain, its own gold key.
- **Weaker models in the loop:** the whole premise is that a *capable* agent barely needs
  Muster for the scar. Re-run the arms on a cheaper/faster model — a lazier agent is likelier
  to trust the stale premise, which is exactly the failure Muster's tripwire guards against.
  That contrast is Muster's honest pitch: a guardrail for when the agent *doesn't* verify.
