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
  author: string;
  status: "open" | "resolved";
}

export interface DeckView {
  deck_id: string;
  title: string;
  pack_id: string;
  version: number;
  head: number;
  slides: SlideView[];
  open_comments: Comment[];
  preview_url: string;
}

export interface NewComment {
  slide_id: string;
  shape_id?: number;
  text: string;
}
