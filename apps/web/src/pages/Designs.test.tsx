// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n.ts";
import { DesignEditor, Designs, textTarget } from "./Designs.tsx";

type Json = Record<string, unknown>;

const finding = (severity: string, artboard: string | null, node: string | null, check: string, message: string) => ({ severity, artboard, node, check, message });
const DESIGN = {
  design_id: "g1",
  title: "Launch campaign",
  pack_id: "acme-test",
  version: 2,
  head: 2,
  artboards: [
    {
      id: "post",
      format: "social_square",
      width: 1080,
      height: 1080,
      mode: null,
      boxes: { post: { x: 0, y: 0, w: 1080, h: 1080 }, headline: { x: 64, y: 300, w: 900, h: 200 }, cta__label: { x: 80, y: 960, w: 100, h: 30 } },
    },
    { id: "banner", format: "leaderboard", width: 728, height: 90, mode: "dark", boxes: {} },
  ],
  errors: [finding("ERROR", "banner", "cta__label", "contrast", "accent on background: 2.3:1")],
  warnings: [finding("WARN", "post", "headline", "safe_area", "text inside the safe margin")],
  spec: {
    artboards: [
      {
        id: "post",
        children: [
          { type: "text", id: "headline", text: "Ship decks" },
          { type: "instance", id: "cta", component: "button", props: { label: "Try it" } },
        ],
      },
      { id: "banner", children: [] },
    ],
    components: { button: { props: { label: "Learn more" }, node: { type: "frame", id: "b", children: [{ type: "text", id: "label", text: "{label}" }] } } },
  },
  role: "owner",
  me: "local",
  open_comments: [
    { id: 7, artboard: "post", node: "headline", text: "Shorter please", author: "bob", author_name: "Bob", status: "open", created_at: new Date().toISOString(), replies: [] },
  ],
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
            : name === "list_design_shares"
              ? { shares: [{ principal_type: "team", principal: "design", role: "viewer" }] }
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
    expect(within(banner).getByRole("img", { name: "Artboard banner" }).getAttribute("src")).toBe("/designs/g1/banner.png?v=2");
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

  it("edits a text in place, a component's prop too, and comments on a node", async () => {
    render(<DesignEditor id="g1" />);
    const post = await screen.findByRole("region", { name: "Artboard post" });
    expect(within(post).getByText("Shorter please")).toBeTruthy();

    fireEvent.click(within(post).getByRole("button", { name: "Open headline" }));
    const dialog = await screen.findByRole("dialog", { name: "headline" });
    expect(within(dialog).getByText("Shorter please")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Text"), { target: { value: "Decks on brand" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.name === "patch_design")).toBeTruthy());
    expect(calls.find((c) => c.name === "patch_design")?.args.ops).toEqual([{ op: "set_node", artboard: "post", node_id: "headline", props: { text: "Decks on brand" } }]);

    fireEvent.click(within(post).getByRole("button", { name: "Open cta__label" }));
    const cta = await screen.findByRole("dialog", { name: "cta__label" });
    expect((within(cta).getByLabelText("Text") as HTMLTextAreaElement).value).toBe("Try it");
    fireEvent.change(within(cta).getByLabelText("Comment"), { target: { value: "Bigger button" } });
    fireEvent.click(within(cta).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(calls.find((c) => c.name === "add_design_comment")).toBeTruthy());
    expect(calls.find((c) => c.name === "add_design_comment")?.args).toEqual({ design_id: "g1", artboard: "post", node: "cta__label", text: "Bigger button" });

    fireEvent.click(within(post).getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(calls.find((c) => c.name === "resolve_design_comments")?.args).toEqual({ design_id: "g1", ids: [7] }));
  });

  it("shares with people and teams", async () => {
    render(<DesignEditor id="g1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Share" }));
    const dialog = await screen.findByRole("dialog", { name: "Share design" });
    expect(await within(dialog).findByText("design")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("User id"), { target: { value: "bob" } });
    fireEvent.change(within(dialog).getByLabelText("Role"), { target: { value: "editor" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls.find((c) => c.name === "share_design")?.args).toEqual({ design_id: "g1", principal_type: "user", principal: "bob", role: "editor" }));
  });

  it("finds the text behind a node: its own, or the instance prop it shows", () => {
    const spec = DESIGN.spec;
    expect(textTarget(spec, "post", "headline")?.text).toBe("Ship decks");
    const prop = textTarget(spec, "post", "cta__label");
    expect(prop?.ops("Go")).toEqual([{ op: "set_node", artboard: "post", node_id: "cta", props: { props: { label: "Go" } } }]);
    expect(textTarget(spec, "post", "cta")).toBeNull();
    expect(textTarget(spec, "banner", "headline")).toBeNull();
  });
});
