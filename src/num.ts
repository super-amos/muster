// Shared numeric-argument normalizer for the CLI and the MCP server, so both accept the
// same human forms and neither silently mis-parses. `--budget 8k` used to become NaN and
// fall back to 2000 (API-3); an MCP `budget: "8k"` used to reach the packer as a STRING,
// where `used > "8k"` is always false and the budget cap effectively vanished (TYP-4).
// One parser closes both: it accepts a number or a string with an optional k/m/g suffix,
// and returns the default for anything non-positive or unparseable.
// Clamp to [0,1] — the one home for what used to be three byte-identical copies (DUP-1).
export function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }

export function parseHumanInt(v: unknown, dflt: number): number {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
  if (typeof v !== "string") return dflt; // boolean (a bare flag), undefined, object → default
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*([kmg])?$/i);
  if (!m) return dflt;
  const mult = m[2] ? ({ k: 1e3, m: 1e6, g: 1e9 } as const)[m[2].toLowerCase() as "k" | "m" | "g"] : 1;
  const n = parseFloat(m[1]) * mult;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}
