import { audit } from "./audit.ts";
import { Forbidden, getPack, listPacks, manages, NotFound, type User } from "./packs.ts";
import type { App } from "./tools.ts";

/** A brand pack's slide library (M10): approved slides people reuse (case studies, references,
team bios, boilerplate). An entry is a copy of one slide of a deck, kept as a hidden one-slide
deck owned by the library (`library:<pack_id>`), with a title and tags. Anyone who can edit a deck
proposes a slide; the pack's managers (its owner, or an admin) approve it, and their own additions
are approved at once. Everyone who sees the pack lists the approved entries and inserts them into
their decks (copy_slides machinery). A pending entry shows only to its author and the managers. */

export interface LibraryEntry {
  id: string;
  pack_id: string;
  deck_id: string;
  title: string;
  tags: string[];
  status: "pending" | "approved";
  added_by: string;
  approved_by: string | null;
  source_deck: string | null;
  source_slide: string | null;
  created_at: string;
  /** deck (a slide) or design (an artboard: a template to start designs from) */
  medium?: "deck" | "design" | undefined;
}

/** The library's own principal: it owns the entry decks (and their images), and reads them. */
export const libraryUser = (packId: string): User => ({ id: `library:${packId}`, name: `${packId} library`, teams: [], local: true });

const tagsOf = (tags: string[] | undefined) => [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];

async function packRow(app: App, user: User, packId: string) {
  const pack = await getPack(app.db, user, packId);
  return { pack, manager: !user.anonymous && manages(pack, user) };
}

/** Entry `id`, if `user` may see it: its pack visible, and approved unless they wrote it or manage the pack. */
async function entry(app: App, user: User, id: string) {
  const { rows } = await app.db
    .query<LibraryEntry>("select l.*, d.medium from library l join decks d on d.id = l.deck_id where l.id = $1", [id])
    .catch(() => ({ rows: [] as LibraryEntry[] }));
  const e = rows[0];
  if (!e) throw new NotFound(`no library entry ${JSON.stringify(id)}`);
  const { manager } = await packRow(app, user, e.pack_id).catch(() => {
    throw new NotFound(`no library entry ${JSON.stringify(id)}`);
  });
  if (e.status !== "approved" && !manager && e.added_by !== user.id) throw new NotFound(`no library entry ${JSON.stringify(id)}`);
  return { entry: e, manager };
}

const view = (app: App, e: LibraryEntry) => ({
  entry_id: e.id,
  pack_id: e.pack_id,
  title: e.title,
  tags: e.tags,
  status: e.status,
  added_by: e.added_by,
  approved_by: e.approved_by,
  source: e.source_deck ? { deck_id: e.source_deck, slide_id: e.source_slide } : null,
  created_at: e.created_at,
  medium: e.medium ?? "deck",
  thumbnail_url: `${app.publicUrl}/api/library/${e.id}/slide.png`,
});

/** Copy slide `slide_id` of deck `deck_id` (edit access) into its pack's library. */
export async function libraryAdd(app: App, user: User, a: { deck_id: string; slide_id: string; title: string; tags?: string[] | undefined }) {
  if (user.anonymous) throw new Forbidden("sign in to add to the library");
  const deck = await app.decks.deck(user, a.deck_id, "editor");
  const { manager } = await packRow(app, user, deck.pack_id);
  const deckId = await app.decks.snapshot(user, a.deck_id, a.slide_id, libraryUser(deck.pack_id), a.title);
  const { rows } = await app.db.query<LibraryEntry>(
    `insert into library (id, pack_id, deck_id, title, tags, status, added_by, approved_by, source_deck, source_slide)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
    [deck.pack_id, deckId, a.title, JSON.stringify(tagsOf(a.tags)), manager ? "approved" : "pending", user.id, manager ? user.id : null, a.deck_id, a.slide_id],
  );
  const e = { ...(rows[0] as LibraryEntry), medium: deck.medium };
  await audit(app.db, user, "add", "library", e.id, { pack_id: e.pack_id, title: e.title, status: e.status, deck_id: a.deck_id, slide_id: a.slide_id });
  return view(app, e);
}

/** The entries `user` sees, newest first: on `pack_id` (default every pack they see), matching
`query` (title or tag words) and carrying every tag of `tags`. `status`: managers review pending ones. */
export async function libraryList(
  app: App,
  user: User,
  a: { pack_id?: string | undefined; query?: string | undefined; tags?: string[] | undefined; status?: "approved" | "pending" | "all" | undefined; medium?: "deck" | "design" | undefined },
) {
  const packs = (await listPacks(app.db, user, { archived: true })).filter((p) => !a.pack_id || p.id === a.pack_id);
  if (a.pack_id && !packs.length) throw new NotFound(`no pack ${JSON.stringify(a.pack_id)}`);
  const managed = new Set(packs.filter((p) => p.editable && !user.anonymous).map((p) => p.id));
  const { rows } = await app.db.query<LibraryEntry>(
    "select l.*, d.medium from library l join decks d on d.id = l.deck_id where l.pack_id = any($1::text[]) and ($2::text is null or d.medium = $2) order by l.created_at desc",
    [packs.map((p) => p.id), a.medium ?? null],
  );
  const words = (a.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const tags = tagsOf(a.tags);
  const status = a.status ?? "approved";
  const entries = rows.filter((e) => {
    if (e.status !== "approved" && !managed.has(e.pack_id) && e.added_by !== user.id) return false;
    if (status !== "all" && e.status !== status) return false;
    const hay = `${e.title} ${e.tags.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w)) && tags.every((t) => e.tags.includes(t));
  });
  return { entries: entries.map((e) => view(app, e)) };
}

