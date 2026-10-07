// stdio entry for a local MCP client (Claude Code): the user is local, file paths are allowed.
// Previews still need the HTTP server (pnpm --filter @calque/server start) on CALQUE_PUBLIC_URL.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createApp } from "./app.ts";
import { userOf } from "./auth.ts";
import { buildServer } from "./mcp.ts";

const app = await createApp();
serveStdio(() => buildServer(app, userOf(undefined)));
