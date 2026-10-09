// stdio entry for a local MCP client (Claude Code): a bridge to the HTTP server's /mcp on loopback,
// so one process owns the database (decks made here preview there, browser comments reach
// list_comments). No server on $PORT: this process starts one (main.ts) and serves until stdin closes.
// stdout is the MCP channel: everything else goes to stderr.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./engine.ts";

// a fresh checkout (a cloud session starts MCP servers before anything else): install first
if (!existsSync(join(REPO, "apps/server/node_modules/@modelcontextprotocol/server"))) {
  console.error("calque: installing dependencies (pnpm install)…");
  const r = spawnSync("pnpm", ["install", "--frozen-lockfile"], { cwd: REPO, stdio: ["ignore", 2, 2] });
  if (r.status !== 0) {
    console.error(`calque: pnpm install failed${r.error ? ` (${r.error.message})` : ""}; run it in ${REPO}`);
    process.exit(1);
  }
}

const { bridge, reachable } = await import("./bridge.ts");
const { DbLocked } = await import("./db.ts");
const mcp = new URL(`http://127.0.0.1:${process.env.PORT ?? 8787}/mcp`);

if (!(await reachable(mcp))) {
  try {
    await import("./main.ts");
  } catch (e) {
    // another stdio process won the race to start the server: use it
    if (!(e instanceof DbLocked)) throw e;
    console.error(`calque: ${e.message}`);
  }
  const until = Date.now() + 30_000;
  while (!(await reachable(mcp))) {
    if (Date.now() > until) throw new Error(`no Calque server on ${mcp.origin}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
await bridge(mcp);
process.exit(0);
