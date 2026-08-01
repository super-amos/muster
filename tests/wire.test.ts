import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cmdWire, cmdUninstall, wireState, hookReply, isMusterHookCommand } from "../src/wire.js";
import { cmdSync } from "../src/verbs.js";
import { mkTmp, rm, gitRepo } from "./helpers.js";

const read = (p: string) => readFileSync(p, "utf8");

describe("wiring — muster init --wire / muster uninstall", () => {
  it("wires a bare repo (AGENTS.md + .mcp.json) and is idempotent", () => {
    const repo = mkTmp();
    try {
      const out = cmdWire({ repo });
      expect(out).toContain(".mcp.json — registered");
      expect(out).toContain("AGENTS.md — appended");
      const mcp = JSON.parse(read(join(repo, ".mcp.json")));
      expect(mcp.mcpServers.muster.args.at(-1)).toBe("mcp");
      expect(read(join(repo, "AGENTS.md"))).toContain("muster_brief");
      // No CLAUDE.md invented for a repo that doesn't have one.
      expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);

      // Second run duplicates nothing.
      const again = cmdWire({ repo });
      expect(again).toContain("already");
      const matches = read(join(repo, "AGENTS.md")).match(/muster:begin/g);
      expect(matches?.length).toBe(1);
      expect(wireState({ repo })).toMatchObject({ mcp: true, stanzaIn: ["AGENTS.md"], hook: false });
    } finally { rm(repo); }
  });

  it("appends to an existing CLAUDE.md; uninstall restores it byte-identical", () => {
    const repo = mkTmp();
    try {
      const original = "# My project\n\nRules the user wrote.\n";
      writeFileSync(join(repo, "CLAUDE.md"), original, "utf8");
      cmdWire({ repo });
      expect(read(join(repo, "CLAUDE.md"))).toContain(original.trimEnd());
      expect(read(join(repo, "CLAUDE.md"))).toContain("muster:begin");

      const out = cmdUninstall({ repo });
      expect(out).toContain("CLAUDE.md — removed the stanza");
      expect(read(join(repo, "CLAUDE.md"))).toBe(original); // byte-for-byte
      // The wholly-ours files are gone entirely.
      expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);
      expect(existsSync(join(repo, ".mcp.json"))).toBe(false);
    } finally { rm(repo); }
  });

  it("shares .mcp.json politely: a foreign server survives wire AND uninstall", () => {
    const repo = mkTmp();
    try {
      writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "other-mcp" } } }), "utf8");
      cmdWire({ repo });
      let cfg = JSON.parse(read(join(repo, ".mcp.json")));
      expect(Object.keys(cfg.mcpServers).sort()).toEqual(["muster", "other"]);

      cmdUninstall({ repo });
      cfg = JSON.parse(read(join(repo, ".mcp.json")));
      expect(cfg.mcpServers.other.command).toBe("other-mcp"); // untouched
      expect(cfg.mcpServers.muster).toBeUndefined();
    } finally { rm(repo); }
  });

  it("wires the Claude Code hook; uninstall removes ONLY muster's entry", () => {
    const repo = mkTmp();
    try {
      mkdirSync(join(repo, ".claude"), { recursive: true });
      const settingsPath = join(repo, ".claude", "settings.json");
      writeFileSync(settingsPath, JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo user-hook" }] }] },
      }), "utf8");

      cmdWire({ repo, hook: true });
      let s = JSON.parse(read(settingsPath));
      expect(s.hooks.UserPromptSubmit.length).toBe(2);
      expect(wireState({ repo }).hook).toBe(true);

      cmdUninstall({ repo });
      s = JSON.parse(read(settingsPath));
      expect(s.hooks.UserPromptSubmit.length).toBe(1);
      expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toBe("echo user-hook");
      expect(wireState({ repo }).hook).toBe(false);
    } finally { rm(repo); }
  });

  it("a settings.json that was entirely ours disappears on uninstall", () => {
    const repo = mkTmp();
    try {
      cmdWire({ repo, hook: true });
      expect(existsSync(join(repo, ".claude", "settings.json"))).toBe(true);
      cmdUninstall({ repo });
      expect(existsSync(join(repo, ".claude", "settings.json"))).toBe(false);
      expect(existsSync(join(repo, ".claude"))).toBe(false); // empty dir tidied too
    } finally { rm(repo); }
  });

  it("uninstall keeps the store by default; --purge deletes it", () => {
    const repo = mkTmp();
    try {
      mkdirSync(join(repo, ".muster", "beliefs"), { recursive: true });
      writeFileSync(join(repo, ".muster", "beliefs", "b.md"), "belief", "utf8");
      cmdWire({ repo });

      const kept = cmdUninstall({ repo });
      expect(kept).toContain("kept");
      expect(existsSync(join(repo, ".muster", "beliefs", "b.md"))).toBe(true);

      const purged = cmdUninstall({ repo, purge: true });
      expect(purged).toContain("deleted");
      expect(existsSync(join(repo, ".muster"))).toBe(false);
    } finally { rm(repo); }
  });

  it("never clobbers a malformed JSON file — reports and moves on", () => {
    const repo = mkTmp();
    try {
      writeFileSync(join(repo, ".mcp.json"), "{ this is not json", "utf8");
      const out = cmdWire({ repo });
      expect(out).toContain("SKIPPED");
      expect(read(join(repo, ".mcp.json"))).toBe("{ this is not json"); // untouched
      expect(out).toContain("AGENTS.md — appended"); // the rest of wiring still ran
      expect(cmdUninstall({ repo })).toContain("SKIPPED");
      expect(read(join(repo, ".mcp.json"))).toBe("{ this is not json");
    } finally { rm(repo); }
  });

  it("a broken fence (end marker deleted) is refused, never guessed at", () => {
    const repo = mkTmp();
    try {
      writeFileSync(join(repo, "CLAUDE.md"), "# Mine\n", "utf8");
      cmdWire({ repo });
      const mangled = read(join(repo, "CLAUDE.md")).replace("<!-- muster:end -->", "");
      writeFileSync(join(repo, "CLAUDE.md"), mangled, "utf8");

      const out = cmdUninstall({ repo });
      expect(out).toContain("fence is broken");
      expect(read(join(repo, "CLAUDE.md"))).toBe(mangled); // untouched
    } finally { rm(repo); }
  });
});

