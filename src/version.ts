import { readFileSync } from "node:fs";

// The single source of truth for the running version: package.json, read at startup. The
// MCP server advertised a hardcoded "0.1.0" that had already drifted from the package's
// "0.0.1" (API-4); reading it here keeps the two from ever diverging again.
export function pkgVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
