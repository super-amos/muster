import { realpathSync, existsSync } from "node:fs";
import { resolve, sep, dirname } from "node:path";

// Organ ② — corpus confinement. Wherever a watch or an evidence pointer dereferences
// a location, it resolves through here first: the path is pinned inside the corpus
// root, and symlink / ".." escapes are rejected. A poisoned belief cannot make Muster
// read /etc/shadow by claiming a watch on "../../../../etc/shadow".
//
// Target: zero reads outside the corpus root, ever.

export class ConfinementError extends Error {
  constructor(rel: string, why: string) {
    super(`refused path "${rel}" outside corpus root (${why})`);
    this.name = "ConfinementError";
  }
}

// Resolve `rel` against `root`, guaranteeing the result stays within `root`.
// Handles not-yet-existing files (a deleted watch target) by realpath-checking the
// deepest existing ancestor — so a symlinked parent directory cannot smuggle an escape.
export function confine(root: string, rel: string): string {
  const rootAbs = resolve(root);
  const rootReal = safeReal(rootAbs);
  const target = resolve(rootAbs, rel);

  // Lexical containment: the resolved path must sit under the root prefix.
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
    throw new ConfinementError(rel, "lexical escape");
  }

  // Symlink containment: realpath the deepest existing ancestor and re-check.
  let probe = target;
  while (!existsSync(probe) && probe !== rootAbs && probe !== dirname(probe)) {
    probe = dirname(probe);
  }
  const probeReal = safeReal(probe);
  if (probeReal !== rootReal && !probeReal.startsWith(rootReal + sep)) {
    throw new ConfinementError(rel, "symlink escape");
  }
  return target;
}

// True iff `rel` is safely inside `root` (no throw form, for filters).
export function isConfined(root: string, rel: string): boolean {
  try {
    confine(root, rel);
    return true;
  } catch {
    return false;
  }
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
