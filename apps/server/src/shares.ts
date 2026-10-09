import { randomUUID } from "node:crypto";
import type { Db } from "./db.ts";
import { access, type Decks, type Role } from "./decks.ts";
import { isAdmin } from "./models.ts";
import { Forbidden, NotFound, type User } from "./packs.ts";
import { PREVIEW_ROLE, PREVIEW_TTL_S, type Link } from "./preview.ts";

/** Deck sharing: grants to a user, a team or the whole workspace (deck_shares), guest links
(deck_links), ownership transfer. The owner manages them; an admin (CALQUE_ADMIN_TEAM) may only
transfer a deck and revoke its links, never read it. Every change is logged in deck_audit. */

export type PrincipalType = "user" | "team" | "workspace";
export interface Share {
  principal_type: PrincipalType;
  principal: string;
  role: Role;
  granted_by: string;
  created_at: string;
}

const HOUR = 3600;
const WORKSPACE = "*";

async function audit(db: Db, deckId: string, actor: User, action: string, detail: Record<string, unknown>) {
  await db.query("insert into deck_audit (deck_id, actor, action, detail) values ($1, $2, $3, $4)", [deckId, actor.id, action, JSON.stringify(detail)]);
}

/** Who a grant names; the workspace has no name. */
function principalOf(type: PrincipalType, principal: string | undefined): string {
  if (type === "workspace") return WORKSPACE;
  const p = principal?.trim();
  if (!p) throw new Error(`a ${type} share needs the ${type}'s id`);
  return p;
}

/** Deck `id` for its owner, or for an admin who is not a guest; the caller's way in. */
async function ownerOrAdmin(decks: Decks, user: User, id: string) {
  const { rows } = await decks.db.query<{ id: string; owner: string; pack_id: string }>("select id, owner, pack_id from decks where id = $1", [id]).catch(() => ({ rows: [] }));
  const row = rows[0];
  const role = row ? await access(decks.db, user, row) : null;
  if (row && (role === "owner" || (!user.guest && isAdmin(user)))) return row;
  if (row && role) throw new Forbidden(`owner access needed on deck ${id}`);
  throw new NotFound(`no deck ${JSON.stringify(id)}`);
}

export async function share(decks: Decks, user: User, id: string, type: PrincipalType, principal: string | undefined, role: Role) {
  const deck = await decks.deck(user, id, "owner");
  const p = principalOf(type, principal);
  if (role === "owner") throw new Error("a deck has one owner: transfer it instead");
  if (type === "user" && p === deck.owner) throw new Error("the owner already has every right on the deck");
  await decks.db.query(
    `insert into deck_shares (deck_id, principal_type, principal, role, granted_by) values ($1, $2, $3, $4, $5)
     on conflict (deck_id, principal_type, principal) do update set role = $4, granted_by = $5, created_at = now()`,
    [id, type, p, role, user.id],
  );
  await audit(decks.db, id, user, "share", { principal_type: type, principal: p, role });
  return { principal_type: type, principal: p, role };
}

export async function unshare(decks: Decks, user: User, id: string, type: PrincipalType, principal: string | undefined) {
  await decks.deck(user, id, "owner");
  const p = principalOf(type, principal);
  const { rows } = await decks.db.query("delete from deck_shares where deck_id = $1 and principal_type = $2 and principal = $3 returning role", [id, type, p]);
  if (!rows.length) throw new NotFound(`deck ${id} is not shared with ${type} ${JSON.stringify(p)}`);
  await audit(decks.db, id, user, "unshare", { principal_type: type, principal: p });
  return { principal_type: type, principal: p };
}

/** The deck's live links (not revoked, not expired), newest first. */
export async function links(db: Db, id: string): Promise<Link[]> {
  const { rows } = await db.query<Link>(
    "select * from deck_links where deck_id = $1 and revoked_at is null and expires_at > now() order by created_at desc",
    [id],
  );
  return rows;
}

/** Whether guest link `linkId` of deck `deckId` still opens it (stored, not revoked, not expired). */
export async function live(db: Db, linkId: string, deckId: string): Promise<boolean> {
  const { rows } = await db
    .query("select 1 from deck_links where id = $1 and deck_id = $2 and revoked_at is null and expires_at > now()", [linkId, deckId])
    .catch(() => ({ rows: [] })); // a malformed id
  return rows.length > 0;
}

