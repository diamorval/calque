import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO } from "../src/engine.ts";
import { connect, createHttp } from "../src/http.ts";
import type { User } from "../src/packs.ts";
import { TOOLS, type App } from "../src/tools.ts";
import { fakeOidc } from "./fakes.ts";
import { acmeDeck, ENGINE_TIMEOUT, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const alice: User = { id: "alice", name: "Alice Martin", teams: ["sales"] };
const bob: User = { id: "bob", teams: ["ops"] };
const carol: User = { id: "carol", teams: ["ops"] };
const dave: User = { id: "dave", teams: ["finance"] };
const root: User = { id: "root", teams: ["calque-admins"] };

describe("deck sharing", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let http: ReturnType<typeof createHttp>;
  let idp: Awaited<ReturnType<typeof fakeOidc>>;
  let id = "";
  let key = "";

  /** Run tool `name` as `user`, its input parsed as the REST and MCP doors do. */
  const call = (user: User, name: keyof typeof TOOLS, args: Json = {}): Promise<Json> => {
    const t = TOOLS[name];
    return t.run(app, user, t.input.parse(args) as never);
  };
  const open = (user: User) => call(user, "open_deck", { deck_id: id, render: false });
  const comment = (user: User) => call(user, "add_comment", { deck_id: id, slide_id: "cover", text: `from ${user.id}` });
  const get = async (path: string, bearer?: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (bearer) headers.set("authorization", `Bearer ${bearer}`);
    const res = await http.request(path, { ...init, headers });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
  };
  const post = (path: string, bearer?: string, body: Json = {}) =>
    get(path, bearer, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  /** The deck through its share link (`?k=`), as `who` (a signed-in user id) or anonymously. */
  const viaLink = async (who?: string, k = key) => get(`/decks/${id}/data?k=${encodeURIComponent(k)}`, who && (await idp.token(who)));
  const commentViaLink = async (who?: string) => post(`/decks/${id}/comments?k=${encodeURIComponent(key)}`, who && (await idp.token(who)), { slide_id: "cover", text: "via link" });
  const keyOf = (url: string) => new URL(url).searchParams.get("k") ?? "";
  const tokenOf = (url: string) => encodeURIComponent(new URL(url).searchParams.get("t") ?? "");
  const onPack = async (pack: string) => app.db.query("update decks set pack_id = $2 where id = $1", [id, pack]);

  beforeAll(async () => {
    idp = await fakeOidc();
    app = await testApp();
    http = createHttp(app, { issuer: idp.issuer, audience: "calque", resource: new URL("/mcp", app.publicUrl), teamsClaim: "groups" });
    id = (await call(alice, "create_deck", { deck: acmeDeck() })).deck_id;
    await app.db.query("insert into packs (id, dir, visibility, teams, owner) values ('sales-only', $1, 'team', '[\"sales\"]', 'alice')", [`${REPO}/packs/acme-test`]);
  });
  afterAll(async () => {
    idp.server.close();
    await app.db.close();
  });

  it("a new deck is private: its one link opens for the owner and people with access only", async () => {
    const s = await call(alice, "list_shares", { deck_id: id });
    expect(s).toMatchObject({ owner: "alice", people: [], general: { access: "private", role: "viewer" } });
    expect(s.url).toMatch(new RegExp(`/decks/${id}\\?k=`));
    key = keyOf(s.url);
    expect(key.length).toBeGreaterThan(20);

    expect((await viaLink()).status).toBe(404); // anonymous
    expect((await viaLink("dave")).status).toBe(404); // signed in, no access
    expect((await viaLink("alice")).body).toMatchObject({ deck_id: id, role: "owner" });
    expect(await call(alice, "share_deck", { deck_id: id, principal_type: "user", principal: "bob", role: "viewer" })).toMatchObject({ role: "viewer" });
    expect((await viaLink("bob")).body).toMatchObject({ deck_id: id, role: "viewer" });
  });

  it("people grants: a viewer reads but neither comments nor edits, a commenter comments", async () => {
    await expect(open(carol)).rejects.toThrow(/no deck/);
    expect(await open(bob)).toMatchObject({ deck_id: id, role: "viewer" });
    expect((await call(bob, "export_pptx", { deck_id: id })).download_url).toContain(`/decks/${id}/deck.pptx`);
    await expect(comment(bob)).rejects.toThrow(/commenter access needed/);
    await expect(call(bob, "patch_deck", { deck_id: id, ops: [{ op: "set", slide: "cover", shape_id: 2, value: "x" }] })).rejects.toThrow(/editor access needed/);

    await call(alice, "share_deck", { deck_id: id, principal_type: "user", principal: "bob", role: "commenter" });
    expect((await comment(bob)).comment).toMatchObject({ author: "bob" });
    await expect(call(bob, "restore_version", { deck_id: id })).rejects.toThrow(/editor access needed/);
    await call(alice, "share_deck", { deck_id: id, principal_type: "user", principal: "bob", role: "viewer" });
  });

  it("workspace: anyone signed in who has the link and sees the pack gets the general role", async () => {
    expect(await call(alice, "set_general_access", { deck_id: id, access: "workspace", role: "commenter" })).toEqual({ access: "workspace", role: "commenter", expires_at: null });
    // with the link: the general role
    expect((await viaLink("dave")).body).toMatchObject({ deck_id: id, role: "commenter" });
    expect((await commentViaLink("dave")).body.comment).toMatchObject({ author: "dave" });
    // the best role wins: bob's viewer grant, the link's commenter
    expect((await viaLink("bob")).body.role).toBe("commenter");
    // without the link: nothing, and not in their list
    expect((await get(`/decks/${id}/data`, await idp.token("dave"))).status).toBe(404);
    await expect(open(dave)).rejects.toThrow(/no deck/);
    expect((await call(dave, "list_decks")).decks).toEqual([]);
    // never anonymous
    expect((await viaLink()).status).toBe(404);
    // the pack gate: dave does not see a sales-only pack
    await onPack("sales-only");
    try {
      expect((await viaLink("dave")).status).toBe(404);
    } finally {
      await onPack("acme-test");
    }
  });

  it("anyone with the link: no sign-in, viewer or commenter, never more", async () => {
    await call(alice, "set_general_access", { deck_id: id, access: "anyone", role: "viewer" });
    const anon = await viaLink();
    expect(anon.body).toMatchObject({ deck_id: id, role: "viewer" });
    // its URLs carry the link, not a token
    expect(keyOf(anon.body.preview_url)).toBe(key);
    expect(keyOf(anon.body.slides[0].image_url)).toBe(key);
    expect((await commentViaLink()).status).toBe(403);

    await call(alice, "set_general_access", { deck_id: id, access: "anyone", role: "commenter" });
    expect((await commentViaLink()).body.comment).toMatchObject({ author: "guest", text: "via link" });
    // never an editor: not as a general role, nor through the tools
    expect(() => TOOLS.set_general_access.input.parse({ deck_id: id, access: "anyone", role: "editor" })).toThrow();
    const guest: User = { id: "guest", teams: [], anonymous: true, key };
    await expect(call(guest, "patch_deck", { deck_id: id, ops: [{ op: "set", slide: "cover", shape_id: 2, value: "x" }] })).rejects.toThrow(/editor access needed/);
    await expect(call(guest, "list_shares", { deck_id: id })).rejects.toThrow(/owner access needed/);
    expect((await post("/api/tools/patch_deck", undefined, { deck_id: id, ops: [] })).status).toBe(401);
    // no pack gate
    await onPack("sales-only");
    try {
      expect((await viaLink()).body.role).toBe("commenter");
    } finally {
      await onPack("acme-test");
    }
    // a wrong key opens nothing
    expect((await viaLink(undefined, `${key.slice(0, -1)}x`)).status).toBe(404);
  });

  it("reset link: the old link stops working, the new one works", async () => {
    const old = key;
    const r = await call(alice, "reset_link", { deck_id: id });
    key = keyOf(r.url);
    expect(key).not.toBe(old);
    expect((await viaLink(undefined, old)).status).toBe(404);
    expect((await viaLink("dave", old)).status).toBe(404);
    expect((await viaLink()).status).toBe(200);
    expect(keyOf((await call(alice, "list_shares", { deck_id: id })).url)).toBe(key);
  });

  it("link expiry: past it the link opens for people with access only; the default comes from CALQUE_LINK_DAYS", async () => {
    // an expiry set with the general access
    const r = await call(alice, "set_general_access", { deck_id: id, access: "anyone", role: "viewer", expires_in_days: 7 });
    expect(Date.parse(r.expires_at) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect((await call(alice, "list_shares", { deck_id: id })).general.expires_at).toBe(r.expires_at);
    // changing the role keeps it
    expect((await call(alice, "set_general_access", { deck_id: id, access: "anyone", role: "commenter" })).expires_at).toBe(r.expires_at);
    expect((await viaLink()).status).toBe(200);

    // past it: anonymous and workspace holders are told it expired; people with access still open it
    await app.db.query("update decks set link_expires_at = now() - interval '1 minute' where id = $1", [id]);
    const expired = await viaLink();
    expect(expired.status).toBe(403);
    expect(expired.body.message).toMatch(/share link expired/);
    expect((await viaLink("dave")).status).toBe(403);
    expect((await viaLink("bob")).body.role).toBe("viewer");
    // a wrong key still says nothing
    expect((await viaLink(undefined, `${key.slice(0, -1)}x`)).status).toBe(404);

    // 0: no expiry
    expect((await call(alice, "set_general_access", { deck_id: id, access: "anyone", role: "viewer", expires_in_days: 0 })).expires_at).toBeNull();
    expect((await viaLink()).status).toBe(200);

    // the workspace default applies when a private deck opens up, not otherwise
    process.env.CALQUE_LINK_DAYS = "30";
    try {
      expect((await call(alice, "set_general_access", { deck_id: id, access: "workspace", role: "viewer" })).expires_at).toBeNull();
      await call(alice, "set_general_access", { deck_id: id, access: "private" });
      const opened = await call(alice, "set_general_access", { deck_id: id, access: "anyone", role: "viewer" });
      expect(Math.round((Date.parse(opened.expires_at) - Date.now()) / 86_400_000)).toBe(30);
    } finally {
      delete process.env.CALQUE_LINK_DAYS;
    }
    await call(alice, "set_general_access", { deck_id: id, access: "private", expires_in_days: 0 });
  });

  it("team grants and the best role; a grant counts only while the user sees the pack", async () => {
    await call(alice, "set_general_access", { deck_id: id, access: "private" });
    await call(alice, "share_deck", { deck_id: id, principal_type: "team", principal: "ops", role: "editor" });
    expect((await open(carol)).role).toBe("editor");
    expect((await open(bob)).role).toBe("editor"); // user viewer, team editor
    const patched = await call(carol, "patch_deck", { deck_id: id, ops: [{ op: "set", slide: "cover", shape_id: 2, value: "Edited by Carol" }] });
    expect(patched.version).toBe(2);
    expect((await app.decks.versions(id)).at(-1)).toMatchObject({ author: "carol" });

    await onPack("sales-only");
    try {
      await expect(open(carol)).rejects.toThrow(/no deck/);
      expect((await call(carol, "list_decks")).decks).toEqual([]);
      expect((await open(alice)).role).toBe("owner");
    } finally {
      await onPack("acme-test");
    }
    expect((await open(carol)).role).toBe("editor");

    // only the owner manages access
    await expect(call(carol, "share_deck", { deck_id: id, principal_type: "user", principal: "dave", role: "viewer" })).rejects.toThrow(/owner access needed/);
    await expect(call(carol, "list_shares", { deck_id: id })).rejects.toThrow(/owner access needed/);
    await expect(call(carol, "set_general_access", { deck_id: id, access: "anyone" })).rejects.toThrow(/owner access needed/);
    await expect(call(carol, "reset_link", { deck_id: id })).rejects.toThrow(/owner access needed/);
    await expect(call(alice, "share_deck", { deck_id: id, principal_type: "user", principal: "alice", role: "viewer" })).rejects.toThrow(/owner already/);
    expect(() => TOOLS.share_deck.input.parse({ deck_id: id, principal_type: "workspace", role: "viewer" })).toThrow();
    expect((await call(alice, "list_shares", { deck_id: id })).people).toMatchObject([
      { principal_type: "user", principal: "bob", role: "viewer", granted_by: "alice" },
      { principal_type: "team", principal: "ops", role: "editor" },
    ]);
  });

  it("lists own and shared decks with the role, over REST and MCP", async () => {
    expect((await call(alice, "list_decks")).decks).toMatchObject([{ id, role: "owner", owner: "alice" }]);
    const rest = await get("/api/decks", await idp.token("bob"));
    expect(rest.body.decks).toMatchObject([{ id, role: "editor", owner: "alice", title: "Quarterly review" }]);
    const client = await connect(app, dave);
    const r = await client.callTool({ name: "list_decks", arguments: {} });
    expect((r.structuredContent as Json).decks).toEqual([]);
    await client.close();
  });

  it("per-user URL tokens: work for their user, die with their access, never exceed it", async () => {
    await call(alice, "share_deck", { deck_id: id, principal_type: "user", principal: "dave", role: "viewer" });
    const daves = tokenOf((await open(dave)).preview_url);
    const data = await get(`/decks/${id}/data?t=${daves}`);
    expect(data.body).toMatchObject({ deck_id: id, role: "viewer" });
    expect(new URL(data.body.slides[0].image_url).searchParams.get("t")).toBe(decodeURIComponent(daves)); // passed on, not extended
    expect((await post(`/decks/${id}/comments?t=${daves}`, undefined, { slide_id: "cover", text: "x" })).status).toBe(403);
    expect((await get(`/decks/${id}/data?t=${daves}x`)).status).toBe(401);
    // the token is not the share link: it is never what list_shares gives out
    expect((await call(alice, "list_shares", { deck_id: id })).url).not.toContain("t=");

    const carols = tokenOf((await open(carol)).preview_url);
    expect((await get(`/decks/${id}/data?t=${carols}`)).body.role).toBe("editor");
    expect((await post(`/decks/${id}/comments?t=${carols}`, undefined, { slide_id: "cover", text: "ok" })).body.comment).toMatchObject({ author: "carol" });

    await call(alice, "unshare_deck", { deck_id: id, principal_type: "user", principal: "dave" });
    expect((await get(`/decks/${id}/data?t=${daves}`)).status).toBe(404);
    await call(alice, "unshare_deck", { deck_id: id, principal_type: "team", principal: "ops" });
    expect((await get(`/decks/${id}/data?t=${carols}`)).status).toBe(404);
    await call(alice, "share_deck", { deck_id: id, principal_type: "team", principal: "ops", role: "editor" });
  });

  it("admins cannot read a deck, but see who has access, make it private, reset its link and transfer it", async () => {
    const admin = await idp.token("root", ["/calque-admins"]);
    await expect(open(root)).rejects.toThrow(/no deck/);
    await expect(call(root, "export_pptx", { deck_id: id })).rejects.toThrow(/no deck/);
    await expect(call(root, "add_comment", { deck_id: id, slide_id: "cover", text: "x" })).rejects.toThrow(/no deck/);
    expect((await get(`/decks/${id}/data`, admin)).status).toBe(404);
    await expect(call(bob, "transfer_deck", { deck_id: id, to: "bob" })).rejects.toThrow(/owner access needed/);

    // who has access, never the link
    const seen = await call(root, "list_shares", { deck_id: id });
    expect(seen).toMatchObject({ owner: "alice", general: { access: "private" } });
    expect(seen.people.length).toBeGreaterThan(0);
    expect(seen).not.toHaveProperty("url");
    expect(JSON.stringify(seen)).not.toContain(key);
    expect((await get(`/api/admin/decks/${id}/access`, await idp.token("bob"))).status).toBe(403);
    const rest = await get(`/api/admin/decks/${id}/access`, admin);
    expect(rest.body).toMatchObject({ owner: "alice", general: { access: "private" } });
    expect(JSON.stringify(rest.body)).not.toContain(key);

    // incident response: make it private, reset the link
    await call(alice, "set_general_access", { deck_id: id, access: "anyone", role: "commenter" });
    expect((await viaLink()).status).toBe(200);
    await expect(call(root, "set_general_access", { deck_id: id, access: "workspace" })).rejects.toThrow(/only make it private/);
    expect((await post(`/api/admin/decks/${id}/private`, admin)).body).toMatchObject({ access: "private" });
    expect((await viaLink()).status).toBe(404);
    await call(alice, "set_general_access", { deck_id: id, access: "anyone", role: "viewer" });
    const reset = await call(root, "reset_link", { deck_id: id });
    expect(reset).not.toHaveProperty("url");
    expect((await viaLink()).status).toBe(404);
    key = keyOf((await call(alice, "list_shares", { deck_id: id })).url);
    expect((await viaLink()).status).toBe(200);
    expect((await post(`/api/admin/decks/${id}/reset-link`, admin)).body).toMatchObject({ reset: true });
    expect((await viaLink()).status).toBe(404);

    // transfer: the former owner keeps editor
    expect(await call(root, "transfer_deck", { deck_id: id, to: "dave" })).toMatchObject({ owner: "dave", previous_owner: "alice" });
    expect((await open(dave)).role).toBe("owner");
    expect((await open(alice)).role).toBe("editor");
    await expect(open(root)).rejects.toThrow(/no deck/);
    expect((await post(`/api/admin/decks/${id}/transfer`, admin, { to: "erin" })).body).toMatchObject({ owner: "erin", previous_owner: "dave" });

    const { rows } = await app.db.query<{ actor: string; action: string }>("select actor, action from audit where target_type = 'deck' and target_id = $1 order by id", [id]);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["share", "unshare", "access", "reset_link", "transfer"]));
    expect(rows.filter((r) => r.action === "transfer").map((r) => r.actor)).toEqual(["root", "root"]);
    expect(rows.filter((r) => r.action === "reset_link").map((r) => r.actor)).toEqual(["alice", "root", "root"]);
    expect(rows.filter((r) => r.action === "access" && r.actor === "root")).toHaveLength(1);
  });
});
