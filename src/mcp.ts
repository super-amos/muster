import { createInterface } from "node:readline";
import { cmdBrief, cmdWhy, cmdTell, cmdSync, cmdDeny, cmdVerify, cmdStatus, cmdMetabolize, cmdLearn, NotFoundError } from "./verbs.js";
import { LeaseBusyError } from "./lease.js";
import { parseHumanInt } from "./num.js";
import { pkgVersion } from "./version.js";
import { describeLlmMode } from "./llm.js";

// A dependency-free Model Context Protocol server. MCP's stdio transport is just
// newline-delimited JSON-RPC 2.0, so no SDK is required — Muster stays boring on
// purpose. It exposes the same verbs an agent would call, so a session can `brief`
// at task start instead of re-deriving context, and interrogate any line with `why`.

interface RpcRequest { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: any; }

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "muster", version: pkgVersion() };

// The corroboration unit is the SESSION principal — the part of a session id before the
// first `#` (see extract.ts `principalsOf`). Over MCP the client supplies `session` freely,
// so if that string WERE the principal, one agent connection could assert a claim under two
// session names and "corroborate" itself out of quarantine. So the principal is the
// CONNECTION, not the caller's string: one stdio server is exactly one connection, so the
// pid is a stable connection identity for the life of the process. A client-supplied session
// is SUBORDINATE — carried AFTER a `#` (with its own `#`s stripped so it can never forge a
// prefix), so `principalsOf` always collapses it back to `mcp:<pid>`. Two genuinely separate
// processes get distinct pids and can corroborate; a single connection never self-corroborates.
// (The CLI's `--session` is trusted by contrast: the human running it IS the authority over
// what counts as an independent source, so it is passed through verbatim.)
export const MCP_CONNECTION = `mcp:${process.pid}`;
export function connectionSession(clientSession: unknown): string {
  const c = typeof clientSession === "string" ? clientSession.replace(/[#\s]+/g, " ").trim() : "";
  return c ? `${MCP_CONNECTION}#${c}` : MCP_CONNECTION;
}

const TOOLS = [
  {
    name: "muster_brief",
    description: "Compile a deterministic, budget-shaped briefing for a task. Read this at task start instead of grepping the repo: standing orders and tripwires (deleted things in your blast radius) come first, then what's true in the code you're touching. Every line is reverified against current sources.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What you are about to do, e.g. 'refactor token issuance in src/auth/token.ts'." },
        budget: { type: "number", description: "Token budget for the briefing (default 2000). Smaller = coarser, never contradictory." },
        repo: { type: "string", description: "Repository root (default: server cwd)." },
        store: { type: "string", description: "Store directory (default: <repo>/.muster)." },
      },
      required: ["task"],
    },
  },
  {
    name: "muster_why",
    description: "Show one belief's full provenance chain — evidence, journal entries, and the exact condition under which it would die. Pass the ⟦e:…⟧ id from any briefing line.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "A belief id, e.g. 'e:7f3a91c0b2d0' (sigils ⟦ ⟧ are accepted)." },
        repo: { type: "string" }, store: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "muster_tell",
    description: "Record a standing directive in the user's voice (never decays, briefed first) or a fact (mortal, ages out). Use for 'always run tests before pushing', 'we deploy through staging first'.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        directive: { type: "boolean", description: "Force a directive (eternal, briefed first). Otherwise wording like 'always/never/must' auto-promotes to one." },
        fact: { type: "boolean", description: "Force a mortal fact (ages out) even when the wording reads like a directive — the explicit 'keep this mortal' override." },
        repo: { type: "string" }, store: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "muster_sync",
    description: "Synchronize memory with reality: ingest the repo's git history and reverify every belief so stale references die before they can mislead. Run after the world moved.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" }, store: { type: "string" },
        maxCommits: { type: "number" }, paths: { type: "string" },
      },
    },
  },
  {
    name: "muster_metabolize",
    description: "Run the fenced write-path metabolizer: promote corroborated candidates, reconcile contradictions, and consolidate bloated belief families into cited principles (keeping the live set flat). With a session log it also extracts new candidate beliefs into quarantine. Fully mechanical unless MUSTER_LLM_KEY is set — the model only adds learning-from-prose, never correctness.",
    inputSchema: {
      type: "object",
      properties: {
        log: { type: "string", description: "Path to a jsonl agent-session log to extract candidate beliefs from (optional)." },
        session: { type: "string", description: "Session id to attribute extracted beliefs to." },
        threshold: { type: "number", description: "Min members to open a new consolidation principle (default 6)." },
        repo: { type: "string" }, store: { type: "string" },
      },
    },
  },
  {
    name: "muster_learn",
    description: "YOU are the model — record facts you distilled from this session, no API key. Each candidate enters the SAME quarantine as fenced extraction: minted single-source and provisional (it briefs only as a verify-first open question), and promoted to trusted ONLY when an independent source asserts the same claim. Use this for durable facts about the codebase you learned by reading it (architecture, where things live, how a flow works) — NOT tasks, opinions, or standing orders (those are muster_tell). Pass session so an independent session's agreement can corroborate.",
    inputSchema: {
      type: "object",
      properties: {
        candidates: {
          type: "array",
          description: "Facts to quarantine. Each: {claim: a single durable declarative fact, subjects: the file paths/symbol names it is about}.",
          items: {
            type: "object",
            properties: {
              claim: { type: "string" },
              subjects: { type: "array", items: { type: "string" } },
            },
            required: ["claim"],
          },
        },
        session: { type: "string", description: "An optional label for this logical session. NOTE: the corroboration unit is this MCP connection (one server process), not this string — a single connection can never corroborate itself, no matter what session labels it uses. Only a genuinely independent process can promote a claim." },
        agent: { type: "string", description: "Who is proposing these (journaled attribution; never stored as evidence, so it cannot self-corroborate)." },
        repo: { type: "string" }, store: { type: "string" },
      },
      required: ["candidates"],
    },
  },
  {
    name: "muster_deny",
    description: "Execute a belief you know to be wrong. The user is the highest court; the belief stays buried through every future re-sync.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, reason: { type: "string" }, repo: { type: "string" }, store: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "muster_verify",
    description: "Integrity by recomputation: detect tamper (a belief edited in place) and drift (a sweep overdue).",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, store: { type: "string" } } },
  },
  {
    name: "muster_status",
    description: "Store health: belief counts by status and kind, tripwires armed, expiries pending.",
    inputSchema: { type: "object", properties: { repo: { type: "string" }, store: { type: "string" } } },
  },
];

