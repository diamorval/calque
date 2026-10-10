import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonSchema } from "./json-schema.ts";
import { DeckSpec } from "./schema.ts";

const fixtures = join(import.meta.dirname, "../fixtures");
const cases = (kind: string) =>
  readdirSync(join(fixtures, kind))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => [f.replace(/\.json$/, ""), join(fixtures, kind, f)] as const);
const load = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

describe("valid fixtures", () => {
  it.each(cases("valid"))("%s parses", (_, path) => {
    expect(() => DeckSpec.parse(load(path))).not.toThrow();
  });
});

describe("invalid-schema fixtures", () => {
  it.each(cases("invalid-schema"))("%s is rejected", (_, path) => {
    const r = DeckSpec.safeParse(load(path));
    expect(r.success).toBe(false);
    const expected = readFileSync(path.replace(/\.json$/, ".expect.txt"), "utf8").trim();
    expect(String(r.error && z.prettifyError(r.error))).toContain(expected);
  });
});

describe("invalid-rules fixtures pass the schema (the engine's rules reject them)", () => {
  it.each(cases("invalid-rules").filter(([n]) => n !== "clone-without-role-or-slide"))("%s parses", (_, path) => {
    expect(() => DeckSpec.parse(load(path))).not.toThrow();
  });
});

it("Zod rejects a clone with neither role nor slide (JSON Schema cannot, the engine's rules do)", () => {
  const r = DeckSpec.safeParse(load(join(fixtures, "invalid-rules/clone-without-role-or-slide.json")));
  expect(r.success).toBe(false);
  expect(String(r.error && z.prettifyError(r.error))).toContain("clone needs a role or a slide");
});

it("committed deckspec.schema.json matches the Zod source", () => {
  const committed = JSON.parse(readFileSync(join(import.meta.dirname, "../deckspec.schema.json"), "utf8"));
  expect(committed).toEqual(jsonSchema());
});

it("charts and compositions carry an optional source line, diagrams do not", () => {
  const slide = (source: unknown) => ({ id: "s", message: "m", message_type: "quantity", form: "bar", title: "t", source });
  const deck = (source: unknown) => ({ pack_id: "p", language: "fr", title: "T", slides: [slide(source)] });
  const chart = { categories: ["a"], series: [{ name: "n", values: [1] }] };
  const ok = [
    { kind: "chart", type: "bar", params: { ...chart, source: "Source : CRM, sept. 2026" } },
    { kind: "composition", id: "comparison_table", params: { header: ["a", "b"], rows: [["1", "2"]], source: "Source : devis" } },
  ];
  for (const s of ok) expect(DeckSpec.safeParse(deck(s)).success).toBe(true);
  expect(DeckSpec.safeParse(deck({ ...ok[0], params: { ...chart, source: "" } })).success).toBe(false);
  const diagram = { kind: "diagram", id: "flow", params: { steps: ["a", "b"], source: "x" } };
  expect(DeckSpec.safeParse(deck(diagram)).success).toBe(false);
});
