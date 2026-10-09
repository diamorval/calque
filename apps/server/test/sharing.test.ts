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

  beforeAll(async () => {
    idp = await fakeOidc();
    app = await testApp();
    http = createHttp(app, { issuer: idp.issuer, audience: "calque", resource: new URL("/mcp", app.publicUrl), teamsClaim: "groups" });
    id = (await call(alice, "create_deck", { deck: acmeDeck() })).deck_id;
  });
  afterAll(async () => {
    idp.server.close();
    await app.db.close();
  });

  it("shares with a user: viewer reads but neither comments nor edits, commenter comments", async () => {
    await expect(open(bob)).rejects.toThrow(/no deck/);
    expect(await call(alice, "share_deck", { deck_id: id, principal_type: "user", principal: "bob", role: "viewer" })).toMatchObject({ role: "viewer" });

    expect(await open(bob)).toMatchObject({ deck_id: id, role: "viewer" });
    expect((await call(bob, "export_pptx", { deck_id: id })).download_url).toContain(`/decks/${id}/deck.pptx`);
    await expect(comment(bob)).rejects.toThrow(/commenter access needed/);
    await expect(call(bob, "patch_deck", { deck_id: id, ops: [{ op: "set", slide: "cover", shape_id: 2, value: "x" }] })).rejects.toThrow(/editor access needed/);
    await expect(open(carol)).rejects.toThrow(/no deck/);

    await call(alice, "share_deck", { deck_id: id, principal_type: "user", principal: "bob", role: "commenter" });
    expect((await comment(bob)).comment).toMatchObject({ author: "bob" });
    await expect(call(bob, "restore_version", { deck_id: id })).rejects.toThrow(/editor access needed/);
  });

  it("shares with a team and the workspace; the best role wins; unshare takes it back", async () => {
    await call(alice, "share_deck", { deck_id: id, principal_type: "team", principal: "ops", role: "editor" });
    expect((await open(carol)).role).toBe("editor");
    expect((await open(bob)).role).toBe("editor"); // user commenter, team editor
    const patched = await call(carol, "patch_deck", { deck_id: id, ops: [{ op: "set", slide: "cover", shape_id: 2, value: "Edited by Carol" }] });
    expect(patched.version).toBe(2);
    expect((await app.decks.versions(id)).at(-1)).toMatchObject({ author: "carol" });

    await expect(open(dave)).rejects.toThrow(/no deck/);
    await call(alice, "share_deck", { deck_id: id, principal_type: "workspace", role: "viewer" });
    expect((await open(dave)).role).toBe("viewer");
    await call(alice, "unshare_deck", { deck_id: id, principal_type: "workspace" });
    await expect(open(dave)).rejects.toThrow(/no deck/);

    // only the owner manages shares
    await expect(call(carol, "share_deck", { deck_id: id, principal_type: "user", principal: "dave", role: "viewer" })).rejects.toThrow(/owner access needed/);
    await expect(call(carol, "list_shares", { deck_id: id })).rejects.toThrow(/owner access needed/);
    await expect(call(alice, "share_deck", { deck_id: id, principal_type: "user", principal: "alice", role: "viewer" })).rejects.toThrow(/owner already/);
    const s = await call(alice, "list_shares", { deck_id: id });
    expect(s.shares).toMatchObject([
      { principal_type: "user", principal: "bob", role: "commenter", granted_by: "alice" },
      { principal_type: "team", principal: "ops", role: "editor" },
    ]);
  });

  it("lists own and shared decks with the role, over REST and MCP", async () => {
    const mine = await call(alice, "list_decks");
    expect(mine.decks).toMatchObject([{ id, role: "owner", owner: "alice" }]);
    const rest = await get("/api/decks", await idp.token("bob"));
    expect(rest.body.decks).toMatchObject([{ id, role: "editor", owner: "alice", title: "Quarterly review" }]);
    const client = await connect(app, dave);
    const r = await client.callTool({ name: "list_decks", arguments: {} });
    expect((r.structuredContent as Json).decks).toEqual([]);
    await client.close();
  });

  it("counts a share only while the user sees the deck's pack", async () => {
    await app.db.query("insert into packs (id, dir, visibility, teams, owner) values ('sales-only', $1, 'team', '[\"sales\"]', 'alice')", [`${REPO}/packs/acme-test`]);
    await app.db.query("update decks set pack_id = 'sales-only' where id = $1", [id]);
    try {
      await expect(open(carol)).rejects.toThrow(/no deck/);
      expect((await call(carol, "list_decks")).decks).toEqual([]);
      expect((await open(alice)).role).toBe("owner");
    } finally {
      await app.db.query("update decks set pack_id = 'acme-test' where id = $1", [id]);
    }
    expect((await open(carol)).role).toBe("editor");
  });

  it("guest links: stored, role-limited, refused once revoked or expired", async () => {
    const link = await call(alice, "create_link", { deck_id: id, role: "viewer", label: "board" });
    expect(link).toMatchObject({ role: "viewer", label: "board", auto: false });
    const url = new URL(link.url);
    const t = encodeURIComponent(url.searchParams.get("t") ?? "");
    const data = await get(`/decks/${id}/data?t=${t}`);
    expect(data.body).toMatchObject({ deck_id: id, role: "viewer" });
    const post = (q: string) =>
      get(`/decks/${id}/comments?t=${q}`, undefined, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slide_id: "cover", text: "x" }) });
    expect((await post(t)).status).toBe(403);
    // the owner's automatic preview link comments
    const auto = new URL((await open(alice)).preview_url).searchParams.get("t") ?? "";
    expect((await post(encodeURIComponent(auto))).status).toBe(200);
    expect(new URL((await open(alice)).preview_url).searchParams.get("t")).toBe(auto); // reused: a stable URL

    expect((await call(alice, "list_shares", { deck_id: id })).links.map((l: Json) => l.id)).toContain(link.id);
    await call(alice, "revoke_link", { deck_id: id, link_id: link.id });
    expect((await get(`/decks/${id}/data?t=${t}`)).status).toBe(401);
    expect((await call(alice, "list_shares", { deck_id: id })).links.map((l: Json) => l.id)).not.toContain(link.id);

    const short = await call(alice, "create_link", { deck_id: id, role: "commenter" });
    const st = encodeURIComponent(new URL(short.url).searchParams.get("t") ?? "");
    expect((await get(`/decks/${id}/data?t=${st}`)).status).toBe(200);
    await app.db.query("update deck_links set expires_at = now() - interval '1 minute' where id = $1", [short.id]);
    expect((await get(`/decks/${id}/data?t=${st}`)).status).toBe(401);

    // a link is worth no more than its minter's role: carol's (editor) dies with her share
    const carols = new URL((await open(carol)).preview_url).searchParams.get("t") ?? "";
    expect((await get(`/decks/${id}/data?t=${encodeURIComponent(carols)}`)).status).toBe(200);
    await call(alice, "unshare_deck", { deck_id: id, principal_type: "team", principal: "ops" });
    expect((await get(`/decks/${id}/data?t=${encodeURIComponent(carols)}`)).status).toBe(404);
  });

  it("admins cannot read a deck, but transfer it and revoke its links", async () => {
    await expect(open(root)).rejects.toThrow(/no deck/);
    await expect(call(root, "list_shares", { deck_id: id })).rejects.toThrow(/no deck/);
    await expect(call(root, "export_pptx", { deck_id: id })).rejects.toThrow(/no deck/);
    await expect(call(bob, "transfer_deck", { deck_id: id, to: "bob" })).rejects.toThrow(/owner access needed/);

    // admin routes: links without their URL; refused to non-admins
    expect((await get(`/api/admin/decks/${id}/links`, await idp.token("bob"))).status).toBe(403);
    const links = (await get(`/api/admin/decks/${id}/links`, await idp.token("alice"))).body.links as Json[];
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).not.toHaveProperty("url");
    expect(links[0]).not.toHaveProperty("teams");
    const link = await call(alice, "create_link", { deck_id: id });
    await call(root, "revoke_link", { deck_id: id, link_id: link.id });
    expect((await get(`/decks/${id}/data?t=${encodeURIComponent(new URL(link.url).searchParams.get("t") ?? "")}`)).status).toBe(401);

    expect(await call(root, "transfer_deck", { deck_id: id, to: "dave" })).toMatchObject({ owner: "dave", previous_owner: "alice" });
    expect((await open(dave)).role).toBe("owner");
    expect((await open(alice)).role).toBe("editor");
    await expect(open(root)).rejects.toThrow(/no deck/);
    const transferred = await get(`/api/admin/decks/${id}/transfer`, await idp.token("alice"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "erin" }),
    });
    expect(transferred.body).toMatchObject({ owner: "erin", previous_owner: "dave" });

    const { rows } = await app.db.query<{ actor: string; action: string }>("select actor, action from deck_audit where deck_id = $1 order by id", [id]);
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["share", "unshare", "link", "revoke_link", "transfer"]),
    );
    expect(rows.filter((r) => r.action === "transfer").map((r) => r.actor)).toEqual(["root", "alice"]);
  });
});
