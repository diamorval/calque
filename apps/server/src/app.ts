import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { Decks } from "./decks.ts";
import { REPO } from "./engine.ts";
import { seedPacks } from "./packs.ts";
import type { App } from "./tools.ts";

/** CALQUE_DATA: decks, renders, uploads, imported packs (and the PGlite database without DATABASE_URL). */
export async function createApp(opts: { data?: string; db?: string; publicUrl?: string } = {}): Promise<App> {
  const data = opts.data ?? process.env.CALQUE_DATA ?? join(REPO, ".data");
  mkdirSync(data, { recursive: true });
  const db = await openDb(opts.db ?? process.env.DATABASE_URL ?? join(data, "pg"));
  await seedPacks(db);
  const port = process.env.PORT ?? "8787";
  const publicUrl = (opts.publicUrl ?? process.env.CALQUE_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
  return { db, decks: new Decks(db, data), data, publicUrl };
}