/** Grants and live links of a deck, owner only. */
export async function shares(decks: Decks, user: User, id: string) {
  const deck = await decks.deck(user, id, "owner");
  const { rows } = await decks.db.query<Share>(
    "select principal_type, principal, role, granted_by, created_at from deck_shares where deck_id = $1 order by created_at",
    [id],
  );
  return { owner: deck.owner, shares: rows, links: await links(decks.db, id) };
}

/** A guest link on purpose: `role` viewer or commenter, for `days`. */
export async function createLink(decks: Decks, user: User, id: string, role: "viewer" | "commenter", days: number, label?: string) {
  await decks.deck(user, id, "owner");
  const link = await insertLink(decks.db, user, id, role, new Date(Date.now() + days * 24 * HOUR * 1000), false, label);
  await audit(decks.db, id, user, "link", { link: link.id, role, expires_at: link.expires_at });
  return link;
}

/** The link tool results carry for `user`: their live automatic link, reused while it has more than
a day left (stable URLs), else a new one. */
export async function previewLink(db: Db, user: User, id: string): Promise<Link> {
  const { rows } = await db.query<Link>(
    `select * from deck_links where deck_id = $1 and created_by = $2 and auto and teams = $3::jsonb and revoked_at is null
     and expires_at > now() + interval '1 day' order by expires_at desc limit 1`,
    [id, user.id, JSON.stringify(user.teams)],
  );
  if (rows[0]) return rows[0];
  // expiry rounded up to the hour
  const e = Math.ceil((Date.now() / 1000 + PREVIEW_TTL_S) / HOUR) * HOUR;
  return insertLink(db, user, id, PREVIEW_ROLE, new Date(e * 1000), true);
}

async function insertLink(db: Db, user: User, id: string, role: Role, expires: Date, auto: boolean, label?: string): Promise<Link> {
  const { rows } = await db.query<Link>(
    `insert into deck_links (id, deck_id, role, label, created_by, teams, auto, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [randomUUID(), id, role, label?.trim() || `link from ${user.name ?? user.id}`, user.id, JSON.stringify(user.teams), auto, expires.toISOString()],
  );
  return rows[0] as Link;
}

/** Revoke a link: it opens nothing from now on. The owner or an admin. */
export async function revokeLink(decks: Decks, user: User, id: string, linkId: string) {
  await ownerOrAdmin(decks, user, id);
  const { rows } = await decks.db
    .query("update deck_links set revoked_at = now() where id = $1 and deck_id = $2 and revoked_at is null returning id", [linkId, id])
    .catch(() => ({ rows: [] }));
  if (!rows.length) throw new NotFound(`no live link ${JSON.stringify(linkId)} on deck ${id}`);
  await audit(decks.db, id, user, "revoke_link", { link: linkId });
  return { revoked: linkId };
}

/** What an admin may see of a deck's links: who minted them, their role and expiry, not the URL. */
export async function adminLinks(decks: Decks, user: User, id: string) {
  await ownerOrAdmin(decks, user, id);
  return (await links(decks.db, id)).map(({ id: link, role, label, created_by, auto, expires_at, created_at }) => ({ id: link, role, label, created_by, auto, expires_at, created_at }));
}

/** Give the deck to user `to`. The former owner keeps editor access through a share (the new owner
may remove it). The owner or an admin. */
export async function transfer(decks: Decks, user: User, id: string, to: string) {
  const deck = await ownerOrAdmin(decks, user, id);
  const next = to.trim();
  if (!next) throw new Error("transfer to whom? a user id");
  if (next === deck.owner) throw new Error(`${next} already owns deck ${id}`);
  await decks.db.query("update decks set owner = $2 where id = $1", [id, next]);
  await decks.db.query("delete from deck_shares where deck_id = $1 and principal_type = 'user' and principal = $2", [id, next]);
  await decks.db.query(
    `insert into deck_shares (deck_id, principal_type, principal, role, granted_by) values ($1, 'user', $2, 'editor', $3)
     on conflict (deck_id, principal_type, principal) do update set role = 'editor', granted_by = $3, created_at = now()`,
    [id, deck.owner, user.id],
  );
  await audit(decks.db, id, user, "transfer", { from: deck.owner, to: next });
  return { deck_id: id, owner: next, previous_owner: deck.owner };
}
