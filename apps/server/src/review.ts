import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { ROLES, type Decks, type Role } from "./decks.ts";
import { isAdmin } from "./models.ts";
import { Forbidden, type PackRow, type User } from "./packs.ts";
import { audit } from "./shares.ts";

/** Review gates, both opt-in or soft so a consultant is never blocked the night before a pitch.

Approval (M9): a pack whose pack.yaml sets `approval: true` gives its decks a status, draft →
in_review → approved; `approval: [external, marketing]` only the decks of those types (a deck's
`kind`, set by an editor with set_deck_kind; the types offered: pack.yaml `deck_kinds`, else
internal, external, marketing). The deck's owner or an editor requests the review (and may withdraw it);
the approver is the pack's owner (who published it) or an admin (CALQUE_ADMIN_TEAM), and needs at
least view access to the deck, so the deck is shared with them to be reviewed. Approving or sending
back ("changes requested", back to draft) is theirs. A new version of an approved deck sends it back
to draft (Decks.commit). A comment thread of type "required" blocks approving until it is resolved;
a "suggestion" never does. Approval never gates an export. Packs without the flag: no status at all.

Export gate (M18): export_pptx always exports; on a version with lint ERRORs it records who
exported it, the error count and the reason they gave (audit "export_with_errors"). The web
asks for that reason before exporting; the MCP tool description asks the model to. */

export type Approval = "draft" | "in_review" | "approved";

const rank = (r: Role) => ROLES.indexOf(r);

/** The deck types offered when a pack lists none (`deck_kinds` in its pack.yaml). */
export const DECK_KINDS = ["internal", "external", "marketing"];

/** Pack `dir`'s approval setting: every deck (`approval: true`), the decks of some types (a list),
or none; and the deck types it offers. */
export async function approvalConfig(dir: string): Promise<{ approval: "all" | string[]; kinds: string[] }> {
  const m = parse(await readFile(join(dir, "pack.yaml"), "utf8")) as { approval?: unknown; deck_kinds?: unknown } | null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);
  const approval = m?.approval === true ? "all" : strings(m?.approval);
  const listed = strings(m?.deck_kinds);
  return { approval, kinds: [...new Set([...(listed.length ? listed : DECK_KINDS), ...(approval === "all" ? [] : approval)])] };
}

/** Whether pack `dir` puts a deck of type `kind` through approval; no `kind`: whether it puts any. */
export async function approvalOn(dir: string, kind?: string | null): Promise<boolean> {
  const { approval } = await approvalConfig(dir);
  if (approval === "all") return true;
  return kind === undefined ? approval.length > 0 : !!kind && approval.includes(kind);
}

/** The ids of deck `id`'s open required comment threads: they block approval. */
async function blocking(decks: Decks, id: string): Promise<number[]> {
  const { rows } = await decks.db.query<{ id: number }>(
    "select id from comments where deck_id = $1 and parent_id is null and type = 'required' and status = 'open' order by id",
    [id],
  );
  return rows.map((r) => r.id);
}

/** Set deck `id`'s type (an editor), one its pack offers; null clears it. Whether it needs approval
follows (approvalOf); its status is kept. */
export async function setKind(decks: Decks, user: User, id: string, kind: string | null) {
  const deck = await decks.deck(user, id, "editor");
  const { kinds } = await approvalConfig(deck.packDir);
  if (kind !== null && !kinds.includes(kind)) throw new Error(`deck type ${JSON.stringify(kind)} is not one of pack ${deck.pack_id}'s: ${kinds.join(", ")}`);
  await decks.db.query("update decks set kind = $2 where id = $1", [id, kind]);
  await audit(decks.db, id, user, "kind", { from: deck.kind, to: kind });
  return { deck_id: id, kind, approval: await approvalOn(deck.packDir, kind) };
}

async function approver(decks: Decks, user: User, packId: string): Promise<boolean> {
  if (user.anonymous) return false;
  if (isAdmin(user)) return true;
  const { rows } = await decks.db.query<PackRow>("select * from packs where id = $1", [packId]);
  return !!rows[0]?.owner && rows[0].owner === user.id;
}

/** Deck `id`'s approval as `user` sees it: off, or its status and what they may do with it. */
export async function approvalOf(decks: Decks, user: User, id: string) {
  const deck = await decks.deck(user, id, "viewer");
  if (!(await approvalOn(deck.packDir, deck.kind))) return { enabled: false as const };
  const edits = rank(deck.role) >= rank("editor");
  const approves = await approver(decks, user, deck.pack_id);
  const status = deck.approval;
  const required = await blocking(decks, id);
  return {
    enabled: true as const,
    status,
    can_request: edits && status === "draft",
    can_withdraw: edits && status !== "draft",
    can_approve: approves && status === "in_review" && !required.length,
    /** open required comments: approving waits until they are resolved */
    blocking: required,
  };
}

/** Move deck `id` to approval status `to`: request (draft → in_review: an editor), approve
(in_review → approved: the approver), send back or withdraw (→ draft: the approver, or an editor). */
export async function setApproval(decks: Decks, user: User, id: string, to: Approval, note?: string) {
  const deck = await decks.deck(user, id, "viewer");
  if (!(await approvalOn(deck.packDir, deck.kind)))
    throw new Error(`approval is off for this deck: pack ${deck.pack_id}'s pack.yaml sets no \`approval: true\`, nor lists its type (${deck.kind ?? "none"}) under \`approval\``);
  const from = deck.approval;
  if (from === to) throw new Error(`deck ${id} is already ${to}`);
  const edits = rank(deck.role) >= rank("editor");
  const approves = await approver(decks, user, deck.pack_id);
  const ok =
    (to === "in_review" && from === "draft" && edits) ||
    (to === "approved" && from === "in_review" && approves) ||
    (to === "draft" && (edits || approves));
  const required = to === "approved" ? await blocking(decks, id) : [];
  if (ok && required.length) throw new Forbidden(`cannot approve deck ${id}: required comment(s) ${required.join(", ")} still open, resolve them first`);
  if (!ok) {
    const who = to === "approved" ? "the pack owner or an admin approves" : to === "in_review" ? "an editor requests a review of a draft" : "an editor or the approver";
    throw new Forbidden(`cannot move deck ${id} from ${from} to ${to}: ${who}`);
  }
  const { rows } = await decks.db.query("update decks set approval = $3 where id = $1 and approval = $2 returning id", [id, from, to]);
  if (!rows.length) throw new Error(`deck ${id} changed status meanwhile: reopen it and retry`);
  await audit(decks.db, id, user, "approval", { from, to, version: deck.head, ...(note ? { note } : {}) });
  return { deck_id: id, approval: to, from, version: deck.head };
}

/** Record an export of a version with lint ERRORs (the soft gate): who, how many, and why. */
export async function recordExport(decks: Decks, user: User, id: string, version: number, errors: number, reason?: string) {
  if (!errors) return;
  await audit(decks.db, id, user, "export_with_errors", { version, errors, reason: reason?.trim() || null });
}

