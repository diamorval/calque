import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { jwtVerify, SignJWT } from "jose";
import type { Db } from "./db.ts";
import { engine } from "./engine.ts";
import { NotFound, type User } from "./packs.ts";

/** Largest upload: a corporate template with its media fits well under it. */
export const MAX_UPLOAD = 50 * 1024 * 1024;
/** Prefix of a file reference in a DeckSpec image value: `file:<file_id>`. */
export const FILE_REF = "file:";

export interface StoredFile {
  file_id: string;
  name: string;
  size: number;
  type: string;
}

/** Uploads live under $CALQUE_DATA/uploads/<file_id>, owned by their uploader. */
export const uploadPath = (data: string, id: string) => join(data, "uploads", id);

export async function saveFile(db: Db, data: string, user: User, name: string, type: string, bytes: Buffer): Promise<StoredFile> {
  if (bytes.length > MAX_UPLOAD) throw new TooLarge(`file over ${MAX_UPLOAD / 1024 / 1024} MB`);
  const id = randomUUID();
  await mkdir(join(data, "uploads"), { recursive: true });
  await writeFile(uploadPath(data, id), bytes);
  await db.query("insert into files (id, owner, name, size, type) values ($1, $2, $3, $4, $5)", [id, user.id, name, bytes.length, type]);
  return { file_id: id, name, size: bytes.length, type };
}

/** A file of `user`'s, with its path; another user's file is not found. */
export async function getFile(db: Db, data: string, user: User, id: string): Promise<StoredFile & { path: string }> {
  const { rows } = await db
    .query<{ id: string; name: string; size: string | number; type: string }>("select * from files where id = $1 and owner = $2", [id, user.id])
    .catch(() => ({ rows: [] }));
  const f = rows[0];
  if (!f) throw new NotFound(`no file ${JSON.stringify(id)}`);
  return { file_id: f.id, name: f.name, size: Number(f.size), type: f.type, path: uploadPath(data, f.id) };
}

/** A copy of upload `id` (whoever owns it) for `user`: a slide copied from a deck they may read
places its images as their own files. The caller checks they may read the slide. */
export async function copyFile(db: Db, data: string, user: User, id: string): Promise<StoredFile> {
  const { rows } = await db.query<{ name: string; type: string }>("select name, type from files where id = $1", [id]).catch(() => ({ rows: [] }));
  const f = rows[0];
  if (!f) throw new NotFound(`no file ${JSON.stringify(id)}`);
  return saveFile(db, data, user, f.name, f.type, await readFile(uploadPath(data, id)));
}

export class TooLarge extends Error {}

const isImage = (f: StoredFile) => f.type.startsWith("image/") || /\.(png|jpe?g|gif|bmp|tiff?|webp|svg)$/i.test(f.name);

/** An attached file as the model sees it: an image to place by reference, or a document's text. */
export async function attachment(db: Db, data: string, user: User, id: string) {
  const f = await getFile(db, data, user, id);
  const meta = { file_id: f.file_id, name: f.name, size: f.size, type: f.type };
  if (isImage(f)) return { ...meta, ref: `${FILE_REF}${f.file_id}` };
  try {
    const r = await engine<{ text: string; truncated: boolean }>("text", { path: f.path, name: f.name });
    return { ...meta, text: r.text, truncated: r.truncated };
  } catch (e) {
    return { ...meta, error: (e as Error).message };
  }
}
export type Attachment = Awaited<ReturnType<typeof attachment>>;

/** Upload tickets: a short-lived signed URL that uploads as the user who asked for it, for MCP
clients that hold no bearer token of their own to send (Claude Code's shell, for one). */
const ticketKey = (secret: string) => createHash("sha256").update(`upload:${secret}`).digest();

export const uploadTicket = (secret: string, user: User) =>
  new SignJWT({ teams: user.teams }).setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setIssuedAt().setExpirationTime("15m").sign(ticketKey(secret));

export async function ticketUser(secret: string, ticket: string): Promise<User | undefined> {
  try {
    const { payload } = await jwtVerify(ticket, ticketKey(secret), { algorithms: ["HS256"] });
    return { id: String(payload.sub), teams: (payload.teams as string[]) ?? [] };
  } catch {
    return undefined;
  }
}
