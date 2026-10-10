import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { audit } from "./audit.ts";
import { uploadPath } from "./files.ts";
import type { User } from "./packs.ts";
import type { App } from "./tools.ts";

/** CALQUE_RETENTION_DAYS (off by default): decks untouched for that many days are deleted like a
deck the owner deletes, and uploads older than that are removed. The audit log is kept. */
export const RETENTION: User = { id: "retention", teams: [], local: true };

export function retentionDays(env = process.env): number | undefined {
  const raw = env.CALQUE_RETENTION_DAYS;
  if (!raw) return undefined;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`CALQUE_RETENTION_DAYS: a number of days above 0, not ${JSON.stringify(raw)}`);
  return days;
}

export async function purge(app: App, days: number, now = new Date()) {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const { rows } = await app.db.query<{ id: string }>(
    // a slide library's entries (library.ts) stay until removed from the library
    `select d.id from decks d join deck_versions v on v.deck_id = d.id and v.version = d.head
     where v.created_at < $1 and d.owner not like 'library:%'`,
    [cutoff.toISOString()],
  );
  for (const { id } of rows) await app.decks.remove(RETENTION, id);
  // an old upload still placed by a deck that stays (`file:<id>` in its current version) is kept
  const files = await app.db.query<{ id: string }>(
    `delete from files f where f.created_at < $1 and not exists (select 1 from decks d
       join deck_versions v on v.deck_id = d.id and v.version = d.head where strpos(v.spec::text, 'file:' || f.id::text) > 0)
     returning id`,
    [cutoff.toISOString()],
  );
  for (const { id } of files.rows) await rm(uploadPath(app.data, id), { force: true });
  // inline (base64) imports leave a file under uploads/ with no row: removed by age
  const kept = new Set((await app.db.query<{ id: string }>("select id from files")).rows.map((r) => r.id));
  let stray = 0;
  const dir = join(app.data, "uploads");
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (kept.has(name)) continue;
    const path = join(dir, name);
    const s = await stat(path).catch(() => undefined);
    if (s?.isFile() && s.mtime < cutoff) {
      await rm(path, { force: true });
      stray++;
    }
  }
  const out = { decks: rows.length, files: files.rows.length + stray };
  if (out.decks || out.files) await audit(app.db, RETENTION, "purge", "deck", null, { days, ...out });
  return out;
}
