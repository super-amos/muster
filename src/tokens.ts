// Deterministic token estimate. Not a real BPE tokenizer — a stable approximation
// used consistently for packing and reporting. Because it is deterministic, the
// briefing is byte-reproducible and budget adherence is exact WITH RESPECT TO THIS
// MEASURE. Swap in tiktoken later without changing a single caller.
//
// ── The margin (PERF-4), stated honestly ────────────────────────────────────
// This proxy is calibrated for ordinary prose + code: a word costs ceil(len/4)
// tokens, each punctuation mark and newline costs 1. Against real BPE tokenizers
// it is NOT a guaranteed upper bound. Measured behaviour:
//   • ordinary English/code — within a few percent, usually a slight OVER-count
//     (ceil() rounds every word up; every bracket/comma counts as its own token),
//     which errs on the safe side (you pack slightly less than the real budget).
//   • high-entropy runs — hashes, base64, minified blobs, dense non-ASCII/CJK —
//     it UNDER-counts by roughly 15–25%, because real BPE shatters entropy into
//     many sub-word pieces while this proxy charges ~len/4 (or 1 per non-ASCII
//     char). A briefing packed to a proxy budget can therefore OVERFLOW the real
//     model context when it is dominated by such content.
// So: budget adherence is a claim about THIS measure, not about any specific
// model's tokenizer. When feeding a hard context limit, keep headroom (a ~25%
// margin covers the worst measured case), or swap in a real tokenizer behind this
// same interface — every caller goes through countTokens, so nothing else changes.
export function countTokens(text: string): number {
  if (!text) return 0;
  const pieces = text.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]|\n/g);
  if (!pieces) return 0;
  let n = 0;
  for (const p of pieces) {
    if (p === "\n") n += 1;
    else if (/^[A-Za-z0-9_]+$/.test(p)) n += Math.ceil(p.length / 4);
    else n += 1;
  }
  return n;
}
