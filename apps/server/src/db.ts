import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

const SCHEMA = `
create table if not exists packs (
  id text primary key,
  dir text not null,
  visibility text not null default 'team' check (visibility in ('workspace', 'team')),
  teams jsonb not null default '[]',
  owner text
);
alter table packs add column if not exists version int not null default 1;
alter table packs add column if not exists archived boolean not null default false;
create table if not exists pack_versions (
  pack_id text not null references packs(id),
  version int not null,
  dir text not null,
  note text not null,
  author text,
  created_at timestamptz not null default now(),
  primary key (pack_id, version)
);
create table if not exists decks (
  id uuid primary key,
  pack_id text not null references packs(id),
  owner text not null,
  title text not null,
  head int not null,
  created_at timestamptz not null default now()
);
alter table decks add column if not exists pack_version int;
-- sharing: one share link per deck (/decks/:id?k=<link_key>) and who it opens for (shares.ts)
alter table decks add column if not exists general_access text not null default 'private' check (general_access in ('private', 'workspace', 'anyone'));
alter table decks add column if not exists general_role text not null default 'viewer' check (general_role in ('viewer', 'commenter'));
alter table decks add column if not exists link_key text not null default replace(gen_random_uuid()::text, '-', '');
create table if not exists deck_versions (
  deck_id uuid not null references decks(id),
  version int not null,
  spec jsonb not null,
  note text not null,
  author text not null,
  undo_to int,
  created_at timestamptz not null default now(),
  primary key (deck_id, version)
);
create table if not exists comments (
  id serial primary key,
  deck_id uuid not null references decks(id),
  version int not null,
  slide_id text not null,
  shape_id int,
  text text not null,
  author text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now()
);
-- review (review.ts): comment threads, authors' display names, opt-in approval status
alter table comments add column if not exists parent_id int references comments(id);
alter table comments add column if not exists author_name text;
alter table deck_versions add column if not exists author_name text;
alter table decks add column if not exists approval text not null default 'draft' check (approval in ('draft', 'in_review', 'approved'));
create table if not exists models (
  id text primary key,
  provider text not null,
  model text not null,
  base_url text,
  api_key text,
  is_default boolean not null default false,
  updated_by text not null,
  updated_at timestamptz not null default now()
);
-- label: tells two configs of one model apart; options: provider settings (JSON); headers: sealed JSON
alter table models add column if not exists label text;
alter table models add column if not exists options text;
alter table models add column if not exists headers text;
create table if not exists files (
  id uuid primary key,
  owner text not null,
  name text not null,
  size bigint not null,
  type text not null,
  created_at timestamptz not null default now()
);
create table if not exists deck_shares (
  deck_id uuid not null references decks(id),
  principal_type text not null check (principal_type in ('user', 'team')),
  principal text not null,
  role text not null check (role in ('viewer', 'commenter', 'editor')),
  granted_by text not null,
  created_at timestamptz not null default now(),
  primary key (deck_id, principal_type, principal)
);
-- audit.ts: who did what, when; no foreign key, a deleted deck's history stays
create table if not exists audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  target_type text not null,
  target_id text,
  detail jsonb not null default '{}'
);
create index if not exists audit_target on audit (target_type, target_id);
-- the sharing-only deck_audit, folded into audit
do $$ begin
  if to_regclass('deck_audit') is not null then
    insert into audit (at, actor, action, target_type, target_id, detail)
      select created_at, actor, action, 'deck', deck_id::text, detail from deck_audit order by id;
    drop table deck_audit;
  end if;
end $$;
-- replaced by the deck's share link and general access
drop table if exists deck_links;
delete from deck_shares where principal_type not in ('user', 'team');
create unique index if not exists one_default_model on models (is_default) where is_default;
-- a deck's name set by rename_deck; null: the title of its current DeckSpec
alter table decks add column if not exists name text;
-- the pack /new preselects (CALQUE_DEFAULT_PACK, or an admin's choice)
alter table packs add column if not exists is_default boolean not null default false;
create unique index if not exists one_default_pack on packs (is_default) where is_default;`;

/** Postgres when `url` is a postgres:// URL, else embedded PGlite (a data dir, or in memory). */
export async function openDb(url = process.env.DATABASE_URL): Promise<Db> {
  if (url?.startsWith("postgres")) {
    const pool = new pg.Pool({ connectionString: url });
    await pool.query(SCHEMA);
    return { query: (sql, params) => pool.query(sql, params) as never, close: () => pool.end() };
  }
  const unlock = url && !url.startsWith("memory://") ? lock(`${url}.lock`) : () => {};
  const lite = await PGlite.create(url);
  await lite.exec(SCHEMA);
  return {
    query: (sql, params) => lite.query(sql, params),
    close: () => lite.close().finally(unlock),
  };
}

export class DbLocked extends Error {}

/** PGlite has no lock of its own: two processes on one data dir corrupt it. One owner per dir. */
function lock(path: string): () => void {
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      const unlock = () => rmSync(path, { force: true });
      process.once("exit", unlock);
      return unlock;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const pid = Number(readFileSync(path, "utf8"));
    if (alive(pid)) {
      throw new DbLocked(
        `${path.slice(0, -5)} is in use by process ${pid}: one Calque server owns it. ` +
          "Connect to that server (stdio.ts does), stop it, or set CALQUE_DATA / DATABASE_URL elsewhere.",
      );
    }
    rmSync(path, { force: true }); // stale: its process is gone
  }
}

function alive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
