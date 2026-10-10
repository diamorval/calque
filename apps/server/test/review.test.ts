import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO } from "../src/engine.ts";
import { toolNamed, type App } from "../src/tools.ts";
import { acmeDeck, ENGINE_TIMEOUT, LOCAL, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const run = (app: App, name: string, args: Json) => toolNamed(name)?.run(app, LOCAL, toolNamed(name)?.input.parse(args) as never) as Promise<Json>;

describe("review_deck", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let id: string;
  beforeAll(async () => {
    app = await testApp();
    const clean = await run(app, "create_deck", { deck: acmeDeck() });
    const src = (await run(app, "export_pptx", { deck_id: clean.deck_id })).path;
    const bad = join(app.data, "defects.pptx");
    // the engine's own fixture: ten safe-fixable defects (engine/tests/test_fix.py)
    execFileSync("uv", ["run", "--quiet", "python", "-c",
      "import sys; from calque_engine.pack import load_pack; from tests.test_fix import plant; " +
      "plant(sys.argv[1], load_pack(sys.argv[2]), sys.argv[3])", src, join(REPO, "packs/acme-test"), bad],
      { cwd: join(REPO, "engine") });
    id = (await run(app, "import_pptx", { file: { base64: readFileSync(bad).toString("base64") }, pack_id: "acme-test", language: "en" })).deck_id;
  });
  afterAll(() => app.db.close());

  it("reports the ten planted defects as safe fixes, without touching the deck", async () => {
    const r = await run(app, "review_deck", { deck_id: id });
    expect(r.report.ERROR).toHaveLength(10);
    expect(r.report.safe_fixes.map((f: Json) => f.check).sort()).toEqual(
      ["font", "font", "font", "nesting", "off-canvas", "off-canvas", "palette", "palette", "run-order", "theme"],
    );
    expect(r.applied).toEqual([]);
    expect(r.visual_checklist).toContain("overflow or clipping");
    expect(r.slides[0].image_url).toMatch(/slides\/1\.png/);
    expect((await app.decks.deck(LOCAL, id, "viewer")).head).toBe(1);
  });

  it("applies them on approval: a new version with 0 lint errors", async () => {
    const r = await run(app, "review_deck", { deck_id: id, apply_safe_fixes: true });
    expect(r.applied.length).toBeGreaterThanOrEqual(10);
    expect(r.after).toEqual({ version: 2, errors: [] });
    expect((await run(app, "lint_deck", { deck_id: id })).errors).toBe(0);
    expect((await run(app, "lint_deck", { deck_id: id, version: 1 })).errors).toBe(10); // history kept
  });
});
