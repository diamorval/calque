/** Every word the deck UI shows. The host passes its own (the web app: in the user's language);
the MCP Apps UI keeps the English ones. Functions take what the sentence needs, plurals included. */
export interface SlideUiStrings {
  approval: Record<"draft" | "in_review" | "approved", string>;
  emptyDeck: string;
  /** The stage region and a slide's name: "Slide 3". */
  stage: string;
  slide: (n: number | string) => string;
  previousSlide: string;
  nextSlide: string;
  clickToComment: string;
  outlineShapes: string;
  shapes: string;
  wholeSlide: string;
  commentWholeSlide: string;
  /** The comment box's label: on a slide, and on one of its shapes. */
  commentOn: (slide: number, shape: number | null) => string;
  askShape: (label: string) => string;
  askSlide: string;
  comment: string;
  sidePanel: string;
  agent: string;
  comments: string;
  noOpenComment: string;
  noOpenCommentHint: string;
  repliesTo: (id: number) => string;
  selectComment: (id: number) => string;
  select: string;
  replyTo: (id: number) => string;
  reply: string;
  resolveComment: (id: number) => string;
  resolve: string;
  replyPlaceholder: string;
  send: string;
  resolvedComments: (n: number) => string;
  reopenComment: (id: number) => string;
  reopen: string;
  applySelected: (n: number) => string;
  applyAll: (n: number) => string;
  applySelectedHint: string;
  applyAllHint: string;
  /** The slide rail. */
  slides: string;
  commentCount: (n: number) => string;
  shape: (id: number, role: string) => string;
  /** A comment that blocks approval: the box when commenting, the badge on its thread. */
  required: string;
  requiredHint: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const EN_STRINGS: SlideUiStrings = {
  approval: { draft: "Draft", in_review: "In review", approved: "Approved" },
  emptyDeck: "Empty deck.",
  stage: "Slide",
  slide: (n) => `Slide ${n}`,
  previousSlide: "Previous slide",
  nextSlide: "Next slide",
  clickToComment: "Click an element to comment on it",
  outlineShapes: "Outline every shape",
  shapes: "Shapes",
  wholeSlide: "whole slide",
  commentWholeSlide: "Comment on the whole slide",
  commentOn: (slide, shape) => `Comment on slide ${slide}${shape !== null ? `, shape ${shape}` : ""}`,
  askShape: (label) => `What should change in this ${label}?`,
  askSlide: "What should change on this slide?",
  comment: "Comment",
  sidePanel: "Side panel",
  agent: "Agent",
  comments: "Comments",
  noOpenComment: "No open comment",
  noOpenCommentHint: "Click an element on the slide, say what should change, then let the agent apply it.",
  repliesTo: (id) => `Replies to comment ${id}`,
  selectComment: (id) => `Select comment ${id}`,
  select: "Select",
  replyTo: (id) => `Reply to comment ${id}`,
  reply: "Reply",
  resolveComment: (id) => `Resolve comment ${id}`,
  resolve: "Resolve",
  replyPlaceholder: "Reply…",
  send: "Send",
  resolvedComments: (n) => plural(n, "resolved comment"),
  reopenComment: (id) => `Reopen comment ${id}`,
  reopen: "Reopen",
  applySelected: (n) => `Apply ${n} selected`,
  applyAll: (n) => `Apply ${plural(n, "comment")}`,
  applySelectedHint: "The agent edits the deck for the selected comments only.",
  applyAllHint: "The agent edits the deck, then resolves each comment.",
  slides: "Slides",
  commentCount: (n) => plural(n, "comment"),
  shape: (id, role) => `Shape ${id} (${role})`,
  required: "Required",
  requiredHint: "A required comment blocks the deck's approval until it is resolved",
};
