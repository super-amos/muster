// ─────────────────────────────────────────────────────────────────────────────
// Symbol extraction + presence detection — ONE pattern table, shared.
//
// Two operations must always agree on "what is a top-level definition here":
//   • extraction (ingest) — mints a belief when it first sees a definition;
//   • presence (the reverification sweep) — kills that belief when the definition
//     is gone.
// If they used different rules, a belief minted for a Rust `fn` that the sweep can't
// recognise would be falsely tombstoned on every sync. So both derive from the SAME
// per-language `LANGS` table below — they cannot drift apart.
//
// Zero-dependency and mechanical: regex, line-anchored, per language. This will never
// match a real parser (macros, generics, overloads, C's keyword-less declarations),
// and it is not trying to — the bar is "good enough to name a module's surface and to
// protect the deleted-symbol scar across languages." A precise, opt-in tree-sitter or
// ctags lift can layer on later, behind the same fence as the LLM; the regex floor
// always works.
// ─────────────────────────────────────────────────────────────────────────────

export interface Sym {
  name: string;
  kind: string; // function | class | type | const
  line: number;
  signature: string; // the declaration line, trimmed (non-identity enrichment)
  doc: string; // first line/sentence of the leading doc comment, if any
}

interface Pat { re: RegExp; kind: string }

// Names that are never symbols even when they match a definition-shaped line — the
// keyword-less languages (C/C++) would otherwise read `if (...) {` as a definition.
const CONTROL = new Set([
  "if", "for", "while", "switch", "return", "sizeof", "else", "do", "case",
  "catch", "new", "delete", "typedef", "using", "namespace", "goto", "break", "continue",
]);

