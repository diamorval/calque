import { rm } from "node:fs/promises";
import { audit } from "./audit.ts";
import { copyFile, FILE_REF, getFile, isImage, uploadPath } from "./files.ts";
import { libraryUser } from "./library.ts";
import { Forbidden, getPack, listPacks, manages, NotFound, type User } from "./packs.ts";
import type { App } from "./tools.ts";

/** A brand pack's image library (M11), next to its slide library (library.ts): approved images
(photography, client logos, product shots) with a title and tags. An image is a copy of an upload,
owned by the library (`library:<pack_id>`). Anyone who sees the pack proposes one; the pack's
managers (its owner, or an admin) approve it, and their own additions are approved at once.
Everyone who sees the pack lists the approved images and places one in a DeckSpec picture slot as
its `file:<file_id>`: on save the deck gets its own copy (decks.ts), so removing an image from the
library never breaks a deck. A pending image shows only to its author and the managers. */

export interface LibraryImage {
  id: string;
  pack_id: string;
  file_id: string;
  title: string;
  tags: string[];
  status: "pending" | "approved";
  added_by: string;
  approved_by: string | null;
  created_at: string;
}

const tagsOf = (tags: string[] | undefined) => [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];

async function managerOf(app: App, user: User, packId: string) {
  const pack = await getPack(app.db, user, packId);
  return !user.anonymous && manages(pack, user);
}

/** Image `id`, if `user` may see it: its pack visible, and approved unless they added it or manage the pack. */
async function image(app: App, user: User, id: string) {
  const { rows } = await app.db.query<LibraryImage>("select * from library_images where id = $1", [id]).catch(() => ({ rows: [] as LibraryImage[] }));
  const i = rows[0];
  const missing = () => new NotFound(`no library image ${JSON.stringify(id)}`);
  if (!i) throw missing();
  const manager = await managerOf(app, user, i.pack_id).catch(() => {
    throw missing();
  });
  if (i.status !== "approved" && !manager && i.added_by !== user.id) throw missing();
  return { image: i, manager };
}

const view = (app: App, i: LibraryImage & { name?: string; type?: string }) => ({
  image_id: i.id,
  pack_id: i.pack_id,
  title: i.title,
  tags: i.tags,
  status: i.status,
  added_by: i.added_by,
  approved_by: i.approved_by,
  ref: `${FILE_REF}${i.file_id}`,
  image_url: `${app.publicUrl}/api/library/images/${i.id}`,
  ...(i.type ? { type: i.type } : {}),
  created_at: i.created_at,
});

/** Add upload `file_id` (the caller's, an image) to pack `pack_id`'s image library. */
export async function imageAdd(app: App, user: User, a: { pack_id: string; file_id: string; title: string; tags?: string[] | undefined }) {
  if (user.anonymous) throw new Forbidden("sign in to add to the library");
  const manager = await managerOf(app, user, a.pack_id);
  const f = await getFile(app.db, app.data, user, a.file_id);
  if (!isImage(f)) throw new Error(`${f.name} is not an image: the image library takes PNG, JPEG, GIF, BMP, TIFF, WebP and SVG`);
  const copy = await copyFile(app.db, app.data, libraryUser(a.pack_id), f.file_id);
  const { rows } = await app.db.query<LibraryImage>(
    `insert into library_images (id, pack_id, file_id, title, tags, status, added_by, approved_by)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7) returning *`,
    [a.pack_id, copy.file_id, a.title, JSON.stringify(tagsOf(a.tags)), manager ? "approved" : "pending", user.id, manager ? user.id : null],
  );
  const i = rows[0] as LibraryImage;
  await audit(app.db, user, "add", "library_image", i.id, { pack_id: i.pack_id, title: i.title, status: i.status, file: f.name });
  return view(app, { ...i, type: copy.type });
}

/** The images `user` sees, newest first: on `pack_id` (default every pack they see), matching
`query` (title or tag words) and carrying every tag of `tags`. `status`: managers review pending ones. */
export async function imageList(
  app: App,
  user: User,
  a: { pack_id?: string | undefined; query?: string | undefined; tags?: string[] | undefined; status?: "approved" | "pending" | "all" | undefined },
) {
  const packs = (await listPacks(app.db, user, { archived: true })).filter((p) => !a.pack_id || p.id === a.pack_id);
  if (a.pack_id && !packs.length) throw new NotFound(`no pack ${JSON.stringify(a.pack_id)}`);
  const managed = new Set(packs.filter((p) => p.editable && !user.anonymous).map((p) => p.id));
  const { rows } = await app.db.query<LibraryImage & { type: string }>(
    `select i.*, f.type from library_images i join files f on f.id = i.file_id
     where i.pack_id = any($1::text[]) order by i.created_at desc`,
    [packs.map((p) => p.id)],
  );
  const words = (a.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const tags = tagsOf(a.tags);
  const status = a.status ?? "approved";
  const images = rows.filter((i) => {
    if (i.status !== "approved" && !managed.has(i.pack_id) && i.added_by !== user.id) return false;
    if (status !== "all" && i.status !== status) return false;
    const hay = `${i.title} ${i.tags.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w)) && tags.every((t) => i.tags.includes(t));
  });
  return { images: images.map((i) => view(app, i)) };
}

/** Approve a pending image: the pack's managers. */
export async function imageApprove(app: App, user: User, id: string) {
  const { image: i, manager } = await image(app, user, id);
  if (!manager) throw new Forbidden(`only the owner of ${i.pack_id} or an admin approve library images`);
  const { rows } = await app.db.query<LibraryImage>("update library_images set status = 'approved', approved_by = $2 where id = $1 returning *", [id, user.id]);
  await audit(app.db, user, "approve", "library_image", id, { pack_id: i.pack_id, title: i.title });
  return view(app, rows[0] as LibraryImage);
}

/** Remove an image (or reject a pending one): the pack's managers, or its author while pending.
Decks that placed it keep their own copy. */
export async function imageRemove(app: App, user: User, id: string) {
  const { image: i, manager } = await image(app, user, id);
  if (!manager && !(i.added_by === user.id && i.status === "pending")) throw new Forbidden(`only the owner of ${i.pack_id} or an admin remove an approved library image`);
  await app.db.query("delete from library_images where id = $1", [id]);
  await app.db.query("delete from files where id = $1", [i.file_id]);
  await rm(uploadPath(app.data, i.file_id), { force: true });
  await audit(app.db, user, "remove", "library_image", id, { pack_id: i.pack_id, title: i.title, status: i.status });
  return { image_id: id, removed: true };
}

/** The image file, for a viewer who may see it. */
export async function imageFile(app: App, user: User, id: string) {
  const { image: i } = await image(app, user, id);
  return getFile(app.db, app.data, libraryUser(i.pack_id), i.file_id);
}

/** Of the `file:<id>` ids a DeckSpec places, those of approved library images `user` sees (their pack visible). */
export async function libraryImages(app: Pick<App, "db">, user: User, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const { rows } = await app.db.query<{ file_id: string; pack_id: string }>(
    "select file_id::text as file_id, pack_id from library_images where status = 'approved' and file_id::text = any($1::text[])",
    [ids],
  );
  const out: string[] = [];
  for (const r of rows) if (await getPack(app.db, user, r.pack_id).then(() => true, () => false)) out.push(r.file_id);
  return out;
}
