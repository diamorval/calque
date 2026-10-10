import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { ROLES, type Decks, type Role } from "./decks.ts";
import { isAdmin } from "./models.ts";
import { Forbidden, type PackRow, type User } from "./packs.ts";
import { audit } from "./shares.ts";

/** Review gates, both opt-in or soft so a consultant is never blocked the night before a pitch.

Approval (M9): a pack whose pack.yaml sets `approval: true` gives its decks a status, draft →
in_review → approved. The deck's owner or an editor requests the review (and may withdraw it);
the approver is the pack's owner (who published it) or an admin (CALQUE_ADMIN_TEAM), and needs at
least view access to the deck, so the deck is shared with them to be reviewed. Approving or sending
back ("changes requested", back to draft) is theirs. A new version of an approved deck sends it back
to draft (Decks.commit). Approval never gates an export. Packs without the flag: no status at all.

Export gate (M18): export_pptx always exports; on a version with lint ERRORs it records who
exported it, the error count and the reason they gave (audit "export_with_errors"). The web
asks for that reason before exporting; the MCP tool description asks the model to. */

export type Approval = "draft" | "in_review" | "approved";

const rank = (r: Role) => ROLES.indexOf(r);

/** Whether pack `dir` turns the approval workflow on (`approval: true` in its pack.yaml). */
export async function approvalOn(dir: string): Promise<boolean> {
  const m = parse(await readFile(join(dir, "pack.yaml"), "utf8")) as { approval?: unknown } | null;
  return m?.approval === true;
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
  if (!(await approvalOn(deck.packDir))) return { enabled: false as const };
  const edits = rank(deck.role) >= rank("editor");
  const approves = await approver(decks, user, deck.pack_id);
  const status = deck.approval;
  return {
    enabled: true as const,
    status,
    can_request: edits && status === "draft",
    can_withdraw: edits && status !== "draft",
    can_approve: approves && status === "in_review",
  };
}

/** Move deck `id` to approval status `to`: request (draft → in_review: an editor), approve
(in_review → approved: the approver), send back or withdraw (→ draft: the approver, or an editor). */
export async function setApproval(decks: Decks, user: User, id: string, to: Approval, note?: string) {
  const deck = await decks.deck(user, id, "viewer");
  if (!(await approvalOn(deck.packDir))) throw new Error(`approval is off for pack ${deck.pack_id}: set \`approval: true\` in its pack.yaml`);
  const from = deck.approval;
  if (from === to) throw new Error(`deck ${id} is already ${to}`);
  const edits = rank(deck.role) >= rank("editor");
  const approves = await approver(decks, user, deck.pack_id);
  const ok =
    (to === "in_review" && from === "draft" && edits) ||
    (to === "approved" && from === "in_review" && approves) ||
    (to === "draft" && (edits || approves));
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

