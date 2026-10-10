// Test doubles for what Calque talks to outside: a model provider and an OIDC issuer. Real HTTP,
// so the real client code (AI SDK, openid-client, jose) runs. Used by vitest and the web e2e.
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Reply = { content?: string; tool?: { name: string; args: Json } };

const listen = (server: Server, port = 0) => new Promise<string>((ok) => server.listen(port, "127.0.0.1", () => ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

/** An OpenAI-compatible endpoint: checks the key ("good-key"), records each request, answers from `script`. */
export async function fakeModel(script: (body: Json) => Reply, port = 0) {
  const requests: Json[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== "Bearer good-key") {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }));
      }
      const body = JSON.parse(raw);
      requests.push(body);
      const r = body.tools ? script(body) : { content: "OK" };
      const call = r.tool && { id: `call_${++n}`, type: "function", function: { name: r.tool.name, arguments: JSON.stringify(r.tool.args) } };
      res.end(
        JSON.stringify({
          id: `chatcmpl-${n}`,
          object: "chat.completion",
          created: 0,
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: r.content ?? null, ...(call ? { tool_calls: [call] } : {}) }, finish_reason: call ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  const url = `${await listen(server, port)}/v1`;
  return { server, requests, url };
}

/** The last tool result the model received, parsed; and how many tools it called this turn. */
export const lastResult = (body: Json): Json => JSON.parse(body.messages.findLast((m: Json) => m.role === "tool").content);
export const toolsCalled = (body: Json) => {
  const lastUser = body.messages.findLastIndex((m: Json) => m.role === "user");
  return body.messages.slice(lastUser).filter((m: Json) => m.role === "tool").length;
};

export const USERS: Record<string, { name: string; groups: string[] }> = {
  alice: { name: "Alice Martin", groups: ["/sales", "/calque-admins"] },
  bob: { name: "Bob Durand", groups: ["/ops"] },
};

/** An OIDC issuer: discovery, JWKS, an authorize page with one "Sign in as <user>" link per user,
and a token endpoint (PKCE checked) issuing RS256 ID and access tokens with a `groups` claim. */
export async function fakeOidc(audience = "calque") {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { user: string; client: string; challenge: string; redirect: string }>();
  let issuer = "";
  const sign = (claims: Json, aud: string) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience(aud).setIssuedAt().setExpirationTime("1h").sign(privateKey);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const json = (o: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(o));
    };
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname.endsWith("/jwks")) return json({ keys: [jwk] });
    if (url.pathname.endsWith("/authorize")) {
      const q = url.searchParams;
      const links = Object.keys(USERS).map((user) => {
        const code = randomUUID();
        codes.set(code, { user, client: q.get("client_id") ?? "", challenge: q.get("code_challenge") ?? "", redirect: q.get("redirect_uri") ?? "" });
        const back = new URL(q.get("redirect_uri") ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state") ?? "");
        return `<a href="${back.href.replace(/&/g, "&amp;")}">Sign in as ${user}</a>`;
      });
      res.setHeader("content-type", "text/html");
      return res.end(`<!doctype html><title>Fake IdP</title>${links.join("<br>")}`);
    }
    if (url.pathname.endsWith("/token")) {
      let raw = "";
      for await (const d of req) raw += d;
      const f = new URLSearchParams(raw);
      const c = codes.get(f.get("code") ?? "");
      const pkce = createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url");
      if (!c || pkce !== c.challenge || f.get("redirect_uri") !== c.redirect) {
        res.statusCode = 400;
        return json({ error: "invalid_grant" });
      }
      codes.delete(f.get("code") ?? "");
      const u = USERS[c.user] as { name: string; groups: string[] };
      const claims = { sub: c.user, name: u.name, groups: u.groups };
      return json({
        token_type: "Bearer",
        expires_in: 3600,
        access_token: await sign({ ...claims, azp: c.client }, audience),
        id_token: await sign(claims, c.client),
      });
    }
    res.statusCode = 404;
    res.end();
  });
  issuer = `${await listen(server)}/realms/test`;
  const token = (user: string, groups = USERS[user]?.groups ?? []) => sign({ sub: user, ...(USERS[user] ? { name: USERS[user].name } : {}), groups }, audience);
  return { server, issuer, token };
}

interface DriveItem {
  id: string;
  name: string;
  drive: string;
  parent: string | null;
  bytes?: Buffer;
  type?: string;
}

