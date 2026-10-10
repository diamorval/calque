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
