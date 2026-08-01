// Muster — the WIDE surface: every concern, re-exported. This is the deep/unstable
// entrypoint (`muster/internal`) for tests, tooling, and advanced embedders that need
// the primitives the curated public surface (`./index.ts`, the `.` export) deliberately
// hides — content-addressing internals, the journal/lease mechanics, symbol/watch/schema
// internals, the reconcile/consolidate stages. Nothing here is a semver commitment.
export * from "./types.js";
export { resolveLoc, privateLoc, journalDir, journalShard, type Loc } from "./paths.js";
export { Store } from "./store.js";
export { beliefId, recomputeId, contentHash, sha256hex, canonicalJson } from "./id.js";
export { serializeBelief, parseBelief, signBelief } from "./frontmatter.js";
export { FORMAT_VERSION, schemaIssues, exhaustive } from "./schema.js";
export { appendTrace, appendTraceTo, readTraces, makeTrace, journalFiles } from "./journal.js";
export { currentWriter, setWriter, resetWriter, slugWriter } from "./principal.js";
export {
  acquireLease, releaseLease, readLease, withLease, LeaseBusyError, type Lease,
} from "./lease.js";
export { lintBelief, assertBelief, LintError } from "./lint.js";
export { redact, containsSecret, shannonBits } from "./redact.js";
export { confine, isConfined, ConfinementError } from "./confine.js";
export { ingestGit, ingestAgentLog, extractSymbols, type IngestReport } from "./ingest.js";
export { sweep, evalWatch, definesSymbol, type SweepResult } from "./watch.js";
export { languageOf, splitSymbolTarget, type Sym } from "./symbols.js";
export { compileBriefing, parseTask } from "./linker.js";
export { verifyStore, type VerifyReport, type VerifyIssue } from "./integrity.js";
export { countTokens } from "./tokens.js";
export { parseHumanInt, clamp01 } from "./num.js";
export { addDays } from "./dates.js";
export { pkgVersion } from "./version.js";

// M3 — the fenced metabolizer. Every process below has a mechanical floor; the LLM
// only adds learning-from-prose, and its absence never fails a gate.
export {
  llmEnabled, defaultLlm, disabledLlm, activeModel, promptHash, parseJsonBlock, describeLlmMode,
  type LlmFn, type LlmResult,
} from "./llm.js";
export {
  isProvisional, independentEvidence, corroborationBonus, describeConfidence,
  METHOD_EXTRACT, CORROBORATION_MIN,
} from "./confidence.js";
export {
  extractFromSpans, promoteCorroborated, learnCandidates,
  type ExtractReport, type PromoteReport, type LearnCandidate, type LearnReport, type LearnOptions,
} from "./extract.js";
export {
  reconcile, resolveContradiction, detectContradictions, arePolarOpposites,
  type ReconcileReport, type Verdict,
} from "./reconcile.js";
export { consolidate, type ConsolidateReport, type PrincipleReport } from "./consolidate.js";
export { metabolize, readSpans, type MetabolizeReport, type MetabolizeOptions } from "./metabolize.js";

export {
  cmdSync, cmdBrief, cmdWhy, cmdTell, cmdDeny, cmdVerify, cmdStatus, cmdMetabolize, cmdLearn, NotFoundError,
  type SyncArgs, type BriefArgs, type WhyArgs, type TellArgs, type DenyArgs, type MetabolizeArgs, type LearnArgs,
} from "./verbs.js";
