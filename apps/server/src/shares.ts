import { randomBytes } from "node:crypto";
import { audit as log } from "./audit.ts";
import type { Db } from "./db.ts";
import { access, type Decks, type GeneralAccess, type Role } from "./decks.ts";
import { isAdmin } from "./models.ts";
import { Forbidden, NotFound, type User } from "./packs.ts";

/** Deck sharing, artifact style: people and teams with a role (deck_shares), and one share link
per deck (`/decks/:id?k=<link_key>`) whose general access says who else it opens for: nobody
(private), anyone signed in who sees the deck's pack (workspace), or anybody (anyone), with the
general role (viewer or commenter). Resetting the link rotates its key: every copy of the old one
stops working. The owner manages all of it; an admin (CALQUE_ADMIN_TEAM) may only see who has
access, transfer the deck, set it Private and reset its link, never read it. Every change is logged
in the audit log (audit.ts). */

export type PrincipalType = "user" | "team";
export interface Share {
  principal_type: PrincipalType;
  principal: string;
  role: Role;
  granted_by: string;
  created_at: string;
}
export type GeneralRole = "viewer" | "commenter";
interface SharingRow {
  id: string;
  owner: string;
  pack_id: string;
  general_access: GeneralAccess;
  general_role: GeneralRole;
  link_key: string;
}

export const audit = (db: Db, deckId: string, actor: User, action: string, detail: Record<string, unknown>) =>
  log(db, actor, action, "deck", deckId, detail);

function principalOf(type: PrincipalType, principal: string): string {
  const p = principal.trim();
  if (!p) throw new Error(`a ${type} share needs the ${type}'s id`);
  return p;
}

/** Deck `id` for its owner, or for a signed-in admin; the caller's way in. */
async function ownerOrAdmin(decks: Decks, user: User, id: string): Promise<SharingRow & { owns: boolean }> {
  const { rows } = await decks.db
    .query<SharingRow>("select id, owner, pack_id, general_access, general_role, link_key from decks where id = $1", [id])
    .catch(() => ({ rows: [] as SharingRow[] }));
  const row = rows[0];
  const role = row ? await access(decks.db, user, row) : null;
  if (row && (role === "owner" || (!user.anonymous && isAdmin(user)))) return { ...row, owns: role === "owner" };
  if (row && role) throw new Forbidden(`owner access needed on deck ${id}`);
  throw new NotFound(`no deck ${JSON.stringify(id)}`);
}

export async function share(decks: Decks, user: User, id: string, type: PrincipalType, principal: string, role: Role) {
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

export async function unshare(decks: Decks, user: User, id: string, type: PrincipalType, principal: string) {
  await decks.deck(user, id, "owner");
  const p = principalOf(type, principal);
  const { rows } = await decks.db.query("delete from deck_shares where deck_id = $1 and principal_type = $2 and principal = $3 returning role", [id, type, p]);
  if (!rows.length) throw new NotFound(`deck ${id} is not shared with ${type} ${JSON.stringify(p)}`);
  await audit(decks.db, id, user, "unshare", { principal_type: type, principal: p });
  return { principal_type: type, principal: p };
}

async function people(db: Db, id: string): Promise<Share[]> {
  const { rows } = await db.query<Share>(
    "select principal_type, principal, role, granted_by, created_at from deck_shares where deck_id = $1 order by created_at",
    [id],
  );
  return rows;
}

/** Who has access to deck `id`: its owner, the people and teams it is shared with, its general
access. With its link key for the owner; without it for an admin. */
export async function shares(decks: Decks, user: User, id: string) {
  const deck = await ownerOrAdmin(decks, user, id);
  return {
    owner: deck.owner,
    people: await people(decks.db, id),
    general: { access: deck.general_access, role: deck.general_role },
    ...(deck.owns ? { link_key: deck.link_key } : {}),
  };
}

/** Who the share link opens for besides people with access, and with which role. The owner; an
admin may only make the deck private. */
export async function setGeneralAccess(decks: Decks, user: User, id: string, general: GeneralAccess, role: GeneralRole) {
  const deck = await ownerOrAdmin(decks, user, id);
  if (!deck.owns && general !== "private") throw new Forbidden(`owner access needed on deck ${id}: an admin may only make it private`);
  const r = general === "private" ? deck.general_role : role;
  await decks.db.query("update decks set general_access = $2, general_role = $3 where id = $1", [id, general, r]);
  await audit(decks.db, id, user, "access", { from: deck.general_access, access: general, role: r });
  return { access: general, role: r };
}

/** A new share link key: every copy of the old link stops working. The owner or an admin. */
export async function resetLink(decks: Decks, user: User, id: string) {
  const deck = await ownerOrAdmin(decks, user, id);
  const key = randomBytes(24).toString("base64url");
  await decks.db.query("update decks set link_key = $2 where id = $1", [id, key]);
  await audit(decks.db, id, user, "reset_link", {});
  return deck.owns ? { link_key: key } : {};
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
