import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHttp } from "../src/http.ts";
import type { App } from "../src/tools.ts";
import { acmeDeck, ENGINE_TIMEOUT, LOCAL, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A DeckSpec only reaches files of its own deck, the uploads and its pack. */
describe("file access through a DeckSpec", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let http: ReturnType<typeof createHttp>;
  let other: string;
  const call = async (name: string, body: unknown) => {
    const res = await http.request(`/api/tools/${name}`, { method: "POST", body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const withImage = (ref: string) => {
    const deck = acmeDeck();
    (deck.slides[0]?.source as { values: Record<string, unknown> }).values["2"] = { image: ref };
    return deck;
  };

  beforeAll(async () => {
    app = await testApp();
    http = createHttp(app);
    other = (await app.decks.create(LOCAL, acmeDeck(), "create")).deck_id;
  });
  afterAll(() => app.db.close());

  it("refuses a base outside the deck's folder", async () => {
    const r = await call("create_deck", { deck: { ...acmeDeck(), base: `../${other}/v1.pptx` } });
    expect(r.status).toBe(422);
    // a spec that skipped the schema (stored, or returned by the engine) is still contained
    const { deck_id } = await app.decks.create(LOCAL, acmeDeck(), "create");
    const spec = { ...acmeDeck(), base: `../${other}/v1.pptx` };
    await expect(app.decks.commit(LOCAL, deck_id, 1, spec, "x")).rejects.toThrow(/not a file of this deck/);
    expect(() => app.decks.basePath(deck_id, "base.pptx")).not.toThrow();
  });

  it("refuses images outside the deck, uploads and pack folders", async () => {
    for (const ref of ["/etc/hostname", "../../../../../../etc/hostname", `../${other}/v1.pptx`]) {
      const r = await call("create_deck", { deck: withImage(ref) });
      expect(r.status).toBe(422);
      expect(r.body.message).toMatch(/relative path/);
    }
    // a file of the pack is found (then refused as it is no picture), a missing one is not
    expect((await call("create_deck", { deck: withImage("pack.yaml") })).body.message).toMatch(/holds no image/);
    expect((await call("create_deck", { deck: withImage("nope.png") })).body.message).toMatch(/not found/);
  });

  it("keeps an engine crash's traceback in the server log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call("import_pptx", { file: { base64: Buffer.from("not a pptx").toString("base64") }, pack_id: "acme-test", language: "en" });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("engine_crash");
    expect(JSON.stringify(r.body)).not.toMatch(/Traceback|File "/);
    expect(log.mock.calls.flat().join("\n")).toMatch(/Traceback/);
    log.mockRestore();
  });
});
