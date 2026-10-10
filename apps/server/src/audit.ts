import type { Db } from "./db.ts";
import type { User } from "./packs.ts";

/** The audit log: who did what to which deck, pack, model or session, and when. Append only, never
the content itself (no DeckSpec, prompt or key): ids, titles, versions and notes. Rows outlive what
they name, so a deleted deck's history stays. Admins read it (GET /api/admin/audit). */

export type Target = "deck" | "pack" | "model" | "user" | "library" | "library_image";

export interface AuditRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  target_type: Target;
  target_id: string | null;
  detail: Record<string, unknown>;
}

/** Record `action` by `actor` (a user, or a system actor such as "retention") on a target. */
export async function audit(db: Db, actor: User | string, action: string, target: Target, id: string | null, detail: Record<string, unknown> = {}) {
  const who = typeof actor === "string" ? actor : actor.anonymous ? "guest" : actor.id;
  await db.query("insert into audit (actor, action, target_type, target_id, detail) values ($1, $2, $3, $4, $5)", [
    who,
    action,
    target,
    id,
    JSON.stringify(detail),
  ]);
}

export interface AuditFilter {
  actor?: string | undefined;
  action?: string | undefined;
  target_type?: string | undefined;
  target_id?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  limit?: number | undefined;
}

/** Newest first, every filter optional; at most 1000 rows. */
export async function auditLog(db: Db, f: AuditFilter = {}): Promise<AuditRow[]> {
  const { rows } = await db.query<AuditRow>(
    `select * from audit where ($1::text is null or actor = $1) and ($2::text is null or action = $2)
       and ($3::text is null or target_type = $3) and ($4::text is null or target_id = $4)
       and ($5::timestamptz is null or at >= $5) and ($6::timestamptz is null or at < $6)
     order by id desc limit $7`,
    [f.actor ?? null, f.action ?? null, f.target_type ?? null, f.target_id ?? null, f.since ?? null, f.until ?? null, Math.min(f.limit ?? 200, 1000)],
  );
  return rows;
}
