import { sha256hex } from "./id.js";

// ─────────────────────────────────────────────────────────────────────────────
// The fence. This is the ONLY place in Muster a model call is permitted, and it is
// permitted only at write-time (metabolism), never on the read path. Three rules,
// enforced here so nothing downstream has to remember them:
//
//   1. Zero runtime dependencies. The client is `fetch` (a Node global) + JSON.
//      No SDK, no transitive supply chain — a model call must stay auditable at rest.
//   2. The key lives in ONE env var and its ABSENCE NEVER FAILS. `llmEnabled()` is
//      false, every `complete()` returns null, and the caller runs its mechanical
//      floor. Degraded mode is a first-class mode, not an error path.
//   3. Every completion is fingerprinted (model + a hash of the exact prompt) so the
//      metabolizer's own decisions are auditable: `muster why` can point at the model
//      and prompt that minted a belief. The key itself is never returned, journaled,
//      or logged.
//
// The adapter is *injectable* (see LlmFn): metabolism takes an `llm` function, so tests
// run a deterministic stub — or nothing — and never touch the network.
// ─────────────────────────────────────────────────────────────────────────────

// EXACTLY ONE env var arms the fence — a DEDICATED opt-in, deliberately NOT the ambient
// `ANTHROPIC_API_KEY` (CFG-1). Reading the general key would make any developer who has it
// set spend money on live model calls the moment they metabolize, without ever choosing to.
// Turning muster's model path on is an explicit act: set MUSTER_LLM_KEY.
const KEY_VAR = "MUSTER_LLM_KEY";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001"; // cheap, write-time; override with MUSTER_LLM_MODEL
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 30_000; // a hung model call must never wedge a metabolize (ERR-1)

export interface LlmResult {
  text: string; // the model's response text (already trimmed)
  model: string; // the model that produced it — journaled, never the key
  promptHash: string; // sha256(system + user).slice(0,12) — the audit anchor
}

// The injectable contract. `metabolize(store, { llm })` calls this; in degraded mode
// the caller passes no llm (or `disabledLlm`) and every process falls back to its
// mechanical floor. A stub in tests makes the whole write path deterministic.
export type LlmFn = (system: string, user: string) => Promise<LlmResult | null>;

// True iff the dedicated key is set. Never reads the value here.
export function llmEnabled(): boolean {
  return readKey().length > 0;
}

function readKey(): string {
  return (process.env[KEY_VAR] ?? "").trim();
}

export function activeModel(): string {
  return (process.env.MUSTER_LLM_MODEL ?? "").trim() || DEFAULT_MODEL;
}

// A one-line, key-free description of the model mode — printed at startup so it is never a
// surprise whether a run will reach the network. The key value is never shown.
export function describeLlmMode(): string {
  return llmEnabled()
    ? `model ${activeModel()} (MUSTER_LLM_KEY set — the write path may call the model)`
    : `degraded (no MUSTER_LLM_KEY — fully mechanical; set it to learn from prose)`;
}

export function promptHash(system: string, user: string): string {
  return sha256hex(system + "\x00" + user).slice(0, 12);
}

// The default adapter, resolved from the environment. Returns a function that is a
// no-op (null) whenever the key is absent — so a caller can always do
// `const llm = defaultLlm(); ... await llm(sys, user)` without branching on the key.
export function defaultLlm(): LlmFn {
  if (!llmEnabled()) return disabledLlm;
  const key = readKey();
  const model = activeModel();
  return async (system, user) => {
    const hash = promptHash(system, user);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system,
          messages: [{ role: "user", content: user }],
        }),
        signal: ctrl.signal, // a hung request aborts at REQUEST_TIMEOUT_MS
      });
      if (!res.ok) return null; // a bad request must never poison the store — fall back
      const data = (await res.json()) as { content?: { type: string; text?: string }[] };
      const text = (data.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("")
        .trim();
      if (!text) return null;
      return { text, model, promptHash: hash };
    } catch {
      // Network failure, timeout (abort), DNS, anything — the metabolizer degrades, never dies.
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

// The explicit no-model adapter. `metabolize` uses it when the caller opts out, so the
// degraded path is exercised by name (and by every test) rather than by omission.
export const disabledLlm: LlmFn = async () => null;

// Parse a JSON object/array out of a model response, tolerating prose or ```json
// fences around it. Returns null on any failure — the caller then keeps its mechanical
// result. The model is advisory; malformed output is simply ignored, never trusted.
export function parseJsonBlock<T = unknown>(text: string): T | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  // Walk to the matching close bracket so trailing prose can't break the parse.
  const open = body[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)) as T; } catch { return null; }
      }
    }
  }
  return null;
}
