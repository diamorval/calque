import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO } from "../src/engine.ts";
import type { User } from "../src/packs.ts";
import { toolNamed, type App } from "../src/tools.ts";
import { acmeDeck, ENGINE_TIMEOUT, LOCAL, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const run = (app: App, name: string, args: Json, user: User = LOCAL) =>
  toolNamed(name)?.run(app, user, toolNamed(name)?.input.parse(args) as never) as Promise<Json>;

// What a client does in PowerPoint: new chart data on "regions", a renamed step on "process".
const EDIT = `
import sys
from pptx import Presentation
from pptx.chart.data import CategoryChartData
prs = Presentation(sys.argv[1])
for sh in prs.slides[2].shapes:
    if sh.has_chart:
        d = CategoryChartData(); d.categories = ["West", "East", "South", "North"]
        d.add_series("Growth", [4, 5, 7, 21]); sh.chart.replace_data(d)
for sh in prs.slides[3].shapes:
    if sh.has_text_frame:
        for p in sh.text_frame.paragraphs:
            if p.text == "Qualify": p.runs[0].text = "Qualify fast"
prs.save(sys.argv[2])
`;

const slide = (spec: Json, id: string) => spec.slides.find((s: Json) => s.id === id);

describe("PowerPoint round trip", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let id: string;
  beforeAll(async () => {
    app = await testApp();
    id = (await run(app, "create_deck", { deck: acmeDeck() })).deck_id;
  });
  afterAll(() => app.db.close());

  it("re-importing an edited export is a new version of the same deck, charts still charts", async () => {
    await run(app, "add_comment", { deck_id: id, slide_id: "regions", text: "Update the numbers" });
    const src = (await run(app, "export_pptx", { deck_id: id })).path;
    const edited = join(app.data, "edited.pptx");
    execFileSync("uv", ["run", "--quiet", "python", "-c", EDIT, src, edited], { cwd: join(REPO, "engine") });

    const r = await run(app, "import_pptx", { deck_id: id, file: { path: edited } });
    expect(r.deck_id).toBe(id);
    expect(r.version).toBe(2);
    expect(r.import.drawn).toEqual(["regions", "process", "mix", "plan"]);
    expect(r.import.demoted).toEqual([]);
    const spec = await app.decks.spec(id, 2);
    expect(slide(spec, "regions").source.params.series[0].values).toEqual([21, 7, 5, 4]);
    expect(slide(spec, "process").source.params.steps[1]).toBe("Qualify fast");
    expect(spec.base).toMatch(/^base-v2-/);

    // history and comments kept, and set_params still applies to the chart
    expect((await app.decks.versions(id)).map((v) => v.note)).toEqual(["create", "re-import from PowerPoint"]);
    expect((await run(app, "list_comments", { deck_id: id })).comments.map((c: Json) => c.slide_id)).toEqual(["regions"]);
    const p = await run(app, "patch_deck", { deck_id: id, ops: [{ op: "set_params", slide: "regions", params: { highlight: 1 } }] });
    expect(p.version).toBe(3);
    expect((await run(app, "lint_deck", { deck_id: id })).version).toBe(3);
    // older versions still build on their own files
    expect((await run(app, "export_pptx", { deck_id: id, version: 1 })).version).toBe(1);
  });

  it("drawn slides can be added to an imported deck", async () => {
    const plain = join(REPO, "packs/acme-test/template.pptx");
    const imp = await run(app, "import_pptx", { file: { path: plain }, pack_id: "acme-test", language: "en" });
    const chart = slide(acmeDeck(), "regions");
    const r = await run(app, "add_slides", { deck_id: imp.deck_id, slides: [chart], at: 1 });
    expect(r.version).toBe(2);
    expect(r.slides[1]).toBe("regions");
  });

  it("copy_slides copies drawn, template and imported slides into another deck", async () => {
    const target = (await run(app, "create_deck", { deck: acmeDeck() })).deck_id;
    const r = await run(app, "copy_slides", { from_deck: id, slides: ["regions", "d1", "cover"], deck_id: target, at: 1 });
    expect(r.copied).toEqual({ regions: "regions-copy", d1: "d1-copy", cover: "cover-copy" });
    const spec = await app.decks.spec(target, r.version);
    expect(spec.slides.slice(0, 4).map((s: Json) => s.id)).toEqual(["cover", "regions-copy", "d1-copy", "cover-copy"]);
    // "regions" was re-imported, so it is drawn: it stays a chart in the target; "cover" was an
    // imported clone, grafted into the target's own base file
    expect(slide(spec, "regions-copy").source.kind).toBe("chart");
    expect(slide(spec, "cover-copy").source.from).toBe("base");
    expect(spec.base).toMatch(/^base-v2-/);
    expect((await run(app, "export_pptx", { deck_id: target })).version).toBe(2);

    // copying again renames again; the source deck is untouched
    const again = await run(app, "copy_slides", { from_deck: id, slides: ["regions"], deck_id: target });
    expect(again.copied).toEqual({ regions: "regions-copy2" });
    expect((await app.decks.deck(LOCAL, id, "viewer")).head).toBe(3);
  });

  it("copy_slides needs view access on the source and refuses unknown slides", async () => {
    const bob: User = { id: "bob", teams: [] };
    const mine = (await run(app, "create_deck", { deck: acmeDeck() }, bob)).deck_id;
    await expect(run(app, "copy_slides", { from_deck: id, slides: ["regions"], deck_id: mine }, bob)).rejects.toThrow(/no deck/);
    await expect(run(app, "copy_slides", { from_deck: mine, slides: ["nope"], deck_id: mine }, bob)).rejects.toThrow(/no slide "nope"/);
  });
});
