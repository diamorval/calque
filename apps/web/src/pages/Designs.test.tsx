// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n.ts";
import { DesignEditor, Designs } from "./Designs.tsx";

type Json = Record<string, unknown>;

const finding = (severity: string, artboard: string | null, node: string | null, check: string, message: string) => ({ severity, artboard, node, check, message });
const DESIGN = {
  design_id: "g1",
  title: "Launch campaign",
  pack_id: "acme-test",
  version: 2,
  head: 2,
  artboards: [
    { id: "post", format: "social_square", width: 1080, height: 1080, mode: null },
    { id: "banner", format: "leaderboard", width: 728, height: 90, mode: "dark" },
  ],
  errors: [finding("ERROR", "banner", "cta__label", "contrast", "accent on background: 2.3:1")],
  warnings: [finding("WARN", "post", "headline", "safe_area", "text inside the safe margin")],
  spec: {},
};
const FORMATS = {
  formats: [
    { id: "social_square", label: "Social post 1:1", width: 1080, height: 1080 },
    { id: "story", label: "Story / reel 9:16", width: 1080, height: 1920 },
    { id: "leaderboard", label: "Display ad 728x90", width: 728, height: 90 },
  ],
  modes: ["dark"],
};

let calls: { name: string; args: Json }[];
beforeEach(() => {
  setLang("en");
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const name = url.replace("/api/tools/", "");
    calls.push({ name, args: JSON.parse(String(init?.body ?? "{}")) });
    const body: Json =
      name === "list_designs"
        ? { designs: [{ design_id: "g1", title: "Launch campaign", pack_id: "acme-test", version: 2, cover: "post", artboards: 2, updated_at: new Date().toISOString() }] }
        : name === "list_formats"
          ? FORMATS
          : name === "export_design"
            ? { filename: "LaunchCampaignPost.tsx", code: "export default function LaunchCampaignPost() {}" }
            : DESIGN;
    return new Response(JSON.stringify(body));
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("designs", () => {
  it("lists designs with their cover artboard", async () => {
    render(<Designs />);
    const link = await screen.findByRole("link", { name: /Launch campaign/ });
    expect(link.getAttribute("href")).toBe("/designs/g1");
    expect(within(link).getByText(/acme-test · 2 artboards · v2/)).toBeTruthy();
    expect(link.querySelector("img")?.getAttribute("src")).toBe("/designs/g1/post.png?v=2");
  });

  it("shows each artboard with its own checks, and edits through the tools", async () => {
    render(<DesignEditor id="g1" />);
    const banner = await screen.findByRole("region", { name: "Artboard banner" });
    expect(await within(banner).findByText(/Display ad 728x90 · 728×90 · dark/)).toBeTruthy(); // labels from list_formats
    expect(within(banner).getByText("accent on background: 2.3:1")).toBeTruthy();
    expect(within(banner).getByRole("img").getAttribute("src")).toBe("/designs/g1/banner.png?v=2");
    const post = screen.getByRole("region", { name: "Artboard post" });
    expect(within(post).getByText("text inside the safe margin")).toBeTruthy();
    expect(screen.getByText(/1 error · 1 warning/)).toBeTruthy();

    // the colour mode is a patch of the spec
    fireEvent.click(await screen.findByRole("button", { name: "dark" }));
    await waitFor(() => expect(calls.find((c) => c.name === "patch_design")).toBeTruthy());
    expect(calls.find((c) => c.name === "patch_design")?.args.ops).toEqual([{ op: "set_field", field: "mode", value: "dark" }]);

    // adapt an artboard to another format: a new artboard id, the chosen format
    fireEvent.click(within(post).getByRole("button", { name: /Adapt to/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Format" }), { target: { value: "story" } });
    fireEvent.click(screen.getByRole("button", { name: "Adapt" }));
    await waitFor(() => expect(calls.filter((c) => c.name === "patch_design")).toHaveLength(2));
    expect(calls.filter((c) => c.name === "patch_design")[1]?.args.ops).toEqual([{ op: "adapt_artboard", artboard: "post", id: "post_story", format: "story" }]);

    // code opens in a dialog
    fireEvent.click(within(post).getByRole("button", { name: /React/ }));
    expect(await screen.findByRole("dialog", { name: "LaunchCampaignPost.tsx" })).toBeTruthy();
    expect(calls.find((c) => c.name === "export_design")?.args).toEqual({ design_id: "g1", format: "react", artboard: "post" });
  });
});
