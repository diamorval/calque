import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { audit, auditLog } from "../src/audit.ts";
import { MAX_UPLOAD, saveFile } from "../src/files.ts";
import { createHttp } from "../src/http.ts";
import type { User } from "../src/packs.ts";
import { purge, retentionDays } from "../src/retention.ts";
import { sessions } from "../src/session.ts";
import { TOOLS, type App } from "../src/tools.ts";
import { fakeOidc } from "./fakes.ts";
import { acmeDeck, ENGINE_TIMEOUT, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const alice: User = { id: "alice", teams: ["sales"] };
const bob: User = { id: "bob", teams: ["ops"] };
const root: User = { id: "root", teams: ["calque-admins"] };

describe("enterprise compliance", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let http: ReturnType<typeof createHttp>;
  let idp: Awaited<ReturnType<typeof fakeOidc>>;

  const call = (user: User, name: keyof typeof TOOLS, args: Json = {}): Promise<Json> => {
    const t = TOOLS[name];
    return t.run(app, user, t.input.parse(args) as never);
  };
  const req = async (path: string, bearer?: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (bearer) headers.set("authorization", `Bearer ${bearer}`);
    const res = await http.request(path, { ...init, headers });
    return { status: res.status, headers: res.headers, body: (await res.json().catch(() => ({}))) as Json };
  };
  const newDeck = async (user: User) => (await call(user, "create_deck", { deck: acmeDeck() })).deck_id as string;
  const cookieOf = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? "";

  beforeAll(async () => {
    idp = await fakeOidc();
    app = await testApp();
    const auth = { issuer: idp.issuer, audience: "calque", resource: new URL("/mcp", app.publicUrl), teamsClaim: "groups" };
    const web = sessions({
      issuer: idp.issuer,
      clientId: "calque-web",
      publicUrl: app.publicUrl,
      teamsClaim: "groups",
      secret: app.secret,
      access: app.access,
      onSignIn: (u) => audit(app.db, u, "sign_in", "user", u.id),
    });
    http = createHttp(app, auth, web);
  });
  afterAll(async () => {
    idp.server.close();
    await app.db.close();
  });

  it("logs deck create, edit, export and delete, and an admin reads the log with filters", async () => {
    const id = await newDeck(alice);
    await call(alice, "patch_deck", { deck_id: id, ops: [{ op: "set", slide: "cover", shape_id: 2, value: "Audited" }], note: "retitle" });
    await call(alice, "export_pptx", { deck_id: id });
    await call(alice, "share_deck", { deck_id: id, principal_type: "user", principal: "bob", role: "viewer" });

    const log = await auditLog(app.db, { target_type: "deck", target_id: id });
    expect(log.map((e) => e.action).reverse()).toEqual(["create", "edit", "export", "share"]);
    expect(log.find((e) => e.action === "edit")).toMatchObject({ actor: "alice", detail: { version: 2, note: "retitle" } });

    const admin = await idp.token("root", ["/calque-admins"]);
    expect((await req("/api/admin/audit", await idp.token("bob"))).status).toBe(403);
    const r = await req(`/api/admin/audit?target_id=${id}&action=edit`, admin);
    expect(r.status).toBe(200);
    expect(r.body.events).toHaveLength(1);
    expect((await req(`/api/admin/audit?actor=nobody`, admin)).body.events).toEqual([]);
    expect((await req(`/api/admin/audit?since=2999-01-01`, admin)).body.events).toEqual([]);
  });

  it("logs model changes and sign-in", async () => {
    await expect(app.models.remove(bob, "x")).rejects.toThrow(/configure models/);
    await app.db.query("insert into models (id, provider, model, updated_by) values ('m:1', 'ollama', 'm', 'root')");
    await app.models.setDefault(root, "m:1");
    await app.models.remove(root, "m:1");
    expect((await auditLog(app.db, { target_type: "model" })).map((e) => `${e.actor} ${e.action}`)).toEqual(["root remove", "root default"]);

    const login = await http.request("/auth/login");
    const page = await (await fetch(new URL(login.headers.get("location") ?? ""))).text();
    const link = new URL((page.match(/href="([^"]+)">Sign in as alice/)?.[1] ?? "").replace(/&amp;/g, "&"));
    const back = await http.request(link.pathname + link.search, { headers: { cookie: cookieOf(login, "calque_login") } });
    expect(back.status).toBe(302);
    expect(await auditLog(app.db, { action: "sign_in" })).toMatchObject([{ actor: "alice", target_type: "user", target_id: "alice" }]);
  });

  it("deletes a deck for its owner or an admin: rows, versions, comments, shares and files", async () => {
    const id = await newDeck(alice);
    await call(alice, "add_comment", { deck_id: id, slide_id: "cover", text: "x" });
    await call(alice, "share_deck", { deck_id: id, principal_type: "user", principal: "bob", role: "editor" });
    await call(alice, "open_deck", { deck_id: id }); // renders under the deck's folder
    expect(existsSync(app.decks.dir(id))).toBe(true);
    await app.db.query("insert into chats (id, deck_id, owner, messages) values ($1, $2, 'alice', '[]')", [`deck:${id}`, id]); // its agent conversation

    await expect(call(bob, "delete_deck", { deck_id: id })).rejects.toThrow(/owner access needed/);
    expect(await call(alice, "delete_deck", { deck_id: id })).toEqual({ deck_id: id, deleted: true });
    expect(existsSync(app.decks.dir(id))).toBe(false);
    for (const t of ["decks where id", "deck_versions where deck_id", "comments where deck_id", "deck_shares where deck_id", "chats where deck_id"])
      expect((await app.db.query(`select 1 from ${t} = $1`, [id])).rows).toEqual([]);
    await expect(call(alice, "open_deck", { deck_id: id })).rejects.toThrow(/no deck/);
    // the log keeps that it existed
    expect((await auditLog(app.db, { target_id: id, action: "delete" }))[0]).toMatchObject({ actor: "alice", detail: { title: acmeDeck().title } });

    // REST: an admin, who cannot read the deck, may delete it; others get a 404
    const other = await newDeck(alice);
    expect((await req(`/api/decks/${other}`, await idp.token("bob"), { method: "DELETE" })).status).toBe(404);
    const r = await req(`/api/decks/${other}`, await idp.token("root", ["/calque-admins"]), { method: "DELETE" });
    expect(r.body).toEqual({ deck_id: other, deleted: true });
  });

  it("retention purges decks untouched for N days and old uploads", async () => {
    expect(retentionDays({})).toBeUndefined();
    expect(retentionDays({ CALQUE_RETENTION_DAYS: "30" })).toBe(30);
    expect(() => retentionDays({ CALQUE_RETENTION_DAYS: "soon" })).toThrow(/CALQUE_RETENTION_DAYS/);

    const stale = await newDeck(alice);
    const fresh = await newDeck(alice);
    await app.db.query("update deck_versions set created_at = now() - interval '40 days' where deck_id = $1", [stale]);
    const old = await saveFile(app.db, app.data, alice, "old.png", "image/png", Buffer.from("x"));
    await app.db.query("update files set created_at = now() - interval '40 days' where id = $1", [old.file_id]);
    const stray = join(app.data, "uploads", "inline.pptx");
    writeFileSync(stray, "x");
    utimesSync(stray, new Date(Date.now() - 40 * 86_400_000), new Date(Date.now() - 40 * 86_400_000));

    // new-deck chat drafts and usage rows go by age; a deck's conversation goes with its deck
    await app.db.query("insert into chats (id, owner, updated_at) values ('draft:alice', 'alice', now() - interval '40 days'), ('draft:bob', 'bob', now())");
    await app.db.query("insert into chats (id, deck_id, owner) values ($1, $2, 'alice')", [`deck:${stale}`, stale]);
    await app.db.query("insert into usage (user_id, model_id, run, at) values ('alice', 'env', 'chat', now() - interval '40 days'), ('bob', 'env', 'chat', now())");

    expect(await purge(app, 30)).toEqual({ decks: 1, files: 2, chats: 1, usage: 1 });
    expect((await app.db.query("select id from decks where id = any($1::uuid[])", [[stale, fresh]])).rows).toEqual([{ id: fresh }]);
    expect((await app.db.query("select id from chats order by id")).rows).toEqual([{ id: "draft:bob" }]);
    expect((await app.db.query("select user_id from usage")).rows).toEqual([{ user_id: "bob" }]);
    expect(readdirSync(join(app.data, "uploads"))).toEqual([]);
    expect((await auditLog(app.db, { actor: "retention" })).map((e) => e.action)).toEqual(["purge", "delete"]);
  });

  it("caps request bodies on every upload route and base64 tool call", async () => {
    const bearer = await idp.token("alice");
    const big = new FormData();
    big.set("template", new Blob([Buffer.alloc(MAX_UPLOAD + 2 * 1024 * 1024)]), "t.pptx");
    expect((await req("/api/packs/drafts", bearer, { method: "POST", body: big })).status).toBe(413);
    const font = new FormData();
    font.set("font", new Blob([Buffer.alloc(MAX_UPLOAD + 2 * 1024 * 1024)]), "f.ttf");
    expect((await req("/api/packs/drafts/x/fonts", bearer, { method: "POST", body: font })).status).toBe(413);
    const json = JSON.stringify({ file: { base64: "A".repeat(Math.ceil((MAX_UPLOAD * 4) / 3) + 2 * 1024 * 1024) }, pack_id: "acme-test", language: "en" });
    const r = await req("/api/tools/import_pptx", bearer, { method: "POST", headers: { "content-type": "application/json" }, body: json });
    expect(r.status).toBe(413);
    // the tool itself checks the decoded size (MCP over stdio has no HTTP cap)
    await expect(call(alice, "import_pptx", { file: { base64: Buffer.alloc(MAX_UPLOAD + 1).toString("base64") }, pack_id: "acme-test", language: "en" })).rejects.toThrow(
      /over 50 MB/,
    );
  });

  it("rate-limits sign-in, agent runs and model tests", async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await http.request("/auth/logout")).status;
    expect(last).toBe(429);
    const bearer = await idp.token("bob");
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await req("/api/agent/chat", bearer, { method: "POST", body: "{}" })).status);
    expect(codes.at(-1)).toBe(429);
    expect(codes[0]).not.toBe(429);
    // another user has their own budget
    expect((await req("/api/agent/chat", await idp.token("carol"), { method: "POST", body: "{}" })).status).not.toBe(429);
    const m: number[] = [];
    for (let i = 0; i < 11; i++) m.push((await req("/api/models", bearer, { method: "POST", body: "{}" })).status);
    expect(m.at(-1)).toBe(429);
  });

  it("refuses to start with sign-in on and no CALQUE_SECRET", async () => {
    vi.stubEnv("CALQUE_OIDC_ISSUER", "https://idp.example");
    vi.stubEnv("CALQUE_SECRET", "");
    try {
      await expect(createApp({ db: "memory://" })).rejects.toThrow(/CALQUE_SECRET is not set/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
