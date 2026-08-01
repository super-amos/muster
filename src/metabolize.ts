import { existsSync, readFileSync } from "node:fs";
import { Store } from "./store.js";
import { appendTrace, makeTrace } from "./journal.js";
import { defaultLlm, llmEnabled, activeModel, type LlmFn } from "./llm.js";
import { extractFromSpans, promoteCorroborated, type ExtractReport, type PromoteReport } from "./extract.js";
import { reconcile, type ReconcileReport } from "./reconcile.js";
import { consolidate, type ConsolidateReport } from "./consolidate.js";

// ─────────────────────────────────────────────────────────────────────────────
// The metabolizer — the write-path where intelligence is allowed, fenced (PLAN §7).
// It sequences the five processes so each sees the settled output of the last:
//
//   1. extract      (LLM, optional)  raw prose spans → quarantined candidate beliefs
//   2. promote      (mechanical)     quarantined beliefs with independent corroboration
//                                    → trusted (in place, id preserved)
//   3. reconcile    (mechanical)     polar-opposite live beliefs → winner + superseded
//                                    loser, or a dispute briefed as an open question
//   4. consolidate  (mechanical)     bloated orientation/fact families → one principle
//                                    citing every member (total-citation); members retired
//
// Extraction runs FIRST so a fact learned this session can be corroborated and
// consolidated in the same pass; consolidation runs LAST so it never folds a belief
// that is about to be superseded. Everything but extraction is model-free — so with no
// key the metabolizer still promotes, reconciles, and consolidates. That is the whole
// point of the degraded-mode gate: intelligence ADDS learning-from-prose; it is never
// load-bearing for correctness.
//
// Every decision is journaled with the model + prompt hash (see extract/reconcile/
// consolidate traces), so `muster why` works on the metabolizer's own choices.
// ─────────────────────────────────────────────────────────────────────────────

export interface MetabolizeOptions {
  llm?: LlmFn; // injected adapter; defaults to the env-resolved fence (disabled without a key)
  spans?: string[]; // prose to extract from; omit to run the mechanical spine only
  sessionId?: string;
  threshold?: number; // consolidation threshold (min members to open a new principle)
  redact?: boolean;
  now?: Date; // injected for deterministic tests
}

export interface MetabolizeReport {
  model: string; // the model that ran, or "disabled"
  liveBefore: number;
  liveAfter: number;
  extract?: ExtractReport;
  promote: PromoteReport;
  reconcile: ReconcileReport;
  consolidate: ConsolidateReport;
}

export async function metabolize(store: Store, opts: MetabolizeOptions = {}): Promise<MetabolizeReport> {
  const now = opts.now ?? new Date();
  const llm = opts.llm ?? defaultLlm();
  const liveBefore = store.all().filter((b) => b.status === "live").length;

  let extract: ExtractReport | undefined;
  if (opts.spans && opts.spans.length) {
    extract = await extractFromSpans(store, opts.spans, llm, {
      sessionId: opts.sessionId, now, redact: opts.redact,
    });
  }

  const promote = promoteCorroborated(store, now);
  const reconcileReport = reconcile(store, { now });
  const consolidateReport = consolidate(store, { threshold: opts.threshold, now });

  const model = extract?.model && extract.model !== "disabled"
    ? extract.model
    : (llmEnabled() ? activeModel() : "disabled");
  const liveAfter = store.all().filter((b) => b.status === "live").length;

  appendTrace(store.loc, makeTrace("metabolize", {
    actor: `metabolize:${model}`,
    note: `extract ${extract?.minted ?? 0} · promote ${promote.promoted.length} · resolve ${reconcileReport.resolved.length} · dispute ${reconcileReport.disputes.length} · consolidate ${consolidateReport.principles.length} (retired ${consolidateReport.retired}) · live ${liveBefore}→${liveAfter}`,
  }));

  return { model, liveBefore, liveAfter, extract, promote, reconcile: reconcileReport, consolidate: consolidateReport };
}

// Read a jsonl agent-session log into prose spans for extraction — the same file shape
// `ingestAgentLog` consumes ({role|type, text|content}). User and assistant turns both
// carry durable facts, so both become spans; redaction happens inside extraction.
export function readSpans(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  const out: string[] = [];
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(s) as Record<string, unknown>; } catch { continue; }
    const text = String(ev.text ?? ev.content ?? ev.message ?? "").trim();
    if (text.length >= 24) out.push(text);
  }
  return out;
}
