import { createHmac, timingSafeEqual } from "node:crypto";
import type { User } from "./packs.ts";

/** Per-user URL tokens (`?t=`): what lets tool results (preview_url, image_url, download_url) and
the MCP App inside Claude, where no web session exists, open a deck as the user they were minted
for. A token names that user (id, teams) and one deck, signed (HMAC with the server secret), for
24 h. It is no grant: every request re-checks the user's current access (`access` in decks.ts), so
it dies with their access and never gives more than they have. Internal plumbing: the link people
copy is the deck's share link (`?k=`, see shares.ts). */
export const TOKEN_TTL_S = 24 * 3600;
const HOUR = 3600;

interface Claims {
  u: string; // user id
  n?: string; // user name
  t: string[]; // user's teams
  d: string; // deck id
  e: number; // expiry, unix seconds
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (secret: string, body: string) => createHmac("sha256", `deck-token:${secret}`).update(body).digest();

/** `user`'s token for deck `deckId`. Its expiry is rounded up to the hour, so URLs (and cached
PNGs) stay the same for an hour. */
export function userToken(secret: string, user: User, deckId: string, now = Date.now()): string {
  const e = Math.ceil((now / 1000 + TOKEN_TTL_S) / HOUR) * HOUR;
  const claims: Claims = { u: user.id, ...(user.name ? { n: user.name } : {}), t: user.teams, d: deckId, e };
  const body = b64(JSON.stringify(claims));
  return `${body}.${b64(mac(secret, body))}`;
}

/** The user a valid token for `deckId` stands for; undefined if tampered, expired or for another
deck. Their access is checked on use, like any user's. */
export function tokenUser(secret: string, token: string, deckId: string, now = Date.now()): User | undefined {
  const [body = "", sig = ""] = token.split(".");
  const want = mac(secret, body);
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
  let c: Claims;
  try {
    c = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!c.u || c.d !== deckId || !(c.e * 1000 > now) || !Array.isArray(c.t)) return undefined;
  return { id: c.u, ...(c.n ? { name: c.n } : {}), teams: c.t, token };
}
