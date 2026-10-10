import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO } from "../src/engine.ts";
import { createHttp } from "../src/http.ts";
import type { User } from "../src/packs.ts";
import { TOOLS, type App } from "../src/tools.ts";
import { fakeOidc } from "./fakes.ts";
import { acmeDeck, ENGINE_TIMEOUT, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const alice: User = { id: "alice", name: "Alice Martin", teams: ["sales"] };
const bob: User = { id: "bob", name: "Bob Durand", teams: ["ops"] };
const erin: User = { id: "erin", teams: ["ops"] }; // no name claim
const mona: User = { id: "mona", name: "Mona Lisa", teams: ["marketing"] }; // owns the approval pack
const root: User = { id: "root", teams: ["calque-admins"] };

describe("collaboration and review", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let id = "";
  let gated = ""; // a deck on a pack with approval on

  const call = (user: User, name: keyof typeof TOOLS, args: Json = {}): Promise<Json> => {
    const t = TOOLS[name];
    return t.run(app, user, t.input.parse(args) as never);
  };
  const comment = (user: User, args: Json) => call(user, "add_comment", { deck_id: id, ...args });
  const audit = async (deck: string, action: string) =>
    (await app.db.query<Json>("select actor, detail from deck_audit where deck_id = $1 and action = $2 order by id", [deck, action])).rows;

  beforeAll(async () => {
    app = await testApp();
    id = (await call(alice, "create_deck", { deck: acmeDeck() })).deck_id;
    await call(alice, "share_deck", { deck_id: id, principal_type: "user", principal: "bob", role: "commenter" });
    await call(alice, "share_deck", { deck_id: id, principal_type: "user", principal: "erin", role: "editor" });

    // the same pack with `approval: true`, owned by mona
    const dir = join(app.data, "acme-approval");
    cpSync(join(REPO, "packs/acme-test"), dir, { recursive: true });
    const yaml = readFileSync(join(dir, "pack.yaml"), "utf8").replace(/^id: acme-test$/m, "id: acme-approval");
    writeFileSync(join(dir, "pack.yaml"), `${yaml}\napproval: true\n`);
    await app.db.query("insert into packs (id, dir, visibility, owner) values ('acme-approval', $1, 'workspace', 'mona')", [dir]);
    gated = (await call(alice, "create_deck", { deck: { ...acmeDeck(), pack_id: "acme-approval" } })).deck_id;
    await call(alice, "share_deck", { deck_id: gated, principal_type: "user", principal: "mona", role: "commenter" });
    await call(alice, "share_deck", { deck_id: gated, principal_type: "user", principal: "erin", role: "editor" });
  });
  afterAll(() => app.db.close());

  it("threads: a reply joins its comment's thread, on its slide and shape, with the author's name", async () => {
    const first = (await comment(bob, { slide_id: "regions", shape_id: 5, text: "Sort the bars" })).comment;
    expect(first).toMatchObject({ author: "bob", author_name: "Bob Durand", parent_id: null, status: "open" });
    const reply = (await comment(alice, { parent_id: first.id, text: "By growth or by size?" })).comment;
    expect(reply).toMatchObject({ slide_id: "regions", shape_id: 5, parent_id: first.id, author_name: "Alice Martin" });
    await comment(bob, { parent_id: first.id, text: "By growth" });
    await expect(comment(bob, { parent_id: reply.id, text: "nested" })).rejects.toThrow(/one level deep/);
    await expect(comment(bob, { parent_id: 9999, text: "lost" })).rejects.toThrow(/no comment 9999/);
    await expect(comment(bob, { text: "where?" })).rejects.toThrow(/slide_id/);

    const { comments } = await call(alice, "list_comments", { deck_id: id });
    expect(comments).toHaveLength(1); // replies sit in their thread, not as comments of their own
    expect(comments[0]).toMatchObject({ id: first.id, status: "open" });
    expect(comments[0].replies.map((r: Json) => r.text)).toEqual(["By growth or by size?", "By growth"]);
  });

  it("resolves and reopens threads one by one; a commenter only their own", async () => {
    const mine = (await comment(bob, { slide_id: "cover", text: "Shorter title" })).comment;
    const hers = (await comment(alice, { slide_id: "cover", text: "Add the date" })).comment;
    await expect(call(bob, "resolve_comments", { deck_id: id, comment_ids: [hers.id] })).rejects.toThrow(/editor access needed/);
    expect(await call(bob, "resolve_comments", { deck_id: id, comment_ids: [mine.id] })).toEqual({ status: "resolved", comment_ids: [mine.id] });
    expect(await call(erin, "resolve_comments", { deck_id: id, comment_ids: [hers.id] })).toMatchObject({ comment_ids: [hers.id] });

    const open = (await call(alice, "list_comments", { deck_id: id })).comments.map((c: Json) => c.id);
    expect(open).not.toContain(mine.id);
    const all = (await call(alice, "list_comments", { deck_id: id, status: "all" })).comments;
    expect(all.find((c: Json) => c.id === mine.id)).toMatchObject({ status: "resolved" });

    await call(alice, "resolve_comments", { deck_id: id, comment_ids: [mine.id], status: "open" });
    const deck = await call(alice, "open_deck", { deck_id: id, render: false });
    expect(deck.open_comments.map((c: Json) => c.id)).toContain(mine.id);
    expect(deck.resolved_comments.map((c: Json) => c.id)).toEqual([hers.id]);
  });

  it("stores the display name of each version's author, the id stays the id", async () => {
    await call(erin, "patch_deck", { deck_id: id, ops: [{ op: "set", slide: "cover", shape_id: 2, value: "Growth where we invested" }] });
    const versions = (await call(alice, "open_deck", { deck_id: id, render: false })).versions;
    expect(versions[0]).toMatchObject({ author: "alice", author_name: "Alice Martin" });
    expect(versions.at(-1)).toMatchObject({ author: "erin", author_name: null }); // no name claim: the UI shows the id
  });

  it("takes the name from a bearer token's `name` claim", async () => {
    const idp = await fakeOidc();
    try {
      const http = createHttp(app, { issuer: idp.issuer, audience: "calque", resource: new URL("/mcp", app.publicUrl), teamsClaim: "groups" });
      const res = await http.request("/api/me", { headers: { authorization: `Bearer ${await idp.token("bob")}` } });
      expect(await res.json()).toMatchObject({ id: "bob", name: "Bob Durand" });
    } finally {
      idp.server.close();
    }
  });

  it("approval is off unless the pack turns it on", async () => {
    expect((await call(alice, "open_deck", { deck_id: id, render: false })).approval).toEqual({ enabled: false });
    await expect(call(alice, "set_approval", { deck_id: id, status: "in_review" })).rejects.toThrow(/approval is off/);
  });

  it("approval: an editor requests it, the pack owner or an admin approves, a new version sends it back to draft", async () => {
    const as = async (u: User) => (await call(u, "open_deck", { deck_id: gated, render: false })).approval;
    expect(await as(alice)).toEqual({ enabled: true, status: "draft", can_request: true, can_withdraw: false, can_approve: false });
    await expect(call(mona, "set_approval", { deck_id: gated, status: "in_review" })).rejects.toThrow(/an editor requests/);
    await expect(call(alice, "set_approval", { deck_id: gated, status: "approved" })).rejects.toThrow(/pack owner or an admin/);

    expect(await call(erin, "set_approval", { deck_id: gated, status: "in_review", note: "for the board" })).toMatchObject({ approval: "in_review", from: "draft" });
    expect(await as(mona)).toMatchObject({ status: "in_review", can_approve: true, can_request: false });
    await expect(call(alice, "set_approval", { deck_id: gated, status: "approved" })).rejects.toThrow(/pack owner or an admin/);
    await expect(call(root, "set_approval", { deck_id: gated, status: "approved" })).rejects.toThrow(/no deck/); // an admin approves what they can read

    // changes requested, then approved
    await call(mona, "set_approval", { deck_id: gated, status: "draft", note: "fix slide 2" });
    await call(alice, "set_approval", { deck_id: gated, status: "in_review" });
    expect(await call(mona, "set_approval", { deck_id: gated, status: "approved" })).toMatchObject({ approval: "approved" });
    expect((await audit(gated, "approval")).map((r) => [r.actor, r.detail.to])).toEqual([
      ["erin", "in_review"],
      ["mona", "draft"],
      ["alice", "in_review"],
      ["mona", "approved"],
    ]);

    // approval is of a version: a change sends the deck back to draft; exporting never needed it
    await call(alice, "patch_deck", { deck_id: gated, ops: [{ op: "set", slide: "cover", shape_id: 2, value: "Growth" }] });
    expect(await as(alice)).toMatchObject({ status: "draft", can_request: true });
  });

  it("export gate: a version with lint ERRORs still exports, the export and its reason are recorded", async () => {
    const clean = await call(bob, "export_pptx", { deck_id: id });
    expect(clean).toMatchObject({ lint_errors: 0 });
    expect(clean.warning).toBeUndefined();
    expect(await audit(id, "export_with_errors")).toEqual([]);

    // a template placeholder left on the cover: a lint ERROR
    await call(alice, "patch_deck", { deck_id: id, ops: [{ op: "set", slide: "cover", shape_id: 2, value: "Presentation title" }] });
    const blind = await call(bob, "export_pptx", { deck_id: id });
    expect(blind.download_url).toContain(`/decks/${id}/deck.pptx`);
    expect(blind.lint_errors).toBeGreaterThan(0);
    expect(blind.warning).toMatch(/reason/);
    const told = await call(alice, "export_pptx", { deck_id: id, reason: "client draft tonight" });
    expect(told.warning).toBeUndefined();

    const rows = await audit(id, "export_with_errors");
    expect(rows.map((r) => [r.actor, r.detail.reason])).toEqual([
      ["bob", null],
      ["alice", "client draft tonight"],
    ]);
    expect(rows[1]?.detail).toMatchObject({ version: told.version, errors: told.lint_errors });
  });
});
