// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n.ts";
import { Decks } from "./Decks.tsx";
import { DesignEditor, textTarget } from "./Designs.tsx";

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
  kind: null,
  kinds: ["marketing"],
  approval: { enabled: false },
  versions: [
    { version: 1, note: "create", author: "local", author_name: null, created_at: new Date().toISOString(), pack_version: 1 },
    { version: 2, note: "patch", author: "local", author_name: null, created_at: new Date().toISOString(), pack_version: 1 },
  ],
  open_comments: [
    { id: 7, slide_id: "post", node: "headline", text: "Shorter please", author: "bob", author_name: "Bob", status: "open", type: "suggestion", created_at: new Date().toISOString(), replies: [] },
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
const ROWS = [
  { id: "g1", title: "Launch campaign", pack_id: "acme-test", head: 2, owner: "me", role: "owner", kind: null, medium: "design", cover: "post", updated_at: new Date().toISOString() },
];

let calls: { url: string; name: string; args: Json }[];
beforeEach(() => {
  setLang("en");
  localStorage.clear();
  Element.prototype.scrollTo = () => {}; // the agent panel scrolls its log; jsdom has no layout
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const name = url.replace(/^.*\/tools\//, "").replace(/\?.*$/, "");
    calls.push({ url, name, args: JSON.parse(String(init?.body ?? "{}")) });
    // the app's other calls (models, Microsoft 365, me): not configured here
    if (!url.includes("/tools/") && !url.startsWith("/api/decks")) return new Response(JSON.stringify({ message: "not here" }), { status: 404 });
    const body: Json = url.startsWith("/api/decks")
      ? { decks: ROWS }
      : name === "list_formats"
        ? FORMATS
        : name === "list_packs"
          ? { packs: [{ id: "acme-test", name: "Acme" }] }
          : name === "export_design"
            ? { filename: "LaunchCampaignPost.tsx", code: "export default function LaunchCampaignPost() {}" }
            : name === "list_shares"
              ? { owner: "local", people: [], general: { access: "private", role: "viewer", expires_at: null }, url: "" }
              : name === "get_chat"
                ? { messages: [], can_write: true }
                : name === "library_list"
                  ? { entries: [] }
                  : DESIGN;
    return new Response(JSON.stringify(body));
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("designs", () => {
  it("lists designs on the decks page, by medium, with their cover artboard", async () => {
    render(<Decks medium="design" />);
    expect(await screen.findByRole("heading", { name: "Designs" })).toBeTruthy();
    const link = await screen.findByRole("link", { name: /Launch campaign/ });
    expect(link.getAttribute("href")).toBe("/designs/g1");
    expect(link.querySelector("img")?.getAttribute("src")).toBe("/designs/g1/post.png?v=2");
    expect(calls.find((c) => c.url.startsWith("/api/decks"))?.url).toContain("medium=design");
    expect(screen.queryByRole("button", { name: /Import PPTX/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /New design/ }).length).toBeGreaterThan(0);
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

  it("edits a text in place, a component's prop too, and comments on a node like on a deck", async () => {
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
    await waitFor(() => expect(calls.find((c) => c.name === "add_comment")).toBeTruthy());
    expect(calls.find((c) => c.name === "add_comment")?.args).toEqual({ deck_id: "g1", slide_id: "post", node: "cta__label", text: "Bigger button" });

    fireEvent.click(within(post).getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(calls.find((c) => c.name === "resolve_comments")?.args).toEqual({ deck_id: "g1", comment_ids: [7] }));
  });

  it("has a deck's history, type, share and export gate", async () => {
    render(<DesignEditor id="g1" />);
    await screen.findByRole("region", { name: "Artboard post" });
    fireEvent.click(screen.getByRole("button", { name: /History/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore v1" }));
    await waitFor(() => expect(calls.find((c) => c.name === "restore_version")?.args).toEqual({ deck_id: "g1", version: 1 }));

    fireEvent.change(screen.getByRole("combobox", { name: "Deck type" }), { target: { value: "marketing" } });
    await waitFor(() => expect(calls.find((c) => c.name === "set_deck_kind")?.args).toEqual({ deck_id: "g1", kind: "marketing" }));

    fireEvent.click(screen.getByRole("button", { name: /^Share$/ }));
    await waitFor(() => expect(calls.find((c) => c.name === "list_shares")?.args).toEqual({ deck_id: "g1" }));
  });

  it("asks why before a version with lint ERRORs goes out", async () => {
    render(<DesignEditor id="g1" />);
    await screen.findByRole("region", { name: "Artboard post" });
    fireEvent.click(screen.getByRole("button", { name: "PDF" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(calls.find((c) => c.name === "export_design")).toBeUndefined();
  });

  it("opens with a share link through the design's own tools", async () => {
    render(<DesignEditor id="g1" link="k=abc" />);
    const post = await screen.findByRole("region", { name: "Artboard post" });
    expect(calls.some((c) => c.url === "/designs/g1/tools/open_design?k=abc")).toBe(true);
    expect(calls.some((c) => c.url.startsWith("/api/tools/"))).toBe(false);
    expect(within(post).getByRole("img", { name: "Artboard post" }).getAttribute("src")).toBe("/designs/g1/post.png?v=2&k=abc");
    expect(screen.queryByRole("button", { name: /History/ })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Agent and library" })).toBeNull();
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
