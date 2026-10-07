import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { REPO } from "../src/engine.ts";
import { createHttp } from "../src/http.ts";
import { sessions } from "../src/session.ts";
import type { App } from "../src/tools.ts";
import { fakeModel, fakeOidc, lastResult, toolsCalled } from "./fakes.ts";
import { acmeDeck, ENGINE_TIMEOUT, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("web app routes", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let http: ReturnType<typeof createHttp>;
  let idp: Awaited<ReturnType<typeof fakeOidc>>;
  let model: Awaited<ReturnType<typeof fakeModel>>;
  let alice = "";

  const req = async (path: string, init: RequestInit & { cookie?: string; bearer?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("cookie", init.cookie);
    if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
    return http.request(path, { ...init, headers });
  };
  const json = async (path: string, body?: unknown, who: { cookie?: string; bearer?: string } = { cookie: alice }) => {
    const res = await req(path, {
      ...who,
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const cookieOf = (res: Response, name: string) =>
    res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? "";

  beforeAll(async () => {
    idp = await fakeOidc();
    model = await fakeModel((b) => {
      if (toolsCalled(b) === 0) return { tool: { name: "list_packs", args: {} } };
      return { content: `${lastResult(b).packs.length} packs` };
    });
    vi.stubEnv("CALQUE_LLM_BASE_URL", model.url);
    vi.stubEnv("CALQUE_LLM_API_KEY", "good-key");
    vi.stubEnv("CALQUE_LLM_MODEL", "m");
    app = await testApp();
    const auth = { issuer: idp.issuer, audience: "calque", resource: new URL("/mcp", app.publicUrl), teamsClaim: "groups" };
    http = createHttp(app, auth, sessions({ issuer: idp.issuer, clientId: "calque-web", publicUrl: app.publicUrl, teamsClaim: "groups", secret: app.secret }));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    idp.server.close();
    model.server.close();
    await app.db.close();
  });

  it("refuses access without a session, then signs in through the issuer", async () => {
    expect((await req("/api/decks")).status).toBe(401);
    expect((await req("/api/tools/list_packs", { method: "POST" })).status).toBe(401);

    const login = await req("/auth/login?return=/settings/packs");
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get("location") ?? "");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const page = await (await fetch(authorize)).text();
    const link = (page.match(/href="([^"]+)">Sign in as alice/)?.[1] ?? "").replace(/&amp;/g, "&");
    const back = new URL(link);
    const callback = await req(back.pathname + back.search, { cookie: cookieOf(login, "calque_login") });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/settings/packs");
    alice = cookieOf(callback, "calque_session");
    expect(alice).toMatch(/^calque_session=/);

    const me = await json("/api/me");
    expect(me.body).toMatchObject({ id: "alice", name: "Alice Martin", teams: ["sales", "calque-admins"], admin: true, auth: true });
    // MCP clients keep their bearer token
    expect((await json("/api/me", undefined, { bearer: await idp.token("bob") })).body).toMatchObject({ id: "bob", admin: false });
    // a forged cookie is ignored
    expect((await req("/api/me", { cookie: `${alice}x` })).status).toBe(401);
  });

  it("imports a template as a draft, publishes it to the importer's teams, hides it from others", async () => {
    const form = new FormData();
    form.set("id", "newco");
    form.set("name", "NewCo");
    form.set("template", new Blob([readFileSync(join(REPO, "packs/acme-test/template.pptx"))]), "template.pptx");
    const res = await req("/api/packs/drafts", { method: "POST", body: form, cookie: alice });
    const draft = (await res.json()) as Json;
    expect(res.status).toBe(200);
    expect(draft.manifest.roles).toEqual({ cover: [1], divider: [2], content: [3], closing: [4] });
    expect(draft.slides).toHaveLength(4);
    expect((await req(draft.slides[0].image_url, { cookie: alice })).headers.get("content-type")).toBe("image/png");
    expect((await req(draft.slides[0].image_url, { bearer: await idp.token("bob") })).status).toBe(404);

    const font = new FormData();
    font.set("font", new Blob([Buffer.from("not really a font")]), "Brand-Regular.ttf");
    expect((await (await req(`/api/packs/drafts/${draft.draft_id}/fonts`, { method: "POST", body: font, cookie: alice })).json()) as Json).toEqual({ fonts: ["Brand-Regular.ttf"] });

    const published = await json(`/api/packs/drafts/${draft.draft_id}/publish`, { manifest: draft.manifest, voice: "# Voice\n\nPlain words.", visibility: "team" });
    expect(published.body).toMatchObject({ status: "published", id: "newco", visibility: "team", teams: ["sales", "calque-admins"] });

    const packs = (who: { cookie?: string; bearer?: string }) => json("/api/tools/list_packs", {}, who).then((r) => r.body.packs.map((p: Json) => p.id));
    expect(await packs({ cookie: alice })).toContain("newco");
    expect(await packs({ bearer: await idp.token("bob") })).not.toContain("newco");

    const deck = await json("/api/tools/create_deck", { deck: { ...acmeDeck(), pack_id: "newco" } });
    const lint = (await json("/api/tools/lint_deck", { deck_id: deck.body.deck_id })).body;
    expect(lint.findings.filter((f: Json) => f.severity === "ERROR")).toEqual([]);
    expect((await json("/api/decks")).body.decks).toMatchObject([{ id: deck.body.deck_id, pack_id: "newco", title: "Quarterly review", head: 1 }]);

    expect((await json("/api/packs/newco/visibility", { visibility: "workspace" }, { bearer: await idp.token("bob") })).status).toBe(404);
    expect((await json("/api/packs/newco/visibility", { visibility: "workspace" })).body).toMatchObject({ visibility: "workspace" });
    expect(await packs({ bearer: await idp.token("bob") })).toContain("newco");
  });

  it("streams the agent's steps as NDJSON", async () => {
    const res = await req("/api/agent/chat", {
      method: "POST",
      cookie: alice,
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ messages: [{ role: "user", content: "which packs?" }] }),
    });
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ step: { tools: ["list_packs"] } });
    expect(lines.at(-1)).toMatchObject({ done: { model: "env", text: "3 packs" } });
  });
});
