import { randomUUID } from "node:crypto";
import { audit } from "./audit.ts";
import type { Db } from "./db.ts";
import { Forbidden, isAdmin, NotFound, type User } from "./packs.ts";

/** Server-side session control on top of the stateless session cookie: a signed-out session id is
revoked until it expires, a user's sessions issued before `sessions_after` are revoked, and an
inactive user (SCIM deprovisioning) can neither use a session or a token nor sign in.

A row matches a signed-in user when its id or externalId is the OIDC `sub`, or its userName is the
`sub`, `preferred_username` or `email` (case-insensitive). */

export interface Identity {
  sub: string;
  /** the other names the IdP gives: preferred_username, email, upn */
  names: string[];
}

export interface UserRow {
  id: string;
  user_name: string | null;
  external_id: string | null;
  display_name: string | null;
  active: boolean;
  deleted: boolean;
  sessions_after: Date | null;
  created_at: Date;
  updated_at: Date;
}

export class Conflict extends Error {}

/** The audit log's actor for what the IdP does over SCIM. */
const SCIM = "scim";

const MATCH = "(id = $1 or external_id = $1 or lower(user_name) in (select jsonb_array_elements_text($2::jsonb)))";
const keys = (who: Identity) => [who.sub, ...who.names].map((n) => n.toLowerCase());

export class Access {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private async matching(who: Identity): Promise<UserRow[]> {
    return (await this.db.query<UserRow>(`select * from users where ${MATCH}`, [who.sub, JSON.stringify(keys(who))])).rows;
  }

  /** Deactivated or deleted by SCIM: no sign-in, no session, no token. */
  async blocked(who: Identity): Promise<boolean> {
    return (await this.matching(who)).some((r) => !r.active || r.deleted);
  }

  /** A session (id `sid`, issued at `at` ms) is still valid. */
  async valid(who: Identity, sid: string, at: number): Promise<boolean> {
    const revoked = await this.db.query("select 1 from revoked_sessions where sid = $1", [sid]);
    if (revoked.rows.length) return false;
    return (await this.matching(who)).every((r) => r.active && !r.deleted && !(r.sessions_after && at < r.sessions_after.getTime()));
  }

  /** Sign-out: this session only, remembered until it would have expired anyway. */
  async revokeSession(sid: string, expiresAt: Date) {
    await this.db.query("delete from revoked_sessions where expires_at < now()");
    await this.db.query("insert into revoked_sessions (sid, expires_at) values ($1, $2) on conflict do nothing", [sid, expiresAt]);
  }

  /** Admin: every session `user` (a sub or a userName) holds now is revoked; they can sign in again. */
  async revokeUser(admin: User, user: string) {
    if (!isAdmin(admin)) throw new Forbidden("only admins revoke sessions");
    const at = new Date();
    const who = { sub: user, names: [] };
    const updated = await this.db.query<{ id: string }>(`update users set sessions_after = $3, updated_at = now() where ${MATCH} returning id`, [
      who.sub,
      JSON.stringify(keys(who)),
      at,
    ]);
    if (!updated.rows.length) await this.db.query("insert into users (id, sessions_after) values ($1, $2)", [user, at]);
    await audit(this.db, admin, "revoke_sessions", "user", user);
    return { user, sessions_revoked_at: at.toISOString() };
  }

  // SCIM 2.0 Users (scim.ts): the IdP provisions and deprovisions here.

  async list(filter?: { attr: "userName" | "externalId" | "id"; value: string }): Promise<UserRow[]> {
    const where = filter
      ? { userName: "lower(user_name) = lower($1)", externalId: "external_id = $1", id: "id = $1" }[filter.attr]
      : "user_name is not null";
    const { rows } = await this.db.query<UserRow>(`select * from users where not deleted and ${where} order by created_at, id`, filter ? [filter.value] : []);
    return rows;
  }

  async get(id: string): Promise<UserRow> {
    const r = (await this.db.query<UserRow>("select * from users where id = $1 and not deleted", [id])).rows[0];
    if (!r) throw new NotFound(`no user ${JSON.stringify(id)}`);
    return r;
  }

  async create(u: { userName: string; externalId?: string | undefined; displayName?: string | undefined; active?: boolean | undefined }) {
    const taken = (await this.db.query<UserRow>("select * from users where lower(user_name) = lower($1)", [u.userName])).rows[0];
    if (taken && !taken.deleted) throw new Conflict(`userName ${JSON.stringify(u.userName)} exists`);
    // provisioned again after a delete: the new user replaces it, sessions from before stay revoked
    if (taken) await this.db.query("delete from users where id = $1", [taken.id]);
    const id = randomUUID();
    await this.db.query(
      "insert into users (id, user_name, external_id, display_name, active, sessions_after) values ($1, $2, $3, $4, $5, $6)",
      [id, u.userName, u.externalId ?? null, u.displayName ?? null, u.active ?? true, taken?.sessions_after ?? null],
    );
    await audit(this.db, SCIM, "scim_create", "user", id, { userName: u.userName, active: u.active ?? true });
    return this.get(id);
  }

  /** Set some attributes; turning `active` off revokes every session. */
  async update(id: string, u: { userName?: string | undefined; externalId?: string | undefined; displayName?: string | undefined; active?: boolean | undefined }) {
    const r = await this.get(id);
    const active = u.active ?? r.active;
    await this.db.query(
      `update users set user_name = $2, external_id = $3, display_name = $4, active = $5,
       sessions_after = case when $5 then sessions_after else now() end, updated_at = now() where id = $1`,
      [id, u.userName ?? r.user_name, u.externalId ?? r.external_id, u.displayName ?? r.display_name, active],
    );
    const changed = Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined));
    await audit(this.db, SCIM, active === r.active ? "scim_update" : active ? "scim_activate" : "scim_deactivate", "user", id, { userName: u.userName ?? r.user_name, ...changed });
    return this.get(id);
  }

  /** Deleted for SCIM (404 from now on), still blocked here. */
  async remove(id: string) {
    const r = await this.get(id);
    await this.db.query("update users set active = false, deleted = true, sessions_after = now(), updated_at = now() where id = $1", [id]);
    await audit(this.db, SCIM, "scim_delete", "user", id, { userName: r.user_name });
  }
}