async function callTool(name: string, args: Record<string, any>): Promise<string> {
  const common = { repo: args.repo, store: args.store };
  try {
    switch (name) {
      // await the async verbs so their rejections land in THIS catch (a bare return would
      // let the promise escape to the caller's isError handler before we can soften it).
      case "muster_brief": return await cmdBrief({ ...common, task: String(args.task ?? ""), budget: parseHumanInt(args.budget, 2000) });
      case "muster_why": return await cmdWhy({ ...common, id: String(args.id ?? "") });
      case "muster_tell": return await cmdTell({ ...common, text: String(args.text ?? ""), directive: args.directive === true, fact: args.fact === true });
      case "muster_sync": return await cmdSync({ ...common, maxCommits: parseHumanInt(args.maxCommits, 300), pathPrefix: args.paths });
      case "muster_metabolize": return await cmdMetabolize({ ...common, log: args.log, sessionId: connectionSession(args.session), threshold: parseHumanInt(args.threshold, 6) });
      case "muster_learn": return await cmdLearn({ ...common, candidates: Array.isArray(args.candidates) ? args.candidates : [], sessionId: connectionSession(args.session), agent: args.agent });
      case "muster_deny": return await cmdDeny({ ...common, id: String(args.id ?? ""), reason: args.reason });
      case "muster_verify": return cmdVerify(common).text;
      case "muster_status": return cmdStatus(common);
      default: throw new Error(`unknown tool: ${name}`);
    }
  } catch (err) {
    // A busy store or a missing id are expected, recoverable outcomes — surface them as
    // normal tool text (the agent can retry, or fix the id), not a hard tool error.
    if (err instanceof LeaseBusyError || err instanceof NotFoundError) return err.message;
    throw err;
  }
}

export function startMcp(): void {
  const rl = createInterface({ input: process.stdin });
  const send = (msg: unknown): void => { process.stdout.write(JSON.stringify(msg) + "\n"); };
  const reply = (id: RpcRequest["id"], result: unknown): void => send({ jsonrpc: "2.0", id, result });
  const fail = (id: RpcRequest["id"], code: number, message: string): void => send({ jsonrpc: "2.0", id, error: { code, message } });

  rl.on("line", (line) => {
    const s = line.trim();
    if (!s) return;
    let req: RpcRequest;
    try { req = JSON.parse(s); } catch { return; }
    const { id, method, params } = req;
    try {
      switch (method) {
        case "initialize":
          reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
          break;
        case "notifications/initialized":
          break; // notification — no reply
        case "ping":
          reply(id, {});
          break;
        case "tools/list":
          reply(id, { tools: TOOLS });
          break;
        case "tools/call": {
          const toolName = String(params?.name ?? "");
          const args = (params?.arguments ?? {}) as Record<string, any>;
          callTool(toolName, args).then(
            (text) => reply(id, { content: [{ type: "text", text }], isError: false }),
            (err) => reply(id, { content: [{ type: "text", text: `muster error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }),
          );
          break;
        }
        default:
          if (id !== undefined && id !== null) fail(id, -32601, `method not found: ${method}`);
      }
    } catch (err) {
      if (id !== undefined && id !== null) fail(id, -32603, err instanceof Error ? err.message : String(err));
    }
  });

  process.stderr.write(`muster ${pkgVersion()} mcp server ready (stdio, jsonrpc 2.0) · ${describeLlmMode()}\n`);
}
