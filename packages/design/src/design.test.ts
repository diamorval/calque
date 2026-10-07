import { describe, expect, it } from "vitest";
import { designMd, importNamed, reconcile, resolve, type PackData, type TokenTree } from "./index.ts";

const hex = (n: string) => `#${n.repeat(3)}`; // built, not written: keeps fixtures brand-free

describe("dtcg", () => {
  it("resolves path aliases and rejects cycles", () => {
    const v = resolve({ c: { $type: "color", a: { $value: hex("ab") } }, r: { x: { $value: "{c.a}" } } });
    expect(v.get("r.x")).toBe(hex("ab"));
    expect(() => resolve({ a: { $value: "{b}" }, b: { $value: "{a}" } })).toThrow(/circular/);
  });

  it("imports name-aliased tokens into a DTCG tree, keeping only listed groups", () => {
    const source: TokenTree = {
      prim: { one: { name: "x-one", $type: "color", $value: hex("11") }, two: { name: "x-two", $type: "color", $value: "{x-one}" } },
      other: { skip: { name: "x-skip", $type: "color", $value: hex("22") } },
    };
    const out = importNamed(source, ["prim"], "color");
    expect(resolve(out).get("color.two")).toBe(hex("11"));
    expect(JSON.stringify(out)).not.toContain("skip");
    expect(() => importNamed({ ...source, prim: { a: { name: "a", $value: "{x-skip}" } } }, ["prim"], "color")).toThrow(/leaves/);
  });
});

function pack(themeColor: string, accepted = false): PackData {
  const tokens: TokenTree = {
    theme: { $type: "color", dk1: { $value: hex("11") }, font: { $type: "fontFamily", major: { $value: "Display" }, minor: { $value: "Body" } } },
    role: {
      color: { $type: "color", accent: { $value: "{theme.dk1}" } },
      font: { $type: "fontFamily", display: { $value: "Display" }, body: { $value: "Body" }, label: { $value: "Body" } },
      fontWeight: { display: { $value: 300 }, body: { $value: 400 }, label: { $value: 300 } },
      size: { $type: "dimension", title: { $value: "23pt" } },
      stroke: { hairline: { $value: "0.75pt" }, link: { $value: "1pt" }, emphasis: { $value: "1.5pt" } },
    },
  };
  return {
    dir: "/tmp/p",
    manifest: {
      id: "p", name: "P", version: "0.1.0", default_language: null, missing_value: { en: "[TO COMPLETE]" }, roles: {},
      grid: { margin_in: 0.2, columns: { "3": [0.2, 3.4, 6.6] }, title: { left_in: 0.3, top_in: 0.2, width_in: 6, height_in: 0.8 }, body_top_in: 1.5, footer_top_in: 5.3 },
      fonts: { fallback: { display: "serif", body: "sans-serif" } },
      lint: {},
      ...(accepted ? { reconciliation: [{ slot: "dk1", reason: "known" }] } : {}),
    },
    tokens,
    values: resolve(tokens),
    canvas: { width_in: 10, height_in: 5.62 },
    theme: { colors: { dk1: themeColor }, fonts: { major: "Display", minor: "Body" } },
    notes: { atmosphere: "Calm." },
  };
}

describe("reconcile", () => {
  it("reports nothing when the template matches the tokens", () => {
    expect(reconcile(pack("111111"))).toEqual([]);
  });
  it("lists a gap, and marks it arbitrated only when pack.yaml accepts it", () => {
    expect(reconcile(pack("222222"))).toEqual([{ slot: "dk1", template: "222222", tokens: "111111", arbitrated: null }]);
    expect(reconcile(pack("222222", true))[0]?.arbitrated).toBe("known");
  });
});

describe("designMd", () => {
  it("renders the 9 sections from tokens and manifest", () => {
    const md = designMd(pack("111111"));
    for (const h of ["Visual Theme", "Color Palette", "Typography", "Component", "Layout", "Depth", "Do's", "Canvas", "Agent Prompt"])
      expect(md).toContain(`## ${h}`);
    expect(md).toContain("`accent` | `#111111`");
    expect(md).toContain("[TO COMPLETE]");
  });
});
