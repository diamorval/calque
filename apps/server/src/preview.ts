import { createHmac, timingSafeEqual } from "node:crypto";
import { ROLES, type Role } from "./decks.ts";
import type { User } from "./packs.ts";

/** Guest links: a signed, expiring token (`?t=`) that gives a role on one deck to whoever holds it,
as a guest of whoever minted it. Each link is a `deck_links` row: the token is checked here
(signature, deck, expiry), the row (not revoked) by `access` in decks.ts. Minted for the caller
wherever a tool returns a preview, PNG or download URL (one reused `auto` link per user and deck);
the MCP App inside Claude loads its PNGs with it, where no web session exists. The deck's owner
also mints links on purpose (create_link). */
export const PREVIEW_TTL_S = 7 * 24 * 3600;
/** What an automatic preview link lets its holder do: read and comment. */
export const PREVIEW_ROLE: Role = "commenter";

/** A `deck_links` row. */
export interface Link {
  id: string;
  deck_id: string;
  role: Role;
  label: string;
  created_by: string;
  teams: string[]; // the minter's teams, for pack visibility and team grants
  auto: boolean;
  expires_at: string | Date;
  revoked_at?: string | Date | null;
  created_at?: string | Date;
}

interface Claims {
  k: string; // link id
  d: string; // deck id
  r: Role;
  o: string; // minter id
  t: string[]; // minter's teams
  l: string; // label, for comment attribution
  e: number; // expiry, unix seconds
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (secret: string, body: string) => createHmac("sha256", `preview:${secret}`).update(body).digest();

/** The token of a stored link: the same for the same row, so URLs (and cached PNGs) stay stable. */
export function linkToken(secret: string, link: Link): string {
  const e = Math.floor(new Date(link.expires_at).getTime() / 1000);
  const claims: Claims = { k: link.id, d: link.deck_id, r: link.role, o: link.created_by, t: link.teams, l: link.label, e };
  const body = b64(JSON.stringify(claims));
  return `${body}.${b64(mac(secret, body))}`;
}

/** The guest a valid token for `deckId` stands for; undefined if tampered, expired or for another
deck. Whether its link still exists is checked against the database on use. */
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
  if (!c.k || c.d !== deckId || !(c.e * 1000 > now) || !ROLES.includes(c.r)) return undefined;
  return { id: c.o, teams: c.t, guest: { deck: c.d, role: c.r, label: c.l, token, link: c.k } };
}
