// Add `days` to an ISO instant, in UTC, returning ISO. Deterministic (it parses a fixed
// input string — no wall clock), so it is safe on any path. One home for what used to be
// five byte-identical copies (DUP-1).
export function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}