// A `pub`/visibility prefix fragment reused across Rust/Swift/Kotlin/Java patterns.
const LANGS: Record<string, Pat[]> = {
  ts: [
    { re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
    { re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { re: /^(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, kind: "type" },
    { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind: "function" },
    { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: "const" },
  ],
  py: [
    { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
    { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
  ],
  go: [
    { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
    { re: /^type\s+([A-Za-z_]\w*)/, kind: "type" },
    { re: /^(?:var|const)\s+([A-Za-z_]\w*)\s/, kind: "const" },
  ],
  rust: [
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: "type" },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: "type" },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: "type" },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/, kind: "type" },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:static|const)\s+([A-Za-z_]\w*)\s*:/, kind: "const" },
  ],
  java: [
    { re: /^\s*(?:@\w+\s*)*(?:(?:public|private|protected|internal|abstract|final|static|sealed|partial)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, kind: "type" },
    { re: /^\s*(?:@\w+\s*)*(?:(?:public|private|protected|internal|static|final|abstract|synchronized|virtual|override|async|native|default|unsafe)\s+)+[\w<>\[\].,?]+\s+([A-Za-z_]\w*)\s*\(/, kind: "function" },
  ],
  c: [
    { re: /^\s*(?:typedef\s+)?(?:struct|enum|union)\s+([A-Za-z_]\w*)/, kind: "type" },
    { re: /^\s*(?:static\s+|extern\s+|inline\s+|const\s+|unsigned\s+|signed\s+)*[A-Za-z_][\w]*(?:\s*\*+\s*|\s+)([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/, kind: "function" },
  ],
  cpp: [
    { re: /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+([A-Za-z_]\w*)/, kind: "type" },
    { re: /^\s*(?:typedef\s+)?(?:enum|union)\s+([A-Za-z_]\w*)/, kind: "type" },
    { re: /^\s*(?:(?:static|inline|virtual|explicit|const|constexpr|friend)\s+)*[A-Za-z_][\w:<>]*(?:\s*\*+\s*|\s+)([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{/, kind: "function" },
  ],
  swift: [
    { re: /^\s*(?:(?:public|private|internal|fileprivate|open|static|final|override|mutating|class)\s+)*func\s+([A-Za-z_]\w*)/, kind: "function" },
    { re: /^\s*(?:(?:public|private|internal|fileprivate|open|final)\s+)*(?:class|struct|enum|protocol|extension|actor)\s+([A-Za-z_]\w*)/, kind: "type" },
  ],
  kt: [
    { re: /^\s*(?:(?:public|private|internal|protected|open|final|abstract|override|suspend|inline)\s+)*fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/, kind: "function" },
    { re: /^\s*(?:(?:public|private|internal|protected|open|final|abstract|sealed|data|enum)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/, kind: "type" },
  ],
  php: [
    { re: /^\s*(?:(?:abstract|final|public|private|protected|static)\s+)*function\s+&?\s*([A-Za-z_]\w*)/, kind: "function" },
    { re: /^\s*(?:(?:abstract|final)\s+)?class\s+([A-Za-z_]\w*)/, kind: "type" },
    { re: /^\s*(?:interface|trait)\s+([A-Za-z_]\w*)/, kind: "type" },
  ],
  rb: [
    { re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, kind: "function" },
    { re: /^\s*(?:class|module)\s+([A-Za-z_]\w*)/, kind: "type" },
  ],
};

// C# reuses Java's shape; C++ headers reuse the cpp set.
const EXT_LANG: Record<string, string> = {
  ".ts": "ts", ".tsx": "ts", ".js": "ts", ".jsx": "ts", ".mjs": "ts", ".cjs": "ts",
  ".py": "py", ".go": "go", ".rs": "rust", ".java": "java", ".cs": "java",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hh": "cpp",
  ".swift": "swift", ".kt": "kt", ".kts": "kt", ".php": "php", ".rb": "rb",
};

export function languageOf(ext: string): string {
  return EXT_LANG[ext.toLowerCase()] ?? "ts";
}

function patternsFor(ext?: string): Pat[] {
  if (!ext) return LANGS.ts; // ext-less extraction preserves the original TS behavior
  return LANGS[languageOf(ext)] ?? LANGS.ts;
}

const C_FAMILY = new Set(["ts", "js", "go", "rs", "java", "c", "cpp", "cs", "swift", "kt", "php"]);

// Blank out comments and string literals — LINE-PRESERVING (newlines kept, so line numbers
// and per-line matching are unaffected) — so a definition-SHAPED string inside a comment or
// a string literal can never be mistaken for a real definition (COR-2). A commented-out
// `// export function oldApi()` must NOT keep its belief alive, and a docstring mentioning
// `def foo` must NOT mint one. Living INSIDE scan() means extraction and death-detection
// share the exact same view of "what is code here" — the one-table invariant.
export function stripNonCode(source: string, lang: string): string {
  const slash = C_FAMILY.has(lang); // // line + /* */ block
  const hash = lang === "py" || lang === "rb" || lang === "php"; // # line
  const triple = lang === "py"; // """ / ''' spanning strings
  const out = source.split("");
  const n = source.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = source[i], c2 = source[i + 1] ?? "";
    if (slash && c === "/" && c2 === "*") { // block comment
      let j = i + 2;
      while (j < n && !(source[j] === "*" && source[j + 1] === "/")) j++;
      blank(i, Math.min(n, j + 2)); i = j + 2; continue;
    }
    if (slash && c === "/" && c2 === "/") { let j = i + 2; while (j < n && source[j] !== "\n") j++; blank(i, j); i = j; continue; }
    if (hash && c === "#") { let j = i + 1; while (j < n && source[j] !== "\n") j++; blank(i, j); i = j; continue; }
    if (triple && (c === '"' || c === "'") && source[i + 1] === c && source[i + 2] === c) {
      const q = c; let j = i + 3;
      while (j < n && !(source[j] === q && source[j + 1] === q && source[j + 2] === q)) j++;
      blank(i, Math.min(n, j + 3)); i = j + 3; continue;
    }
    if (c === '"' || c === "'" || c === "`") { // ordinary string; backtick may span lines
      const q = c; let j = i + 1;
      while (j < n && source[j] !== q) {
        if (source[j] === "\\") { j += 2; continue; }
        if (source[j] === "\n" && q !== "`") break; // an unterminated non-template string ends at EOL
        j++;
      }
      blank(i + 1, j); i = j + 1; continue;
    }
    i++;
  }
  return out.join("");
}

// The shared core: names + kinds + line, in file order, deduped by name.
function scan(source: string, pats: Pat[], lang = "ts"): { name: string; kind: string; line: number }[] {
  const out: { name: string; kind: string; line: number }[] = [];
  const seen = new Set<string>();
  const lines = stripNonCode(source, lang).split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const p of pats) {
      const m = lines[i].match(p.re);
      if (m && m[1] && !CONTROL.has(m[1]) && !seen.has(m[1])) {
        seen.add(m[1]);
        out.push({ name: m[1], kind: p.kind, line: i + 1 });
        break;
      }
    }
  }
  return out;
}

// Extract a module's top-level definitions, each enriched with its signature and the
// first line of its doc comment. `ext` selects the language; omitting it keeps the
// original TS-only behavior (used by callers that don't know the extension).
//
// The multi-line signature join lives HERE, in the minting/enrichment path — NOT in the
// shared `scan` that death-detection (`definesSymbol`, `yieldsAnySymbol`) also runs — and
// it only touches the NON-identity `summary`, so a differently-wrapped signature can never
// churn a belief id or drift extraction and death-detection apart.
export function extractSymbols(source: string, ext?: string): Sym[] {
  const lines = source.split("\n");
  const lang = ext ? languageOf(ext) : "ts";
  return scan(source, patternsFor(ext), lang).map((s) => ({
    ...s,
    signature: signatureOf(joinSignature(lines, s.line - 1)),
    doc: docOf(lines, s.line - 1, lang),
  }));
}

// Is `name` DEFINED in this source? Presence detection for the reverification sweep.
// With `ext` it uses that language's rules (what the watch does — the path is known);
// without it, the union of all languages (permissive, for the direct-call tests).
export function definesSymbol(source: string, name: string, ext?: string): boolean {
  if (!name) return false;
  const pats = ext ? patternsFor(ext) : Object.values(LANGS).flat();
  for (const s of scan(source, pats, ext ? languageOf(ext) : "ts")) if (s.name === name) return true;
  return false;
}

// Does the scanner see ANY definition in this source? Used by the mortality engine to
// tell a REAL absence (the file has other symbols, so the scanner can read it — the
// missing one is genuinely gone) from a scanner-BLIND file (a non-empty source that
// yields zero symbols — a reformat or a construct the regex floor can't parse), which is
// inconclusive and must demote to stale rather than forge a tombstone (item 17).
export function yieldsAnySymbol(source: string, ext?: string): boolean {
  const pats = ext ? patternsFor(ext) : Object.values(LANGS).flat();
  return scan(source, pats, ext ? languageOf(ext) : "ts").length > 0;
}

// Is there any actual CODE here once comments and strings are blanked? A file reduced to
// only comments/whitespace (e.g. `// alpha gone`) has no code — a symbol that lived there
// is genuinely gone. A file with real code the regex floor can't parse is the scanner-blind
// case. Together with `yieldsAnySymbol`, this separates "gone" from "inconclusive" (item 17).
export function hasCode(source: string, ext?: string): boolean {
  return stripNonCode(source, ext ? languageOf(ext) : "ts").trim().length > 0;
}

// A symbol watch target is "name@path". Split on the FIRST `@`: a symbol name is
// `[\w$]`-only (never contains `@`), while a path legitimately can (scoped dirs like
// `app/@auth/page.ts`). Splitting on the last `@` — or a bare `split("@")` that keeps
// only `[0]`/`[1]` — mis-parses those and would falsely tombstone the belief (COR-3).
// The single home for this split, shared by every death-detection site.
export function splitSymbolTarget(target: string): { name: string; file: string } {
  const at = target.indexOf("@");
  return at < 0 ? { name: target, file: "" } : { name: target.slice(0, at), file: target.slice(at + 1) };
}

// ── enrichment helpers ───────────────────────────────────────────────────────

function signatureOf(line: string): string {
  return line.trim().replace(/\s*[{};]+\s*$/, "").replace(/\s+/g, " ").slice(0, 140);
}

// A signature can wrap across lines (`function f(\n  a,\n  b,\n): R {`). Truncating at the
// declaration line alone loses every parameter after the first `(`. Join continuation lines
// until the parentheses opened on the first line are balanced, so `signatureOf` sees the
// whole parameter list before its 140-char cap. Bounded (≤8 lines) so a pathological or
// never-balancing source can't run away — and this only enriches the NON-identity summary,
// so a differently-wrapped signature never churns a belief id.
function joinSignature(lines: string[], start: number): string {
  const first = lines[start] ?? "";
  const bal = (s: string): number => (s.match(/[([]/g)?.length ?? 0) - (s.match(/[)\]]/g)?.length ?? 0);
  let depth = bal(first);
  if (depth <= 0) return first; // single-line signature (or no call-shaped parens) — unchanged
  let buf = first;
  for (let i = start + 1; i < lines.length && i < start + 8; i++) {
    buf += " " + lines[i];
    depth += bal(lines[i]);
    if (depth <= 0) break;
  }
  return buf;
}

// The doc comment for a definition. For most languages it sits directly ABOVE the
// declaration (//, ///, #, or a /* … */ block). Python puts it just BELOW, as the
// first triple-quoted string in the body — handled separately.
function docOf(lines: string[], defIdx: number, lang: string): string {
  if (lang === "py") return pyDoc(lines, defIdx);
  const buf: string[] = [];
  for (let j = defIdx - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (t === "") break; // the comment must be adjacent to the declaration
    if (!isComment(t)) break;
    buf.push(stripComment(t));
  }
  buf.reverse();
  return firstSentence(buf.filter(Boolean).join(" "));
}

function pyDoc(lines: string[], defIdx: number): string {
  for (let j = defIdx + 1; j < Math.min(lines.length, defIdx + 3); j++) {
    const t = lines[j].trim();
    if (t === "") continue;
    const m = t.match(/^(?:"""|''')(.*)$/);
    if (m) return firstSentence(m[1].replace(/("""|''').*$/, ""));
    return ""; // first body line isn't a docstring
  }
  return "";
}

function isComment(t: string): boolean {
  return /^(\/\/|#|\*|\/\*)/.test(t) || t.endsWith("*/");
}

function stripComment(t: string): string {
  return t
    .replace(/^\/\/\/?/, "")
    .replace(/^#+/, "")
    .replace(/^\/\*+/, "")
    .replace(/\*+\/$/, "")
    .replace(/^\*+/, "")
    .trim();
}

function firstSentence(s: string): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean.length < 3) return "";
  const dot = clean.indexOf(". ");
  return (dot > 0 ? clean.slice(0, dot + 1) : clean).slice(0, 160);
}
