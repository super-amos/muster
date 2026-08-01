#!/usr/bin/env node
// Thin launcher for the built CLI. Run `npm run build` first.
import("../dist/cli.js").catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
