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
create table if not exists decks (
  id uuid primary key,
  pack_id text not null references packs(id),
  owner text not null,
  title text not null,
  head int not null,
  created_at timestamptz not null default now()
);
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
create unique index if not exists one_default_model on models (is_default) where is_default;`;

/** Postgres when `url` is a postgres:// URL, else embedded PGlite (a data dir, or in memory). */
export async function openDb(url = process.env.DATABASE_URL): Promise<Db> {
  if (url?.startsWith("postgres")) {
    const pool = new pg.Pool({ connectionString: url });
    await pool.query(SCHEMA);
    return { query: (sql, params) => pool.query(sql, params) as never, close: () => pool.end() };
  }
  const lite = await PGlite.create(url);
  await lite.exec(SCHEMA);
  return { query: (sql, params) => lite.query(sql, params), close: () => lite.close() };
}
