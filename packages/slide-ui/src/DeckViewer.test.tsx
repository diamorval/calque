// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeckViewer } from "./DeckViewer.tsx";
import type { DeckView } from "./types.ts";

const deck: DeckView = {
  deck_id: "d1",
  title: "Quarterly review",
  pack_id: "acme-test",
  version: 2,
  head: 2,
  preview_url: "http://x/decks/d1",
  slides: [
    { id: "cover", number: 1, image_url: "/1.png", width_px: 1280, height_px: 720, shapes: [
      { shape_id: 2, bbox_px: [128, 72, 640, 144], kind: "text", role: "title" },
      { shape_id: 3, bbox_px: [0, 0, 0, 0], kind: "text", role: "template" },
    ] },
    { id: "regions", number: 2, image_url: "/2.png", width_px: 1280, height_px: 720, shapes: [
      { shape_id: 5, bbox_px: [0, 0, 100, 100], kind: "chart", role: "drawn" },
    ] },
  ],
  open_comments: [{ id: 7, slide_id: "regions", shape_id: 5, text: "Sort bars", author: "a", status: "open" }],
};

afterEach(cleanup);

describe("DeckViewer", () => {
  it("draws one clickable box per visible shape, placed from the shape map", () => {
    render(<DeckViewer deck={deck} onComment={vi.fn()} />);
    const box = screen.getByRole("button", { name: "Shape 2 (title)" });
    expect(box.style.left).toBe("10%");
    expect(box.style.width).toBe("50%");
    expect(screen.queryByRole("button", { name: /Shape 3/ })).toBeNull(); // zero-size: not clickable
  });

  it("anchors a comment on the clicked shape", async () => {
    const onComment = vi.fn().mockResolvedValue(undefined);
    render(<DeckViewer deck={deck} onComment={onComment} />);
    fireEvent.click(screen.getByRole("button", { name: "Shape 2 (title)" }));
    expect(screen.getByRole("button", { name: "Shape 2 (title)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText(/Comment on slide 1, shape 2/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Shorter title" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(onComment).toHaveBeenCalledWith({ slide_id: "cover", shape_id: 2, text: "Shorter title" });
  });

  it("comments on the whole slide when no shape is picked", () => {
    const onComment = vi.fn().mockResolvedValue(undefined);
    render(<DeckViewer deck={deck} onComment={onComment} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Too dense" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(onComment).toHaveBeenCalledWith({ slide_id: "cover", text: "Too dense" });
  });

  it("marks a comment required (it blocks approval), and shows required threads", () => {
    const onComment = vi.fn().mockResolvedValue(undefined);
    const flagged = { ...deck, open_comments: deck.open_comments.map((c) => ({ ...c, type: "required" as const })) };
    render(<DeckViewer deck={flagged} onComment={onComment} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Legal mention missing" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Required/ }));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(onComment).toHaveBeenCalledWith({ slide_id: "cover", text: "Legal mention missing", type: "required" });
    expect(screen.getAllByText("Required", { selector: ".cq-required" }).length).toBe(flagged.open_comments.length);
  });

  it("jumps to a comment's slide and shape from the comments panel", () => {
    render(<DeckViewer deck={deck} onComment={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Sort bars/ }));
    expect(screen.getByRole("button", { name: "Shape 5 (drawn)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText(/Comment on slide 2, shape 5/)).toBeTruthy();
  });

  it("shows the host's agent in its own tab, comments one click away", () => {
    render(<DeckViewer deck={deck} onComment={vi.fn()} agent={<p>chat here</p>} />);
    expect(screen.getByText("chat here")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Comments/ }));
    expect(screen.getByRole("tabpanel", { name: "Comments" })).toBeTruthy();
    expect(screen.queryByRole("tabpanel", { name: "Agent" })).toBeNull();
  });

  it("has no comment box for a viewer (no onComment)", () => {
    render(<DeckViewer deck={{ ...deck, role: "viewer" }} />);
    expect(screen.getByRole("button", { name: "Shape 2 (title)" })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText("Click an element to comment on it")).toBeNull();
  });

  it("switches slides from the thumbnails and shows that slide's comments", () => {
    render(<DeckViewer deck={deck} onComment={vi.fn()} onApply={vi.fn()} />);
    expect(screen.getByLabelText("1 comment")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /Slide 2/ })[0] as HTMLElement);
    expect(screen.getByText("2 / 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Shape 5 (drawn)" }).dataset.commented).toBe("1"); // one pin
    expect(screen.getByText("Sort bars")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply 1 comment" })).toBeTruthy();
  });

  const threads: DeckView = {
    ...deck,
    open_comments: [
      { id: 7, slide_id: "regions", shape_id: 5, text: "Sort bars", author: "u-7f3a", author_name: "Bob Durand", status: "open", replies: [
        { id: 9, slide_id: "regions", shape_id: 5, text: "By growth?", author: "alice", author_name: "Alice Martin", status: "open" },
      ] },
      { id: 8, slide_id: "cover", shape_id: null, text: "Too long", author: "guest", author_name: null, status: "open" },
    ],
    resolved_comments: [{ id: 3, slide_id: "cover", shape_id: null, text: "Typo", author: "alice", status: "resolved" }],
  };

  it("opens on the Comments tab when comments are open, and shows names, not ids", () => {
    render(<DeckViewer deck={threads} agent={<p>chat here</p>} onComment={vi.fn()} />);
    expect(screen.getByRole("tabpanel", { name: "Comments" })).toBeTruthy();
    expect(screen.getByText("Bob Durand")).toBeTruthy();
    expect(screen.queryByText("u-7f3a")).toBeNull();
    expect(screen.getByText("guest")).toBeTruthy(); // a guest-link comment keeps its label
    expect(screen.getByRole("list", { name: "Replies to comment 7" }).textContent).toContain("By growth?");
  });

  it("applies the selected comments only, else all", () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(<DeckViewer deck={threads} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply 2 comments" }));
    expect(onApply).toHaveBeenLastCalledWith(undefined);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select comment 8" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 selected" }));
    expect(onApply).toHaveBeenLastCalledWith([8]);
  });

  it("replies in a thread, resolves and reopens one comment", async () => {
    const onReply = vi.fn().mockResolvedValue(undefined);
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<DeckViewer deck={threads} onReply={onReply} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: "Reply to comment 7" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reply to comment 7" }), { target: { value: "By growth" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onReply).toHaveBeenCalledWith({ parent_id: 7, text: "By growth" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Reply to comment 7" })).toBeNull()); // sent: the box closes

    fireEvent.click(screen.getByRole("button", { name: "Resolve comment 8" }));
    expect(onResolve).toHaveBeenCalledWith([8], "resolved");
    fireEvent.click(screen.getByRole("button", { name: "1 resolved comment" }));
    await screen.findByText("Typo");
    fireEvent.click(screen.getByRole("button", { name: "Reopen comment 3" }));
    expect(onResolve).toHaveBeenLastCalledWith([3], "open");
  });

  it("adds the host's side-panel tabs and actions on the slide shown", () => {
    const act = vi.fn();
    render(
      <DeckViewer
        deck={deck}
        tabs={[{ id: "library", label: "Library", content: <p>Approved slides</p> }]}
        slideActions={(s) => <button onClick={() => act(s.id)}>Add to library</button>}
      />,
    );
    expect(screen.queryByRole("tabpanel", { name: "Library" })).toBeNull(); // hidden until picked
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.getByRole("tabpanel", { name: "Library" }).textContent).toBe("Approved slides");
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to library" }));
    expect(act).toHaveBeenCalledWith("regions");
  });

  it("shows the approval status when the pack turns it on", () => {
    render(<DeckViewer deck={{ ...deck, approval: { enabled: true, status: "in_review", can_request: false, can_withdraw: true, can_approve: false } }} />);
    expect(screen.getByText("In review")).toBeTruthy();
    cleanup();
    render(<DeckViewer deck={{ ...deck, approval: { enabled: false } }} />);
    expect(screen.queryByText(/Draft|In review|Approved/)).toBeNull();
  });
});
