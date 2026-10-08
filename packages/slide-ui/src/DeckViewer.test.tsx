// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("switches slides from the thumbnails and shows that slide's comments", () => {
    render(<DeckViewer deck={deck} onComment={vi.fn()} onApply={vi.fn()} />);
    expect(screen.getByLabelText("1 comment")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /Slide 2/ })[0] as HTMLElement);
    expect(screen.getByText("2 / 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Shape 5 (drawn)" }).dataset.commented).toBe("1"); // one pin
    expect(screen.getByText("Sort bars")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply 1 comment" })).toBeTruthy();
  });
});
