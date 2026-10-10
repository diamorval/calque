import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

/** Whether a Calque server answers on `mcp` (its /mcp URL). Throws if it wants a sign-in. */
export async function reachable(mcp: URL): Promise<boolean> {
  const res = await fetch(new URL("/api/me", mcp), { signal: AbortSignal.timeout(1000) }).catch(() => undefined);
  if (res?.status === 401) {
    throw new Error(`the Calque server on ${mcp.origin} requires sign-in: connect over HTTP (claude mcp add --transport http calque ${mcp})`);
  }
  return !!res?.ok && "id" in ((await res.json().catch(() => ({}))) as object);
}

/** Relays MCP between this process's stdio and the HTTP server on `mcp`, message for message. Resolves when stdin closes. */
export async function bridge(mcp: URL): Promise<void> {
  const remote = new StreamableHTTPClientTransport(mcp);
  const local = new StdioServerTransport();
  let init: unknown;
  local.onmessage = (m: JSONRPCMessage) => {
    const req = "method" in m && "id" in m ? m : undefined;
    if (req?.method === "initialize") init = req.id;
    remote.send(m).catch((e: Error) => {
      if (req) void local.send({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: `${mcp.origin}: ${e.message}` } });
    });
  };
  remote.onmessage = (m: JSONRPCMessage) => {
    // the HTTP transport sends the negotiated version on every later request
    if ("result" in m && m.id === init) remote.setProtocolVersion(String(m.result.protocolVersion));
    void local.send(m);
  };
  remote.onerror = (e) => console.error(`calque bridge: ${e.message}`);
  const closed = new Promise<void>((resolve) => (local.onclose = resolve));
  await remote.start();
  await local.start();
  await closed;
  await remote.close();
}
