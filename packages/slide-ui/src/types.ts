/** What the deck UI shows: the subset of open_deck's result it reads. */
export interface ShapeBox {
  shape_id: number;
  bbox_px: [number, number, number, number]; // left, top, width, height in the PNG's pixels
  kind: string;
  role: string;
}

export interface SlideView {
  id: string;
  number: number;
  image_url: string;
  width_px: number;
  height_px: number;
  shapes: ShapeBox[];
}

export interface Comment {
  id: number;
  slide_id: string;
  shape_id: number | null;
  text: string;
  /** The author's id (a token's `sub`), "guest" through an anyone-with-the-link share link. */
  author: string;
  /** Their display name, shown instead of the id when there is one. */
  author_name?: string | null;
  status: "open" | "resolved";
  /** The thread's replies, oldest first. */
  replies?: Comment[];
}

/** The deck's approval status, on packs that turn it on (`approval: true` in pack.yaml). */
export type Approval =
  | { enabled: false }
  | { enabled: true; status: "draft" | "in_review" | "approved"; can_request: boolean; can_withdraw: boolean; can_approve: boolean };

export interface DeckView {
  deck_id: string;
  title: string;
  pack_id: string;
  version: number;
  head: number;
  slides: SlideView[];
  open_comments: Comment[];
  resolved_comments?: Comment[];
  approval?: Approval;
  preview_url: string;
  /** The viewer's role on the deck: a viewer reads only, a commenter also comments. */
  role?: "viewer" | "commenter" | "editor" | "owner";
}

export interface NewComment {
  slide_id: string;
  shape_id?: number;
  text: string;
}

export interface NewReply {
  parent_id: number;
  text: string;
}
