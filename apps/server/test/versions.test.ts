import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Conflict } from "../src/decks.ts";
import type { App } from "../src/tools.ts";
import { acmeDeck, ENGINE_TIMEOUT, LOCAL, testApp } from "./helpers.ts";

describe("deck versions", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let id: string;
  beforeAll(async () => {
    app = await testApp();
    id = (await app.decks.create(LOCAL, acmeDeck(), "create")).deck_id;
  });
  afterAll(() => app.db.close());

  const title = async (v: number) => (await app.decks.spec(id, v)).slides.find((s) => s.id === "regions")?.title;

  it("every change is a version; undo and restore are new versions", async () => {
    const original = await title(1);
    const p = await app.decks.patch(LOCAL, id, [{ op: "set_field", slide: "regions", field: "title", value: "North leads" }], "retitle");
    expect(p.version).toBe(2);
    expect(await title(2)).toBe("North leads");

    const undo = await app.decks.restore(LOCAL, id);
    expect(undo.version).toBe(3);
    expect(await title(3)).toBe(original);
    await expect(app.decks.restore(LOCAL, id)).rejects.toThrow("nothing to undo");

    const back = await app.decks.restore(LOCAL, id, 2);
    expect(back.version).toBe(4);
    expect(await title(4)).toBe("North leads");
    expect((await app.decks.versions(id)).map((v) => v.note)).toEqual(["create", "retitle", "restore v1", "restore v2"]);
  });

  it("a patch from a stale version is refused", async () => {
    const deck = await app.decks.deck(LOCAL, id);
    const spec = await app.decks.spec(id, deck.head);
    await expect(app.decks.commit(LOCAL, id, deck.head - 1, spec, "stale")).rejects.toBeInstanceOf(Conflict);
  });

  it("an invalid patch stores nothing", async () => {
    const before = (await app.decks.deck(LOCAL, id)).head;
    await expect(app.decks.patch(LOCAL, id, [{ op: "delete_slide", slide: "nope" }], "bad")).rejects.toThrow(/nope/);
    expect((await app.decks.deck(LOCAL, id)).head).toBe(before);
  });
});

describe("concurrent patches", { timeout: ENGINE_TIMEOUT }, () => {
  it("are applied one after the other", async () => {
    const app = await testApp();
    const { deck_id } = await app.decks.create(LOCAL, acmeDeck(), "create");
    const set = (v: string) => app.decks.patch(LOCAL, deck_id, [{ op: "set_field", slide: "regions", field: "notes", value: v }], v);
    const [a, b] = await Promise.all([set("a"), set("b")]);
    expect([a.version, b.version]).toEqual([2, 3]);
    expect((await app.decks.spec(deck_id, 3)).slides.find((s) => s.id === "regions")?.notes).toBe("b");
    await app.db.close();
  });
});
