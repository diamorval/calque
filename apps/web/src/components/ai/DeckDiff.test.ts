import { describe, expect, it } from "vitest";
import { diffSpecs } from "./DeckDiff.tsx";

const clone = (values: Record<string, unknown>) => ({ kind: "clone", values });

describe("diffSpecs", () => {
  it("lists changed fields and shapes, added and removed slides, by slide", () => {
    const before = {
      slides: [
        { id: "a", message: "Cover", source: clone({ "2": "Q3 review", "3": ["one", "two"] }) },
        { id: "b", message: "Gone", title: "Old slide", source: clone({}) },
        { id: "c", message: "Chart", title: "Sales up", source: { kind: "chart", params: { series: [{ name: "x", values: [1, 2] }] } } },
      ],
    };
    const after = {
      slides: [
        { id: "a", message: "Cover", notes: "Say hi", source: clone({ "2": "Q3 review", "3": ["one", "three"] }) },
        { id: "c", message: "Chart", title: "Sales up", source: { kind: "chart", params: { series: [{ name: "x", values: [1, 3] }] } } },
        { id: "d", message: "New one", source: clone({}) },
      ],
    };
    expect(diffSpecs(before, after)).toEqual([
      { slide: 1, where: "notes", kind: "changed", before: "", after: "Say hi" },
      { slide: 1, where: 3, kind: "changed", before: "one · two", after: "one · three" },
      { slide: 2, where: "slide", kind: "removed", before: "Old slide" },
      { slide: 2, where: "content", kind: "changed", before: "chart · x · 1 · 2", after: "chart · x · 1 · 3" },
      { slide: 3, where: "slide", kind: "added", after: "New one" },
    ]);
    expect(diffSpecs(before, before)).toEqual([]);
  });
});
