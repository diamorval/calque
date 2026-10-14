import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DesignPatchOp, DesignSpec } from "./design.ts";
import { designJsonSchema } from "./json-schema.ts";

const fixtures = join(import.meta.dirname, "../fixtures/design");
const cases = (kind: string) =>
  readdirSync(join(fixtures, kind))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => [f.replace(/\.json$/, ""), join(fixtures, kind, f)] as const);
const load = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

describe("valid design fixtures", () => {
  it.each(cases("valid"))("%s parses", (_, path) => {
    expect(() => DesignSpec.parse(load(path))).not.toThrow();
  });
});

describe("invalid design fixtures", () => {
  it.each(cases("invalid"))("%s is rejected", (_, path) => {
    const r = DesignSpec.safeParse(load(path));
    expect(r.success).toBe(false);
    const expected = readFileSync(path.replace(/\.json$/, ".expect.txt"), "utf8").trim();
    expect(String(r.error && z.prettifyError(r.error))).toContain(expected);
  });
});

it("committed designspec.schema.json matches the Zod source", () => {
  const committed = JSON.parse(readFileSync(join(import.meta.dirname, "../designspec.schema.json"), "utf8"));
  expect(committed).toEqual(designJsonSchema());
});

it("frames nest to any depth and children default to empty", () => {
  const leaf = { type: "frame", id: "c" };
  const spec = DesignSpec.parse({
    pack_id: "p",
    language: "en",
    title: "T",
    artboards: [{ id: "a", format: "story", children: [{ type: "frame", id: "a1", children: [{ type: "frame", id: "b", children: [leaf] }] }] }],
  });
  const a1 = spec.artboards[0]?.children[0];
  expect(a1?.type === "frame" && a1.children[0]?.type === "frame" && a1.children[0].children[0]).toEqual({ ...leaf, children: [] });
});

it("patch ops parse", () => {
  const ops = [
    { op: "set_node", artboard: "a", node_id: "t", props: { text: "x" } },
    { op: "adapt_artboard", artboard: "a", id: "a2", format: "story" },
    { op: "set_component", name: "cta", component: null },
    { op: "set_field", field: "mode", value: "dark" },
  ];
  for (const op of ops) expect(DesignPatchOp.safeParse(op).success).toBe(true);
  expect(DesignPatchOp.safeParse({ op: "set_field", field: "pack_id", value: "x" }).success).toBe(false);
});
