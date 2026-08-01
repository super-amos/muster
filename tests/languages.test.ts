import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { extractSymbols, definesSymbol, languageOf } from "../src/symbols.js";
import { Store } from "../src/store.js";
import { ingestGit } from "../src/ingest.js";
import { sweep } from "../src/watch.js";
import { compileBriefing } from "../src/linker.js";
import { gitRepo, commitFile, rm } from "./helpers.js";

const names = (src: string, ext: string): string[] => extractSymbols(src, ext).map((s) => s.name).sort();

describe("symbols — per-language extraction (regex floor, zero deps)", () => {
  it("Rust: fn / struct / trait / enum", () => {
    const src = `pub fn issue_token(u: &str) -> String { String::new() }\nstruct Auth {}\ntrait Signer {}\nenum Kind { A }`;
    expect(names(src, ".rs")).toEqual(["Auth", "Kind", "Signer", "issue_token"]);
  });
  it("Java: class + methods (indented, no `function` keyword)", () => {
    const src = `public class Auth {\n  public String issueToken(String u) { return ""; }\n  private void verify() {}\n}`;
    expect(names(src, ".java")).toEqual(["Auth", "issueToken", "verify"]);
  });
  it("C: keyword-less functions and structs", () => {
    const src = `struct Token { int exp; };\nint issue_token(char *u) { return 0; }\nstatic void verify(void) { }`;
    expect(names(src, ".c")).toEqual(["Token", "issue_token", "verify"]);
  });
  it("Go / Python / Ruby / PHP still work with their extensions", () => {
    expect(names(`func Handler() {}\ntype T struct {}`, ".go")).toEqual(["Handler", "T"]);
    expect(names(`class A:\n    def m(self): pass`, ".py")).toEqual(["A", "m"]); // methods too
    expect(names(`class A\n  def run\n  end\nend`, ".rb")).toEqual(["A", "run"]);
    expect(names(`function f(){}\nclass C {}`, ".php")).toEqual(["C", "f"]);
  });
  it("does not read a control-flow line as a definition", () => {
    expect(names(`if (x) {\n  return 1;\n}`, ".c")).toEqual([]);
  });
  it("captures signature and the leading doc line", () => {
    const rs = extractSymbols(`/// Issue a signed token.\npub fn issue_token(u: &str) -> String { x }`, ".rs");
    expect(rs[0].name).toBe("issue_token");
    expect(rs[0].signature).toContain("pub fn issue_token(u: &str) -> String");
    expect(rs[0].doc).toBe("Issue a signed token.");
    const py = extractSymbols(`def m(self):\n    """Return the thing."""\n    return 1`, ".py");
    expect(py[0].doc).toBe("Return the thing.");
  });

  it("joins a multi-line signature instead of truncating at the first `(`", () => {
    const src = `export function issueToken(\n  user: string,\n  ttl: number,\n): Token {\n  return sign(user, ttl);\n}`;
    const [sym] = extractSymbols(src, ".ts");
    expect(sym.name).toBe("issueToken");
    // both parameters survive — the old single-line capture stopped at `issueToken(`
    expect(sym.signature).toContain("user: string");
    expect(sym.signature).toContain("ttl: number");
    // still one collapsed line, still capped, still no trailing brace
    expect(sym.signature).not.toContain("\n");
    expect(sym.signature.endsWith("{")).toBe(false);
  });

  it("leaves a single-line signature exactly as before (no behavior change when parens balance)", () => {
    const [sym] = extractSymbols(`export const KEY = "value";`, ".ts");
    expect(sym.signature).toBe(`export const KEY = "value"`);
  });
});

describe("symbols — definesSymbol agrees with extraction (no false deaths)", () => {
  it("recognizes each language's definitions when the extension is known", () => {
    expect(definesSymbol(`pub fn issue_token(u: &str) {}`, "issue_token", ".rs")).toBe(true);
    expect(definesSymbol(`public class Auth {\n  public void verify() {}\n}`, "verify", ".java")).toBe(true);
    expect(definesSymbol(`int issue_token(char *u) { return 0; }`, "issue_token", ".c")).toBe(true);
  });
  it("returns false when the definition is gone (only a call remains)", () => {
    expect(definesSymbol(`fn other() { issue_token(); }`, "issue_token", ".rs")).toBe(false);
  });
  it("maps extensions to languages", () => {
    expect(languageOf(".rs")).toBe("rust");
    expect(languageOf(".java")).toBe("java");
    expect(languageOf(".unknown")).toBe("ts");
  });
});

describe("the scar is cross-language — a deleted Rust fn dies and briefs a tripwire", () => {
  it("kills a Rust symbol belief when its `fn` is removed", () => {
    const repo = gitRepo([{ "src/lib.rs": `pub fn issue_token(u: &str) -> String { String::new() }\npub fn verify(t: &str) -> bool { true }\n` }]);
    const loc = { repo, store: join(repo, ".muster") };
    try {
      const store = Store.open(loc);
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
      const b = store.all().find((x) => x.claim.includes("issue_token"))!;
      expect(b).toBeTruthy();
      expect(b.status).toBe("live");

      // The world moves: drop issue_token.
      commitFile(repo, "src/lib.rs", `pub fn verify(t: &str) -> bool { true }\n`, "drop issue_token");
      sweep(store);

      const dead = store.get(b.id)!;
      expect(dead.status).toBe("dead");
      expect(dead.tombstone?.death).toBe("falsified");
    } finally { rm(repo); }
  });

  it("kills a Java METHOD belief when the indented method is removed", () => {
    const repo = gitRepo([{ "Auth.java": `public class Auth {\n  public String issueToken(String u) { return ""; }\n  public void verify() {}\n}\n` }]);
    const loc = { repo, store: join(repo, ".muster") };
    try {
      const store = Store.open(loc);
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
      const b = store.all().find((x) => x.claim.includes("issueToken"))!;
      expect(b?.status).toBe("live");

      commitFile(repo, "Auth.java", `public class Auth {\n  public void verify() {}\n}\n`, "drop issueToken");
      sweep(store);
      expect(store.get(b.id)!.status).toBe("dead");
    } finally { rm(repo); }
  });
});

describe("docstring enrichment reaches the briefing without touching identity", () => {
  it("carries the signature + doc as a non-identity summary, rendered at altitude", () => {
    const repo = gitRepo([{ "src/token.ts": `// Issue a signed 15-minute JWT for a user.\nexport function issueToken(userId: string): string { return userId; }\n` }]);
    const loc = { repo, store: join(repo, ".muster") };
    try {
      const store = Store.open(loc);
      ingestGit(store, { repo, maxCommits: 50, pathPrefix: "", maxSymbolsPerFile: 40 });
      const b = store.all().find((x) => x.claim.includes("issueToken") && x.method === "read-source")!;
      expect(b.summary).toContain("issueToken(userId: string): string");
      expect(b.summary).toContain("Issue a signed 15-minute JWT");

      // A generous budget climbs to A1, where the summary renders.
      const brief = compileBriefing(store, "work on issueToken in src/token.ts", 4000);
      expect(brief.text).toContain("Issue a signed 15-minute JWT");
    } finally { rm(repo); }
  });
});
