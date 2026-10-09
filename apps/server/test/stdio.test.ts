import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { DbLocked, openDb } from "../src/db.ts";
import { REPO } from "../src/engine.ts";
import { createHttp } from "../src/http.ts";
import { acmeDeck, ENGINE_TIMEOUT } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

/** An MCP client on `node apps/server/src/stdio.ts`, as Claude Code starts it from .mcp.json. */
async function stdioClient(env: Record<string, string>) {
  delete process.env.CALQUE_PUBLIC_URL; // links on localhost:$PORT
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO, "apps/server/src/stdio.ts")],
      cwd: REPO,
      env: { ...(process.env as Record<string, string>), ...env },
      stderr: "ignore",
    }),
  );
  return client;
}

const call = async (client: Client, name: string, args: Json = {}): Promise<Json> => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(JSON.stringify(r.content));
  return r.structuredContent as Json;
};

describe("stdio entry: one owner of the database", { timeout: ENGINE_TIMEOUT }, () => {
  const cleanup: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const f of cleanup.splice(0).reverse()) await f();
  });

  it("bridges to the running HTTP server: its previews and comments are the same deck", async () => {
    const data = mkdtempSync(join(tmpdir(), "calque-"));
    const port = await freePort();
    const app = await createApp({ data, publicUrl: `http://localhost:${port}` });
    cleanup.push(() => app.db.close());
    const server = serve({ fetch: createHttp(app).fetch, port, hostname: "127.0.0.1" });
    cleanup.push(() => new Promise((r) => server.close(r)));

    const client = await stdioClient({ CALQUE_DATA: data, PORT: String(port) });
    cleanup.push(() => client.close());
    const { deck_id, preview_url } = await call(client, "create_deck", { deck: acmeDeck() });

    const url = new URL(preview_url);
    url.pathname += "/data";
    expect((await fetch(url)).status).toBe(200);
    // a comment posted in the browser preview is read by list_comments over stdio
    url.pathname = url.pathname.replace(/\/data$/, "/comments");
    const posted = await fetch(url, { method: "POST", body: JSON.stringify({ slide_id: "cover", text: "Shorter" }) });
    expect(posted.status).toBe(200);
    expect((await call(client, "list_comments", { deck_id })).comments).toHaveLength(1);
  });

  it("starts the HTTP server itself when none runs", async () => {
    const data = mkdtempSync(join(tmpdir(), "calque-"));
    const port = await freePort();
    const client = await stdioClient({ CALQUE_DATA: data, PORT: String(port) });
    cleanup.push(() => client.close());
    const { preview_url } = await call(client, "create_deck", { deck: acmeDeck() });
    expect(preview_url).toMatch(new RegExp(`^http://localhost:${port}/decks/`));
    const url = new URL(preview_url);
    url.pathname += "/data";
    expect((await fetch(url)).status).toBe(200);

    // a second stdio process shares that server instead of opening the database again
    const second = await stdioClient({ CALQUE_DATA: data, PORT: String(port) });
    cleanup.push(() => second.close());
    expect((await call(second, "open_deck", { deck_id: url.pathname.split("/")[2] })).slides).toHaveLength(
      acmeDeck().slides.length,
    );
  });

  it("refuses a second PGlite on the same data dir", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "calque-")), "pg");
    const db = await openDb(dir);
    await expect(openDb(dir)).rejects.toThrow(DbLocked);
    await db.close();
    const again = await openDb(dir); // released on close
    await again.close();
  });
});