/** Approve a pending entry: the pack's managers. */
export async function libraryApprove(app: App, user: User, id: string) {
  const { entry: e, manager } = await entry(app, user, id);
  if (!manager) throw new Forbidden(`only the owner of ${e.pack_id} or an admin approve library entries`);
  const { rows } = await app.db.query<LibraryEntry>("update library set status = 'approved', approved_by = $2 where id = $1 returning *", [id, user.id]);
  await audit(app.db, user, "approve", "library", id, { pack_id: e.pack_id, title: e.title });
  return view(app, { ...(rows[0] as LibraryEntry), medium: e.medium });
}

/** Remove an entry (or reject a pending one): the pack's managers, or its author while pending. */
export async function libraryRemove(app: App, user: User, id: string) {
  const { entry: e, manager } = await entry(app, user, id);
  if (!manager && !(e.added_by === user.id && e.status === "pending"))
    throw new Forbidden(`only the owner of ${e.pack_id} or an admin remove an approved library entry`);
  await app.db.query("delete from library where id = $1", [id]);
  await app.decks.remove(libraryUser(e.pack_id), e.deck_id);
  await audit(app.db, user, "remove", "library", id, { pack_id: e.pack_id, title: e.title, status: e.status });
  return { entry_id: id, removed: true };
}

/** Insert an approved entry into deck or design `deck_id` (edit access) at `at`, as a new version.
A design entry without `deck_id` starts a new design of the caller's from it (a template). */
export async function libraryInsert(app: App, user: User, a: { entry_id: string; deck_id?: string | undefined; at?: number | undefined; title?: string | undefined }) {
  const { entry: e } = await entry(app, user, a.entry_id);
  if (e.status !== "approved") throw new Forbidden(`library entry ${e.id} is pending approval`);
  const lib = libraryUser(e.pack_id);
  const head = (await app.decks.deck(lib, e.deck_id, "viewer")).head;
  if (e.medium === "design") {
    const design = await app.decks.designSpec(e.deck_id, head);
    if (!a.deck_id) {
      if (user.anonymous) throw new Forbidden("sign in to start a design");
      const own = await app.decks.adoptFilesOf(user, { ...design, title: a.title?.trim() || e.title });
      return app.decks.createDesign(user, own, `from the library: ${e.title}`);
    }
    return app.decks.copySlides(user, e.deck_id, [design.artboards[0]?.id as string], a.deck_id, a.at, undefined, lib);
  }
  if (!a.deck_id) throw new Error("a slide goes into a deck: pass deck_id");
  const [slide] = (await app.decks.spec(e.deck_id, head)).slides;
  return app.decks.copySlides(user, e.deck_id, [slide?.id as string], a.deck_id, a.at, undefined, lib);
}

/** The entry's slide image, for a viewer who may see the entry. */
export async function librarySlide(app: App, user: User, id: string): Promise<string> {
  const { entry: e } = await entry(app, user, id);
  if (e.medium === "design") {
    const r = await app.decks.designRender(libraryUser(e.pack_id), e.deck_id, undefined, ["png"]);
    const png = r.artboards[0]?.files.png;
    if (!png) throw new NotFound(`library entry ${id} has no artboard`);
    return png;
  }
  const { slides } = await app.decks.render(libraryUser(e.pack_id), e.deck_id);
  const s = slides[0];
  if (!s) throw new NotFound(`library entry ${id} has no slide`);
  return s.png;
}
