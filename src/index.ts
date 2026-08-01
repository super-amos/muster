// Muster — a memory substrate made of mortal beliefs.
//
// The PUBLIC surface: what you need to embed Muster — build a store from a repo's
// exhaust, compile a budget-shaped briefing off the model-free read path, run the fenced
// write path, and verify integrity by recomputation. It is intentionally small and is the
// only surface treated as a semver commitment. The CLI (`./cli`) and MCP server (`./mcp`)
// are thin skins over exactly these functions.
//
// Everything else — content-addressing internals, the journal/lease mechanics, the
// symbol/watch/schema/reconcile/consolidate primitives — lives behind `muster/internal`
// (`./internal.ts`): a wider, deliberately-unstable surface for tests, tooling, and
// advanced embedders. If you reach for `muster/internal`, you are off the stable path.
export * from "./types.js";

// The store and the deterministic, model-free read path.
export { Store } from "./store.js";
export { compileBriefing, parseTask } from "./linker.js";
export { countTokens } from "./tokens.js";

// Constructing and persisting beliefs by content address.
export { beliefId, recomputeId } from "./id.js";
export { serializeBelief, parseBelief } from "./frontmatter.js";

// Bootstrapping memory from a repo's git exhaust (+ optional agent-session log).
export { ingestGit, ingestAgentLog, type IngestReport } from "./ingest.js";

// The fenced write path, and integrity by recomputation.
export { metabolize, type MetabolizeReport, type MetabolizeOptions } from "./metabolize.js";
export { verifyStore, type VerifyReport, type VerifyIssue } from "./integrity.js";

// The verbs — the operations the CLI and MCP server are thin skins over. NotFoundError
// is the one typed outcome a caller must handle (a missing id); LeaseBusyError is the other.
export {
  cmdSync, cmdBrief, cmdWhy, cmdTell, cmdDeny, cmdVerify, cmdStatus, cmdMetabolize, cmdLearn, NotFoundError,
  type SyncArgs, type BriefArgs, type WhyArgs, type TellArgs, type DenyArgs, type MetabolizeArgs, type LearnArgs,
} from "./verbs.js";

// Concurrency + security primitives an embedder is likely to touch directly.
export { withLease, LeaseBusyError, type Lease } from "./lease.js";
export { redact, containsSecret } from "./redact.js";
export { confine, isConfined, ConfinementError } from "./confine.js";

// LLM fencing status — degraded mode is first-class; the key never gates a read.
export { llmEnabled, describeLlmMode } from "./llm.js";
