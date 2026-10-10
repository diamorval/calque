import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Access } from "./access.ts";
import { openDb } from "./db.ts";
import { Decks } from "./decks.ts";
import { REPO } from "./engine.ts";
import { Models } from "./models.ts";
import { seedPacks } from "./packs.ts";
import type { App } from "./tools.ts";

/** CALQUE_DATA: decks, renders, uploads, imported packs (and the PGlite database without DATABASE_URL). */
export async function createApp(opts: { data?: string; db?: string; publicUrl?: string } = {}): Promise<App> {
  // with sign-in on, a key minted in the data dir rotates with an ephemeral volume: every sealed
  // model key and session would be lost on restart
  if (!process.env.CALQUE_SECRET && process.env.CALQUE_OIDC_ISSUER)
    throw new Error("CALQUE_SECRET is not set: with CALQUE_OIDC_ISSUER on, set it to a stable random key (openssl rand -base64 32); it seals model API keys and sessions");
  const data = opts.data ?? process.env.CALQUE_DATA ?? join(REPO, ".data");
  mkdirSync(data, { recursive: true });
  const db = await openDb(opts.db ?? process.env.DATABASE_URL ?? join(data, "pg"));
  await seedPacks(db);
  const port = process.env.PORT ?? "8787";
  const publicUrl = (opts.publicUrl ?? process.env.CALQUE_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
  const secret = process.env.CALQUE_SECRET ?? localSecret(data);
  const models = new Models(db, secret);
  await models.seedFromEnv();
  return { db, decks: new Decks(db, data), models, access: new Access(db), data, publicUrl, secret };
}

/** Dev only: the key sealing model API keys, kept in the data dir. Set CALQUE_SECRET in production. */
function localSecret(data: string): string {
  const path = join(data, "secret");
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString("base64"), { mode: 0o600 });
  return readFileSync(path, "utf8");
}