describe("the hook adapter — silent unless it has something worth saying", () => {
  const payload = (prompt: string, cwd: string) => JSON.stringify({ prompt, cwd });

  it("no store → empty reply, exit-clean semantics", () => {
    const repo = mkTmp();
    try {
      expect(hookReply(payload("refactor the token issuance flow in auth", repo), {})).toBe("");
    } finally { rm(repo); }
  });

  it("short prompts and slash commands → empty reply", () => {
    const repo = mkTmp();
    try {
      expect(hookReply(payload("fix", repo), {})).toBe("");
      expect(hookReply(payload("/code-review the whole repository now", repo), {})).toBe("");
      expect(hookReply("not even json {", {})).toBe("");
    } finally { rm(repo); }
  });

  it("a real prompt against a real store returns a briefing", async () => {
    const repo = gitRepo([{ "src/auth/token.ts": "export function issueToken() { return 1; }\n" }]);
    try {
      await cmdSync({ repo });
      const reply = hookReply(payload("refactor token issuance in src/auth/token.ts", repo), {});
      expect(reply.startsWith("[muster]")).toBe(true);
      expect(reply).toContain("issueToken");
    } finally { rm(repo); }
  });

  it("isMusterHookCommand matches ours and never the user's", () => {
    expect(isMusterHookCommand("muster hook")).toBe(true);
    expect(isMusterHookCommand("node /home/x/repo/bin/muster.mjs hook")).toBe(true);
    expect(isMusterHookCommand("muster hook --budget 2000")).toBe(true);
    expect(isMusterHookCommand("echo user-hook")).toBe(false);
    expect(isMusterHookCommand("muster hooked me")).toBe(false);
    expect(isMusterHookCommand("my-muster-tool hook")).toBe(false);
  });
});