/** Microsoft 365: the Entra endpoints (authorize answers at once, token checks PKCE and rotates
refresh tokens) and the Graph calls Calque makes, over an in-memory OneDrive ("me") and one
SharePoint site ("Sales", its library "sales-docs"), and Teams: one team ("Sales", channels
General and Deals), one chat; `messages` records what is posted. `requests` records each Graph call. */
export async function fakeGraph(account = "alice@contoso.test") {
  let base = "";
  const items = new Map<string, DriveItem>();
  const add = (i: DriveItem) => (items.set(i.id, i), i);
  for (const d of ["me", "sales-docs"]) add({ id: `${d}-root`, name: "root", drive: d, parent: null });
  add({ id: "decks", name: "Decks", drive: "me", parent: "me-root" });
  add({ id: "brief", name: "Brief T2.docx", drive: "me", parent: "me-root", bytes: Buffer.from("PK fake docx"), type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  add({ id: "tool", name: "setup.exe", drive: "me", parent: "me-root", bytes: Buffer.from("MZ") });
  add({ id: "q3", name: "Q3 figures.xlsx", drive: "sales-docs", parent: "sales-docs-root", bytes: Buffer.from("PK fake xlsx"), type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  const uploads = new Map<string, { drive: string; parent: string; name: string; chunks: Buffer[]; got: number }>();
  const requests: { method: string; path: string; auth: string | undefined }[] = [];
  const messages: { to: string; body: { contentType: string; content: string } }[] = [];
  const channels: Record<string, { id: string; displayName: string }[]> = {
    "team-sales": [
      { id: "19:general@thread.tacv2", displayName: "General" },
      { id: "19:deals@thread.tacv2", displayName: "Deals" },
    ],
  };
  let n = 0;

  const view = (i: DriveItem) => ({
    id: i.id,
    name: i.name,
    webUrl: `https://contoso.sharepoint.test/${i.drive}/${encodeURIComponent(i.name)}`,
    parentReference: { driveId: i.drive, id: i.parent },
    lastModifiedDateTime: "2026-10-01T09:00:00Z",
    ...(i.bytes
      ? { size: i.bytes.length, file: { mimeType: i.type ?? "application/octet-stream" }, "@microsoft.graph.downloadUrl": `${base}/download/${i.id}` }
      : { folder: { childCount: 0 } }),
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const path = decodeURIComponent(url.pathname);
    let raw = Buffer.alloc(0);
    for await (const d of req) raw = Buffer.concat([raw, d as Buffer]);
    const json = (o: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(o));
    };
    const err = (status: number, message: string) => json({ error: { code: String(status), message } }, status);

    if (path.endsWith("/oauth2/v2.0/authorize")) {
      const q = url.searchParams;
      const code = randomUUID();
      codes.set(code, { challenge: q.get("code_challenge") ?? "", redirect: q.get("redirect_uri") ?? "" });
      const back = new URL(q.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state") ?? "");
      res.statusCode = 302;
      res.setHeader("location", back.href);
      return res.end();
    }
    if (path.endsWith("/oauth2/v2.0/token")) {
      const f = new URLSearchParams(raw.toString());
      if (f.get("grant_type") === "authorization_code") {
        const c = codes.get(f.get("code") ?? "");
        const pkce = createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url");
        if (!c || pkce !== c.challenge || f.get("redirect_uri") !== c.redirect) return json({ error: "invalid_grant", error_description: "bad code" }, 400);
        codes.delete(f.get("code") ?? "");
      } else if (!refresh.delete(f.get("refresh_token") ?? "")) return json({ error: "invalid_grant", error_description: "AADSTS70008: the refresh token has expired" }, 400);
      const [at, rt] = [`at-${++n}`, `rt-${n}`];
      access.add(at);
      refresh.add(rt);
      return json({ token_type: "Bearer", expires_in: 3600, access_token: at, refresh_token: rt, scope: f.get("scope") });
    }
    if (path.startsWith("/download/")) {
      const i = items.get(path.slice("/download/".length));
      return i?.bytes ? res.end(i.bytes) : err(404, "gone");
    }
    if (path.startsWith("/upload/")) {
      const u = uploads.get(path.slice("/upload/".length));
      if (!u) return err(404, "no upload session");
      const r = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers["content-range"]));
      if (!r || Number(r[1]) !== u.got || raw.length !== Number(r[2]) - Number(r[1]) + 1) return err(416, "bad range");
      u.chunks.push(raw);
      u.got += raw.length;
      if (u.got < Number(r[3])) return json({ nextExpectedRanges: [`${u.got}-`] }, 202);
      const taken = (name: string) => [...items.values()].some((i) => i.parent === u.parent && i.name === name);
      let name = u.name;
      for (let k = 1; taken(name); k++) name = u.name.replace(/(\.\w+)?$/, ` ${k}$1`);
      return json(view(add({ id: `up-${++n}`, name, drive: u.drive, parent: u.parent, bytes: Buffer.concat(u.chunks) })), 201);
    }

    const auth = req.headers.authorization;
    requests.push({ method: req.method ?? "GET", path: `${path}${url.search}`, auth });
    if (!path.startsWith("/v1.0/")) return err(404, "not found");
    if (!auth || !access.has(auth.replace(/^Bearer /, ""))) return err(401, "InvalidAuthenticationToken");
    const g = path.slice("/v1.0".length).replace(/^\/me\/drive(?=\/|$)/, "/drives/me");
    if (g === "/me") return json({ userPrincipalName: account, mail: account });
    if (g === "/sites") return json({ value: /sal/i.test(url.searchParams.get("search") ?? "") ? [{ id: "site-sales", displayName: "Sales", webUrl: "https://contoso.sharepoint.test/sites/sales" }] : [] });
    if (g === "/sites/site-sales/drives") return json({ value: [{ id: "sales-docs", name: "Documents", webUrl: "https://contoso.sharepoint.test/sites/sales/Shared Documents" }] });
    if (g === "/me/joinedTeams") return json({ value: [{ id: "team-sales", displayName: "Sales", description: "The sales team" }] });
    if (g === "/me/chats") return json({ value: [{ id: "19:chat-bob@unq.gbl.spaces", topic: null, chatType: "oneOnOne", members: [{ displayName: "Alice Martin" }, { displayName: "Bob Durand" }] }] });
    let m = /^\/teams\/([^/]+)\/channels(?:\/([^/]+)\/messages)?$/.exec(g) ?? /^\/chats\/([^/]+)\/messages$/.exec(g);
    if (m) {
      const chat = g.startsWith("/chats/");
      if (!chat && !channels[m[1] as string]) return err(404, "No team found with Group Id");
      if (!chat && !m[2]) return json({ value: (channels[m[1] as string] ?? []).map((c) => ({ ...c, webUrl: `https://teams.test/channel/${c.id}` })) });
      if (req.method !== "POST") return err(405, "method");
      if (!chat && !channels[m[1] as string]?.some((c) => c.id === m?.[2])) return err(404, "Channel not found");
      const id = `msg-${++n}`;
      messages.push({ to: g, body: JSON.parse(raw.toString()).body });
      return json({ id, webUrl: `https://teams.test/message/${id}` }, 201);
    }
    m = /^\/drives\/([^/]+)\/(?:root|items\/([^/:]+))\/children$/.exec(g);
    if (m) {
      const parent = m[2] ?? `${m[1]}-root`;
      return json({ value: [...items.values()].filter((i) => i.parent === parent).map(view) });
    }
    m = /^\/drives\/([^/]+)\/root\/search\(q='(.*)'\)$/.exec(g);
    if (m) {
      const [drive, q] = [m[1], (m[2] as string).replace(/''/g, "'").toLowerCase()];
      return json({ value: [...items.values()].filter((i) => i.drive === drive && i.parent && i.name.toLowerCase().includes(q)).map(view) });
    }
    m = /^\/drives\/([^/]+)\/(?:root|items\/([^/:]+)):\/(.+):\/createUploadSession$/.exec(g);
    if (m && req.method === "POST") {
      const sid = randomUUID();
      uploads.set(sid, { drive: m[1] as string, parent: m[2] ?? `${m[1]}-root`, name: m[3] as string, chunks: [], got: 0 });
      return json({ uploadUrl: `${base}/upload/${sid}`, expirationDateTime: "2026-10-11T00:00:00Z" });
    }
    m = /^\/drives\/([^/]+)\/items\/([^/:]+)$/.exec(g);
    if (m) {
      const i = items.get(m[2] as string);
      return i && i.drive === m[1] ? json(view(i)) : err(404, "The resource could not be found.");
    }
    return err(400, `unexpected call ${req.method} ${g}`);
  });
  base = await listen(server);
  /** Revoke every token, as withdrawing consent does. */
  const revoke = () => (access.clear(), refresh.clear());
  return { server, items, requests, messages, revoke, authority: base, graph: `${base}/v1.0` };
}
