import { cmdSync, cmdBrief, cmdWhy, cmdTell, cmdDeny, cmdVerify, cmdStatus, cmdMetabolize, cmdLearn, NotFoundError } from "./verbs.js";
import { cmdWire, cmdUninstall, wireState, hookReply, readStdin, WIRE_HINT } from "./wire.js";
import { LeaseBusyError } from "./lease.js";
import { startMcp } from "./mcp.js";
import { parseHumanInt } from "./num.js";
import { pkgVersion } from "./version.js";
import { createInterface } from "node:readline/promises";

// Process exit codes are part of the CLI contract, so scripts and CI can branch on them.
// The read/verify verbs never throw for these outcomes on the happy path; the codes below
// map the two typed outcomes (busy store, missing id) and verify's tamper result.
const EXIT = { OK: 0, ERROR: 1, TAMPER: 2, LEASE_BUSY: 3, NOT_FOUND: 4 } as const;

type FlagVal = string | boolean;
interface Flags { flags: Map<string, FlagVal>; positional: string[]; }

function parse(argv: string[]): Flags {
  const flags = new Map<string, FlagVal>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags.set(key, true);
      else { flags.set(key, next); i++; }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function str(f: Flags, key: string, d = ""): string {
  const v = f.flags.get(key);
  return typeof v === "string" ? v : d;
}
function num(f: Flags, key: string, d: number): number {
  // Accepts plain integers AND human forms (8k, 1.5m); a bare flag or garbage → default.
  return parseHumanInt(f.flags.get(key), d);
}
function pos(f: Flags, i: number, d = ""): string {
  return f.positional[i] ?? d;
}
function bool(f: Flags, key: string): boolean {
  return f.flags.get(key) === true;
}

const HELP = `muster — the un-forgetting
a memory substrate for AI agents. beliefs are mortal; you read a compiled briefing, not the store.

  muster sync    [--repo .] [--store DIR] [--log FILE] [--session ID]
                 [--max-commits 300] [--paths src] [--max-symbols 40]
                 [--no-redact] [--git] [--push]
      synchronize memory with reality: ingest a repo's git history (+ optional
      agent-session log), mint mortal beliefs, reverify the whole store, and
      (with --git) commit it.

  muster init [sync flags] [--wire | --wire-hook | --no-wire]
      first-time sync, then wire your coding agent to default to muster: register
      the MCP server in .mcp.json and add a fenced standing order to CLAUDE.md /
      AGENTS.md. --wire-hook also injects a briefing before every prompt (Claude
      Code hook). In a terminal, init asks; run by an agent, it prints how.

  muster uninstall [--purge] [--repo .] [--store DIR]
      remove everything wiring added to the repo (.mcp.json entry, instruction
      stanza, hook) — only the fenced blocks; your own content is untouched.
      The memory in .muster/ survives; --purge deletes it too.

  muster hook [--budget 1500]
      Claude Code UserPromptSubmit adapter: reads the hook payload on stdin and
      prints a briefing for the prompt. Silent (exit 0) whenever it has nothing
      to say — it can never block a prompt.

  muster metabolize [--log FILE] [--session ID] [--threshold 6] [--git]
                    [--repo .] [--store DIR]
      the fenced write-path intelligence: promote corroborated candidates, reconcile
      contradictions, consolidate bloated families into cited principles, and (with
      MUSTER_LLM_KEY + --log) extract new candidate beliefs into quarantine. Runs the
      full mechanical spine with NO model; the LLM only adds learning-from-prose.

  muster learn [--candidates FILE.json | --json '[…]'] [--session ID] [--agent NAME]
               [--git] [--repo .] [--store DIR]
      the host session IS the model — no key. Feed muster the candidate facts YOU (the
      agent) distilled; they enter the SAME quarantine as fenced extraction: provisional,
      single-source, capped, promoted only when an independent source corroborates.
      Each candidate is {"claim": "…", "subjects": ["src/x.ts", "fnName"]}.

  muster brief "<task>" [--budget 2000] [--json] [--repo .] [--store DIR]
      compile a deterministic, budget-shaped briefing for a task. tripwires and
      obituaries for anything deleted in your blast radius come first.

  muster why <id> [--json] [--repo .] [--store DIR]
      one belief's full provenance chain — evidence, journal, death conditions.

  muster tell "<fact>" [--directive] [--fact] [--private] [--repo .] [--store DIR]
      record a human-authored belief, or a standing directive (never decays).
      wording like "always/never/must" auto-promotes to a directive (a warning
      says so); --fact forces a mortal fact instead, --directive forces eternal.
      --private writes to a local overlay that mounts over team memory but is
      never shared (gitignore .muster/private/).

  muster deny <id> ["reason"] [--repo .] [--store DIR]
      execute a belief. the user is the highest court; it stays buried on re-sync.

  muster verify  [--json] [--repo .] [--store DIR]
      integrity by recomputation — detect tamper (fatal) and drift (re-sync).

  muster status  [--json] [--repo .] [--store DIR]
      store health: counts by status and kind.

  muster mcp
      run the Model Context Protocol server (stdio) exposing the verbs as tools.

  --json  on brief/why/verify/status emits machine-readable JSON instead of text.
  --version, -v   print the muster version and exit.
  exit codes: 0 ok · 1 error · 2 tamper (verify) · 3 store busy · 4 belief not found.
`;

// The adoption step of `muster init`. In a terminal it asks the human; run by an
// agent (no TTY) it prints WIRE_HINT — stdout lands in the agent's context, so the
// hint tells the agent itself to run `muster init --wire`. Already wired → one line.
async function offerWiring(common: { repo: string; store?: string }): Promise<string> {
  const state = wireState(common);
  if (state.mcp && state.stanzaIn.length) {
    return "wire         already wired (`muster uninstall` removes it)";
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) return WIRE_HINT;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const yes = (await rl.question("wire your coding agent to default to muster? [Y/n] ")).trim().toLowerCase();
    if (yes === "n" || yes === "no") return "wire         skipped — `muster init --wire` any time";
    const hook = (await rl.question("also inject a briefing before every prompt (Claude Code hook)? [y/N] ")).trim().toLowerCase();
    return cmdWire({ ...common, hook: hook === "y" || hook === "yes" });
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const f = parse(process.argv.slice(2));
  const cmd = pos(f, 0);
  const common = { repo: str(f, "repo", process.cwd()), store: str(f, "store") || undefined };

  // Version is explicit and exit 0 — checked BEFORE help, because `muster --version` parses
  // to an empty command (the flag isn't positional) and would otherwise fall into help's
  // `!cmd` branch. `-v` arrives as a positional, so match it as a command too.
  if (cmd === "version" || cmd === "-v" || bool(f, "version")) {
    console.log(`muster ${pkgVersion()}`);
    return;
  }
  // Help is explicit and always exit 0 — before dispatch, so `--help` works with any verb.
  if (!cmd || cmd === "help" || cmd === "-h" || bool(f, "help")) {
    console.log(HELP);
    return;
  }
  const KNOWN = new Set(["init", "sync", "metabolize", "learn", "brief", "why", "tell", "deny", "verify", "status", "mcp", "uninstall", "hook"]);
  if (!KNOWN.has(cmd)) {
    // An unknown verb is a usage ERROR (exit 1), not a silent success printing help.
    console.error(`muster: unknown command "${cmd}"\n`);
    console.error(HELP);
    process.exit(1);
  }
  try {
    switch (cmd) {
      case "init":
      case "sync": {
        let text = await cmdSync({
          ...common,
          log: str(f, "log") || undefined,
          sessionId: str(f, "session") || undefined,
          maxCommits: num(f, "max-commits", 300),
          pathPrefix: str(f, "paths"),
          maxSymbols: num(f, "max-symbols", 40),
          redact: bool(f, "no-redact") ? false : true,
          git: bool(f, "git"),
          push: bool(f, "push"),
        });
        // Opt-in: fold the fenced metabolizer into a sync. Mechanical unless a key is set.
        if (bool(f, "metabolize")) {
          text += "\n" + await cmdMetabolize({
            ...common, log: str(f, "log") || undefined,
            sessionId: str(f, "session") || undefined, threshold: num(f, "threshold", 6),
          });
        }
        console.log(text);
        // init is sync + adoption: after the first sync, offer to wire the user's
        // agent so it defaults to muster. Plain `sync` never prompts.
        if (cmd === "init") {
          if (bool(f, "wire") || bool(f, "wire-hook")) {
            console.log(cmdWire({ ...common, hook: bool(f, "wire-hook") }));
          } else if (!bool(f, "no-wire")) {
            const offer = await offerWiring(common);
            if (offer) console.log(offer);
          }
        }
        break;
      }
      case "uninstall":
        console.log(cmdUninstall({ ...common, purge: bool(f, "purge") }));
        break;
      case "hook": {
        // Guards live in hookReply; every outcome is exit 0 with clean stdout.
        const raw = await readStdin();
        const reply = hookReply(raw, { repo: str(f, "repo") || undefined, store: str(f, "store") || undefined, budget: num(f, "budget", 1500) });
        if (reply) process.stdout.write(reply);
        break;
      }
      case "metabolize":
        console.log(await cmdMetabolize({
          ...common,
          log: str(f, "log") || undefined,
          sessionId: str(f, "session") || undefined,
          threshold: num(f, "threshold", 6),
          git: bool(f, "git"),
        }));
        break;
      case "learn":
        console.log(await cmdLearn({
          ...common,
          file: str(f, "candidates") || undefined,
          json: str(f, "json") || undefined,
          sessionId: str(f, "session") || undefined,
          agent: str(f, "agent") || undefined,
          git: bool(f, "git"),
        }));
        break;
      case "brief":
        console.log(cmdBrief({ ...common, task: pos(f, 1) || str(f, "task"), budget: num(f, "budget", 2000), json: bool(f, "json") }));
        break;
      case "why":
        console.log(cmdWhy({ ...common, id: pos(f, 1) || str(f, "id"), json: bool(f, "json") }));
        break;
      case "tell":
        console.log(await cmdTell({ ...common, text: pos(f, 1) || str(f, "text"), directive: bool(f, "directive"), fact: bool(f, "fact"), private: bool(f, "private") }));
        break;
      case "deny":
        console.log(await cmdDeny({ ...common, id: pos(f, 1) || str(f, "id"), reason: pos(f, 2) || str(f, "reason") }));
        break;
      case "verify": {
        const r = cmdVerify({ ...common, json: bool(f, "json") });
        console.log(r.text);
        if (r.fatal) process.exit(EXIT.TAMPER);
        break;
      }
      case "status":
        console.log(cmdStatus({ ...common, json: bool(f, "json") }));
        break;
      case "mcp":
        startMcp();
        break;
    }
  } catch (err) {
    // Two outcomes get their own exit code so scripts can branch; both still print a
    // human line. A busy store and a missing id are ordinary conditions, not crashes.
    if (err instanceof LeaseBusyError) { console.error("muster: " + err.message); process.exit(EXIT.LEASE_BUSY); }
    if (err instanceof NotFoundError) { console.error("muster: " + err.message); process.exit(EXIT.NOT_FOUND); }
    console.error("muster: " + (err instanceof Error ? err.message : String(err)));
    process.exit(EXIT.ERROR);
  }
}

main();
