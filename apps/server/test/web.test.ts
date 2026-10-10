import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { REPO } from "../src/engine.ts";
import { createHttp } from "../src/http.ts";
import { access } from "../src/decks.ts";
import { TOKEN_TTL_S, tokenUser, userToken } from "../src/preview.ts";
import { sessions } from "../src/session.ts";
import type { App } from "../src/tools.ts";
import { fakeModel, fakeOidc, lastResult, toolsCalled } from "./fakes.ts";
import { acmeDeck, ENGINE_TIMEOUT, fakeFont, testApp } from "./helpers.ts";

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
    if (init.cookie && !headers.has("origin")) headers.set("origin", app.publicUrl); // what the browser sends
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
    http = createHttp(app, auth, sessions({ issuer: idp.issuer, clientId: "calque-web", publicUrl: app.publicUrl, teamsClaim: "groups", secret: app.secret, access: app.access }));
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

  it("sends the user back only to a path on this site after sign-in", async () => {
    const signIn = async (back: string) => {
      const login = await req(`/auth/login?return=${encodeURIComponent(back)}`);
      const page = await (await fetch(new URL(login.headers.get("location") ?? ""))).text();
      const link = new URL((page.match(/href="([^"]+)">Sign in as alice/)?.[1] ?? "").replace(/&amp;/g, "&"));
      return (await req(link.pathname + link.search, { cookie: cookieOf(login, "calque_login") })).headers.get("location");
    };
    expect(await signIn("/decks/1?v=2")).toBe("/decks/1?v=2");
    for (const evil of ["//evil.example/x", "/\\evil.example/x", "/\t/evil.example/x", "https://evil.example/x", "evil.example"])
      expect(await signIn(evil)).toBe("/");
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

    expect(draft.review.colors["theme.accent1"]).toMatch(/^[0-9A-F]{6}$/);
    expect(draft.review.fonts["role.font.body"]).toBeTruthy();
    expect(draft.archetypes).toContain("cards");
    expect(draft.archetypes).not.toContain("cover");

    const upFont = async (bytes: Buffer, name: string) => {
      const font = new FormData();
      font.set("font", new Blob([new Uint8Array(bytes)]), name);
      return req(`/api/packs/drafts/${draft.draft_id}/fonts`, { method: "POST", body: font, cookie: alice });
    };
    expect((await upFont(Buffer.from("not really a font"), "Bad.ttf")).status).toBe(400);
    expect((await (await upFont(fakeFont("Brand Sans"), "Brand-Regular.ttf")).json()) as Json).toEqual({ fonts: ["Brand-Regular.ttf"], family: "Brand Sans" });

    const archetyped = { ...draft.manifest, roles: { ...draft.manifest.roles, archetypes: { cards: [3] } } };
    const published = await json(`/api/packs/drafts/${draft.draft_id}/publish`, { manifest: archetyped, voice: "# Voice\n\nPlain words.", visibility: "team" });
    expect(published.body).toMatchObject({ status: "published", id: "newco", visibility: "team", teams: ["sales", "calque-admins"] });
    // the uploaded font's family is now a pack font
    const yaml = parse(readFileSync(join(app.data, "pack-versions/newco/1/pack.yaml"), "utf8"));
    expect(yaml.lint.extra_fonts).toContain("Brand Sans");
    expect(yaml.roles.archetypes).toEqual({ cards: [3] });

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

  it("edits a published pack through a draft, owner or admin only", async () => {
    expect((await json("/api/packs/acme-test/edit", {}, { bearer: await idp.token("bob") })).status).toBe(403);
    expect((await json("/api/packs/newco/edit", {}, { bearer: await idp.token("bob") })).status).toBe(403);

    const draft = (await json("/api/packs/newco/edit", {})).body;
    expect(draft.manifest).toMatchObject({ id: "newco", name: "NewCo" });
    expect(draft.voice).toBe("# Voice\n\nPlain words.");
    expect(draft.fonts).toEqual(["Brand-Regular.ttf"]);
    expect(draft.manifest.lint.extra_fonts).toContain("Brand Sans");
    expect(draft.slides).toHaveLength(4);
    expect((await req(draft.slides[0].image_url, { cookie: alice })).headers.get("content-type")).toBe("image/png");

    const broken = { ...draft.manifest, roles: { ...draft.manifest.roles, closing: [9] } };
    expect((await json(`/api/packs/drafts/${draft.draft_id}/publish`, { manifest: broken, visibility: "team" })).status).toBe(422);

    const saved = await json(`/api/packs/drafts/${draft.draft_id}/publish`, { manifest: { ...draft.manifest, name: "NewCo Renamed" }, voice: "Short.", visibility: "team" });
    expect(saved.body).toEqual({ status: "published", id: "newco", version: 2 });
    const pack = (await json("/api/tools/list_packs", {})).body.packs.find((p: Json) => p.id === "newco");
    expect(pack).toMatchObject({ name: "NewCo Renamed", visibility: "workspace" });
  });

  it("keeps decks to their owner; the per-user preview token reads and comments on one deck", async () => {
    const bob = { bearer: await idp.token("bob") };
    const a = (await json("/api/tools/create_deck", { deck: acmeDeck() })).body;
    const b = (await json("/api/tools/create_deck", { deck: acmeDeck() })).body;
    const id = a.deck_id as string;

    // another signed-in user: the deck does not exist for them
    expect((await json("/api/tools/open_deck", { deck_id: id, render: false }, bob)).status).toBe(404);
    expect((await json("/api/tools/patch_deck", { deck_id: id, ops: [{ op: "set", slide: "cover", shape_id: 2, value: "x" }] }, bob)).status).toBe(404);
    expect((await json("/api/tools/export_pptx", { deck_id: id }, bob)).status).toBe(404);
    expect((await json("/api/tools/add_comment", { deck_id: id, slide_id: "cover", text: "x" }, bob)).status).toBe(404);
    expect((await json(`/decks/${id}/data`, undefined, bob)).status).toBe(404);
    expect((await json("/api/tools/open_deck", { deck_id: "nope", render: false }, bob)).body.message).toBe('no deck "nope"');

    // no session, no link: refused
    expect((await req(`/decks/${id}/deck.pptx`)).status).toBe(401);
    expect((await req(`/decks/${id}/data`)).status).toBe(401);
    // the owner's session needs no link
    expect((await req(`/decks/${id}/deck.pptx`, { cookie: alice })).status).toBe(200);

    const link = new URL(a.preview_url);
    const t = link.searchParams.get("t") ?? "";
    expect((await req(`/decks/${id}/deck.pptx?t=${t}`)).status).toBe(200);
    const data = (await json(`/decks/${id}/data?t=${t}`, undefined, {})).body;
    expect(data.deck_id).toBe(id);
    // the PNG URLs carry the same token, not a fresh (longer) one
    expect(new URL(data.slides[0].image_url).searchParams.get("t")).toBe(t);
    expect((await req(new URL(data.slides[0].image_url).pathname + new URL(data.slides[0].image_url).search)).headers.get("content-type")).toBe("image/png");
    const posted = await req(`/decks/${id}/comments?t=${t}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slide_id: "cover", text: "Looks good" }),
    });
    expect(posted.status).toBe(200);
    const comments = (await json("/api/tools/list_comments", { deck_id: id })).body.comments;
    expect(comments).toMatchObject([{ text: "Looks good", author: "alice" }]);

    // tampered, expired, or for another deck: refused
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body ?? "", "base64url").toString()), d: b.deck_id })).toString("base64url");
    expect((await req(`/decks/${b.deck_id}/deck.pptx?t=${forged}.${sig}`)).status).toBe(401);
    expect((await req(`/decks/${id}/deck.pptx?t=${t}x`)).status).toBe(401);
    expect((await req(`/decks/${b.deck_id}/deck.pptx?t=${t}`)).status).toBe(401);
    const old = userToken(app.secret, { id: "alice", teams: ["sales"] }, id, Date.now() - TOKEN_TTL_S * 1000 - 7200_000);
    expect((await req(`/decks/${id}/deck.pptx?t=${old}`)).status).toBe(401);
    // a token for someone with no access to the deck opens nothing
    const bobs = userToken(app.secret, { id: "bob", teams: [] }, id);
    expect((await req(`/decks/${id}/deck.pptx?t=${bobs}`)).status).toBe(404);

    // the token stands for its user on its deck only
    const user = tokenUser(app.secret, t, id) ?? { id: "", teams: [] };
    expect(user).toMatchObject({ id: "alice", teams: ["sales", "calque-admins"] });
    expect(tokenUser(app.secret, t, b.deck_id)).toBeUndefined();
    const other = { id: b.deck_id, owner: "bob", pack_id: "acme-test", general_access: "private" as const, general_role: "viewer" as const, link_key: "k" };
    expect(await access(app.db, user, other)).toBeNull();
  });

  it("streams the agent's steps as NDJSON", async () => {
    const res = await req("/api/agent/chat", {
      method: "POST",
      cookie: alice,
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ messages: [{ role: "user", content: "which packs?" }] }),
    });
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ step: { tools: [{ name: "list_packs" }] } });
    expect(lines.at(-1)).toMatchObject({ done: { model: "env", text: "3 packs" } });
  });
});
