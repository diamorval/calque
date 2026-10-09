import { createHmac, timingSafeEqual } from "node:crypto";
import { ROLES, type Role } from "./decks.ts";
import type { User } from "./packs.ts";

/** Preview links: a signed, expiring token (`?t=`) that gives a role on one deck to whoever holds
it, as a guest of the deck's owner. Minted for the owner wherever a tool returns a preview, PNG or
download URL; the MCP App inside Claude loads its PNGs with it, where no web session exists. */
export const PREVIEW_TTL_S = 7 * 24 * 3600;
/** What a preview link lets its holder do: read and comment. */
export const PREVIEW_ROLE: Role = "commenter";
const HOUR = 3600;

interface Claims {
  d: string; // deck id
  r: Role;
  o: string; // owner id
  t: string[]; // owner's teams, for pack visibility
  l: string; // label, for comment attribution
  e: number; // expiry, unix seconds
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (secret: string, body: string) => createHmac("sha256", `preview:${secret}`).update(body).digest();

export function previewToken(secret: string, user: User, deckId: string, now = Date.now()): string {
  // a guest passes its own link on: never extend it
  if (user.guest) return user.guest.token;
  // expiry rounded up to the hour: URLs (and cached PNGs) stay stable between calls
  const e = Math.ceil((now / 1000 + PREVIEW_TTL_S) / HOUR) * HOUR;
  const claims: Claims = { d: deckId, r: PREVIEW_ROLE, o: user.id, t: user.teams, l: `link from ${user.name ?? user.id}`, e };
  const body = b64(JSON.stringify(claims));
  return `${body}.${b64(mac(secret, body))}`;
}

/** The guest a valid token for `deckId` stands for; undefined if tampered, expired or for another deck. */
export function previewGuest(secret: string, token: string, deckId: string, now = Date.now()): User | undefined {
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
  if (c.d !== deckId || !(c.e * 1000 > now) || !ROLES.includes(c.r)) return undefined;
  return { id: c.o, teams: c.t, guest: { deck: c.d, role: c.r, label: c.l, token } };
}
