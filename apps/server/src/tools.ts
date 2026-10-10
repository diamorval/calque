import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DeckSpec, PatchOp, Slide } from "@calque/deckspec";
import { compliance } from "./compliance.ts";
import type { Access } from "./access.ts";
import { audit } from "./audit.ts";
import type { Db } from "./db.ts";
import type { Decks, Finding, Role } from "./decks.ts";
import { REPO } from "./engine.ts";
import { getFile, MAX_UPLOAD, TooLarge, uploadTicket } from "./files.ts";
import { libraryAdd, libraryApprove, libraryInsert, libraryList, libraryRemove } from "./library.ts";
import { fileName, type M365 } from "./m365.ts";
import type { Models } from "./models.ts";
import { importPack, listPacks, type User } from "./packs.ts";
import { packPortal } from "./portal.ts";
import { userToken } from "./preview.ts";
import { approvalOf, recordExport, setApproval } from "./review.ts";
import { resetLink, setGeneralAccess, share, shares, transfer, unshare } from "./shares.ts";

export interface App {
  db: Db;
  decks: Decks;
  models: Models;
  /** session revocation and SCIM deprovisioning */
  access: Access;
  data: string;
  /** seals model keys and web sessions */
  secret: string;
  publicUrl: string;
  /** Microsoft 365 (OneDrive, SharePoint), when CALQUE_M365_CLIENT_ID is set */
  m365?: M365 | undefined;
}

export interface Tool<S extends z.ZodObject = z.ZodObject> {
  title: string;
  description: string;
  input: S;
  /** Show the deck UI (MCP Apps) with this tool's result. */
  ui?: boolean;
  /** Called by the deck UI only, hidden from the model. */
  appOnly?: boolean;
  readOnly?: boolean;
  /** The least role on `deck_id` the caller needs, checked before the tool runs. */
  role?: Role;
  run(app: App, user: User, args: z.infer<S>): Promise<Record<string, unknown>>;
}

const tool = <S extends z.ZodObject>(t: Tool<S>) =>
  ({
    ...t,
    run: async (app, user, args) => {
      if (t.role) await app.decks.deck(user, (args as { deck_id: string }).deck_id, t.role);
      return t.run(app, user, args);
    },
  }) satisfies Tool<S> as unknown as Tool;

const deckId = z.string().describe("Deck id, as returned by create_deck or import_pptx.");
const version = z.number().int().min(1).optional().describe("A past version; default: the current one.");
const File = z
  .union([
    z.strictObject({ path: z.string().describe("Local path; only when the server runs on the user's machine (stdio).") }),
    z.strictObject({ file_id: z.string().describe("An uploaded file (POST /api/files, see upload_url).") }),
    z.strictObject({ base64: z.string(), name: z.string().optional() }),
  ])
  .describe("A .pptx file: an uploaded file_id (best for big files), a local path (stdio) or its content in base64.");

async function materialize(app: App, user: User, f: z.infer<typeof File>): Promise<string> {
  if ("path" in f) {
    if (!user.local) throw new Error("file paths are only read by a local (stdio) server: send base64");
    return f.path;
  }
  if ("file_id" in f) return (await getFile(app.db, app.data, user, f.file_id)).path;
  const bytes = Buffer.from(f.base64, "base64");
  if (bytes.length > MAX_UPLOAD) throw new TooLarge(`file over ${MAX_UPLOAD / 1024 / 1024} MB: upload it (upload_url) and pass its file_id`);
  const dir = join(app.data, "uploads");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.pptx`);
  await writeFile(path, bytes);
  return path;
}

/** The query that lets a tool result's URLs open the deck with no browser session: the share link
key the caller came with, else their per-user token (one they came with is passed on, never extended). */
const token = (app: App, user: User, id: string) =>
  user.key ? `k=${encodeURIComponent(user.key)}` : `t=${encodeURIComponent(user.token ?? userToken(app.secret, user, id))}`;
const links = (app: App, user: User, id: string) => ({ preview_url: `${app.publicUrl}/decks/${id}?${token(app, user, id)}` });
/** The deck's share link, the one people copy. */
const shareUrl = (app: App, id: string, key: string) => `${app.publicUrl}/decks/${id}?k=${encodeURIComponent(key)}`;

async function openDeck(app: App, user: User, id: string, v?: number, render = true) {
  const deck = await app.decks.deck(user, id, "viewer");
  const at = v ?? deck.head;
  const q = token(app, user, id);
  const spec = await app.decks.spec(id, at);
  const slides = render
    ? (await app.decks.render(user, id, at)).slides.map(({ id: sid, number, width_px, height_px, shapes }) => ({
        id: sid,
        number,
        image_url: `${app.publicUrl}/decks/${id}/slides/${number}.png?v=${at}&${q}`,
        width_px,
        height_px,
        shapes,
      }))
    : undefined;
  const threads = await app.decks.comments(user, id);
  return {
    deck_id: id,
    title: deck.title,
    pack_id: deck.pack_id,
    // the pack release the deck is on, and the pack's latest (update_pack_release moves it there)
    pack_version: deck.pack_version,
    pack_latest: deck.pack.version,
    role: deck.role,
    version: at,
    head: deck.head,
    versions: await app.decks.versions(id),
    spec,
    slides,
    open_comments: threads.filter((c) => c.status === "open"),
    resolved_comments: threads.filter((c) => c.status === "resolved"),
    approval: await approvalOf(app.decks, user, id),
    ...links(app, user, id),
  };
}

async function checklist(): Promise<string> {
  const md = await readFile(join(REPO, "core/workflows/review.md"), "utf8");
  return md.slice(md.indexOf("## Visual checklist")).split("\n## ")[0] ?? "";
}

const bySeverity = (fs: Finding[]) => ({
  ERROR: fs.filter((f) => f.severity === "ERROR"),
  WARN: fs.filter((f) => f.severity === "WARN"),
  NOTE: fs.filter((f) => f.severity === "NOTE"),
});

export const TOOLS = {
  list_packs: tool({
    title: "List brand packs",
    description: "Brand packs you can build on: id, name, languages, default language. Read pack://<id>/DESIGN.md and pack://<id>/template-map before building.",
    input: z.object({}),
    readOnly: true,
    run: async (app, user) => ({ packs: await listPacks(app.db, user) }),
  }),

  create_deck: tool({
    title: "Create deck",
    description:
      "Create a deck from a DeckSpec (validated: form follows message). The engine clones the pack's role slides and draws the rest; the result lists holes left as the pack's missing-value marker. Returns the deck id and a preview link.",
    input: z.object({ deck: DeckSpec, note: z.string().optional() }),
    ui: true,
    run: async (app, user, a) => {
      const r = await app.decks.create(user, a.deck, a.note ?? "create");
      return { ...r, ...links(app, user, r.deck_id) };
    },
  }),

  add_slides: tool({
    title: "Add slides",
    description: "Insert one or a few slides into a deck, without a narrative arc. `at` is the 0-based position (default: before the closing slide, else at the end).",
    input: z.object({ deck_id: deckId, slides: z.array(Slide).min(1), at: z.number().int().min(0).optional() }),
    ui: true,
    role: "editor",
    run: async (app, user, a) => {
      const deck = await app.decks.deck(user, a.deck_id, "editor");
      const spec = await app.decks.spec(a.deck_id, deck.head);
      const last = spec.slides.at(-1);
      const at = a.at ?? (last?.message_type === "closing" ? spec.slides.length - 1 : spec.slides.length);
      const ops = a.slides.map((slide, i) => ({ op: "insert_slide" as const, at: at + i, slide }));
      const r = await app.decks.patch(user, a.deck_id, ops, `add ${a.slides.length} slide(s)`);
      return { ...r, ...links(app, user, a.deck_id) };
    },
  }),

  copy_slides: tool({
    title: "Copy slides",
    description:
      "Copy slides from one deck into another (or the same) deck, as a new version of the target. Needs view access on the source and edit access on the target. Charts, diagrams and compositions copy to a deck on any pack (redrawn on its pack); template and imported slides only to a deck on the same pack. `at` is the 0-based position (default: before the closing slide, else at the end). `copied` maps source ids to the ids in the target.",
    input: z.object({
      from_deck: deckId.describe("The deck to copy from."),
      slides: z.array(z.string()).min(1).describe("Slide ids in the source deck, in the order to insert them."),
      deck_id: deckId.describe("The deck to copy into."),
      at: z.number().int().min(0).optional(),
      version: version.describe("A past version of the source deck; default: its current one."),
    }),
    ui: true,
    role: "editor",
    run: async (app, user, a) => {
      const r = await app.decks.copySlides(user, a.from_deck, a.slides, a.deck_id, a.at, a.version);
      return { ...r, ...links(app, user, a.deck_id) };
    },
  }),

  rebrand_deck: tool({
    title: "Re-brand deck",
    description:
      "Move a deck to another brand pack, as a new version (older versions stay on the old pack; restoring one moves the deck back). Charts, diagrams and compositions are redrawn on the new pack; cover, divider, closing and other template slides move to the new pack's slide for the same role, their text following the slot names (`unmapped` lists what did not follow and shows the missing-value marker). Imported slides cannot be re-branded: the call fails listing them unless `drop_imported` leaves them out. Lint the result.",
    input: z.object({
      deck_id: deckId,
      pack_id: z.string().describe("The pack to move the deck to."),
      drop_imported: z.boolean().default(false).describe("Leave out the imported slides, which cannot be re-branded."),
    }),
    ui: true,
    role: "editor",
    run: async (app, user, a) => {
      const r = await app.decks.rebrand(user, a.deck_id, a.pack_id, a.drop_imported);
      return { ...r, ...links(app, user, a.deck_id) };
    },
  }),

  update_pack_release: tool({
    title: "Update to the latest pack release",
    description:
      "Move a deck to the latest release of its brand pack, as a new version. A deck stays on the pack release it was made on (open_deck's `pack_version`; `pack_latest` is the newest) until this is called, so a brand change never alters a deck behind its author's back. With the same template the slides rebuild as they are; a new template moves template slides by role as rebrand_deck does (imported slides cannot follow unless `drop_imported` leaves them out). Lint the result.",
    input: z.object({
      deck_id: deckId,
      drop_imported: z.boolean().default(false).describe("Leave out the imported slides, if the new release changed the template."),
    }),
    ui: true,
    role: "editor",
    run: async (app, user, a) => {
      const r = await app.decks.updatePack(user, a.deck_id, a.drop_imported);
      return { ...r, ...links(app, user, a.deck_id) };
    },
  }),

  open_deck: tool({
    title: "Open deck",
    description:
      "A deck's DeckSpec, version history, rendered slides (PNG URL + shape map with shape_id and bbox), comment threads (open and resolved, with replies) and approval status.",
    input: z.object({ deck_id: deckId, version, render: z.boolean().default(true) }),
    ui: true,
    readOnly: true,
    role: "viewer",
    run: (app, user, a) => openDeck(app, user, a.deck_id, a.version, a.render),
  }),

  import_pptx: tool({
    title: "Import PPTX",
    description:
      "Import a PPTX to edit it in place: each slide becomes a clone of the file, edited by shape_id with patch_deck. With `deck_id`, the file (typically that deck exported and edited in PowerPoint) comes back as the next version of that deck: history and comments are kept, slides keep their ids, and charts, diagrams and compositions stay drawn with the text and data edits merged (set_params keeps working). The `import` report lists the slides kept drawn, those imported as clones, those demoted to clones (with why) and conflicts.",
    input: z.object({
      file: File,
      deck_id: deckId.optional().describe("Re-import into this existing deck as a new version."),
      pack_id: z.string().optional().describe("Pack of a new deck (required without deck_id)."),
      language: z.string().min(2).optional().describe("Deck language; required for a new deck."),
    }),
    ui: true,
    run: async (app, user, a) => {
      const file = await materialize(app, user, a.file);
      if (a.deck_id) {
        const r = await app.decks.reimport(user, a.deck_id, file, a.language);
        return { ...r, ...links(app, user, a.deck_id) };
      }
      if (!a.pack_id || !a.language) throw new Error("a new deck needs pack_id and language (or pass deck_id)");
      const r = await app.decks.importPptx(user, file, a.pack_id, a.language);
      return { ...r, ...links(app, user, r.deck_id) };
    },
  }),

  patch_deck: tool({
    title: "Patch deck",
    description:
      "Apply edit operations to a deck (new version). Text goes into cloned shapes by shape_id (`set`), drawn slides change via `set_params`. Pass the comment ids the patch answers in `resolves`.",
    input: z.object({
      deck_id: deckId,
      ops: z.array(PatchOp).min(1),
      note: z.string().optional().describe("What changed, for the version history."),
      resolves: z.array(z.number().int()).optional().describe("Comment ids this patch applies."),
    }),
    ui: true,
    role: "editor",
    run: async (app, user, a) => {
      const r = await app.decks.patch(user, a.deck_id, a.ops, a.note ?? "patch");
      const resolved = await app.decks.resolve(user, a.deck_id, a.resolves ?? []);
      return { ...r, resolved, ...links(app, user, a.deck_id) };
    },
  }),

  restore_version: tool({
    title: "Restore version",
    description: "Undo the last change, or go back to a given version. Either way it is a new version: nothing is lost.",
    input: z.object({ deck_id: deckId, version }),
    ui: true,
    role: "editor",
    run: async (app, user, a) => ({ ...(await app.decks.restore(user, a.deck_id, a.version)), ...links(app, user, a.deck_id) }),
  }),

  add_comment: tool({
    title: "Comment",
    description: "Comment on a slide, or on one shape of it (shape_id from the shape map); with parent_id, reply in that comment's thread.",
    input: z.object({
      deck_id: deckId,
      slide_id: z.string().optional(),
      shape_id: z.number().int().optional(),
      parent_id: z.number().int().optional().describe("The comment this replies to (a reply sits on its slide and shape)."),
      text: z.string().min(1),
    }),
    appOnly: true,
    role: "commenter",
    run: async (app, user, a) => ({ comment: await app.decks.addComment(user, a.deck_id, a) }),
  }),

  list_comments: tool({
    title: "List comments",
    description:
      "Comment threads left on the deck (in the preview or the in-chat UI), each anchored on a slide id and shape_id, with its status (open or resolved), author (id and author_name) and replies (read them: they refine the request). Apply them with patch_deck and pass their ids in `resolves`.",
    input: z.object({ deck_id: deckId, status: z.enum(["open", "resolved", "all"]).optional().default("open") }),
    readOnly: true,
    role: "viewer",
    run: async (app, user, a) => ({
      comments: await app.decks.comments(user, a.deck_id, a.status === "all" ? undefined : a.status),
      ...links(app, user, a.deck_id),
    }),
  }),

  resolve_comments: tool({
    title: "Resolve comments",
    description:
      "Resolve comment threads by id without editing the deck (a remark answered or dismissed), or reopen them with status 'open'. An editor resolves any thread, a commenter only their own. Applied comments are resolved by patch_deck's `resolves`.",
    input: z.object({
      deck_id: deckId,
      comment_ids: z.array(z.number().int()).min(1),
      status: z.enum(["resolved", "open"]).default("resolved"),
    }),
    role: "commenter",
    run: async (app, user, a) => ({ status: a.status, comment_ids: await app.decks.resolve(user, a.deck_id, a.comment_ids, a.status) }),
  }),

  lint_deck: tool({
    title: "Lint deck",
    description: "Lint the built PPTX against its pack: off-pack font or colour, placeholder left, page numbers, geometry, overflow, anti-slop. ERRORs must be fixed before delivery.",
    input: z.object({ deck_id: deckId, version }),
    readOnly: true,
    role: "viewer",
    run: async (app, user, a) => {
      const r = await app.decks.lint(user, a.deck_id, a.version);
      return { version: r.version, errors: r.findings.filter((f) => f.severity === "ERROR").length, findings: r.findings };
    },
  }),

  review_deck: tool({
    title: "Review deck",
    description:
      "Audit a deck: lint, render, and a report by severity that separates safe auto-fixes from judgment calls, plus the visual checklist to run on the slide images. Report first; call again with apply_safe_fixes once the user approves, which applies the safe fixes as a new version and re-verifies.",
    input: z.object({ deck_id: deckId, apply_safe_fixes: z.boolean().default(false) }),
    role: "editor",
    run: async (app, user, a) => {
      const before = await app.decks.lint(user, a.deck_id);
      const spec = await app.decks.spec(a.deck_id, before.version);
      // safe fixes edit the imported file; a generated deck is redrawn from its DeckSpec instead
      const safe = (f: Finding) => !!spec.base && f.severity === "ERROR" && before.safe_checks.includes(f.check);
      const report = {
        version: before.version,
        ...bySeverity(before.findings),
        safe_fixes: before.findings.filter(safe),
        judgment_calls: before.findings.filter((f) => f.severity !== "NOTE" && !safe(f)),
      };
      let applied: unknown[] = [];
      let after = before;
      if (a.apply_safe_fixes && report.safe_fixes.length) {
        const fixed = await app.decks.fixBase(user, a.deck_id);
        applied = fixed.applied;
        after = await app.decks.lint(user, a.deck_id, fixed.version);
      }
      const opened = await openDeck(app, user, a.deck_id, after.version);
      return {
        report,
        applied,
        after: a.apply_safe_fixes
          ? { version: after.version, errors: after.findings.filter((f) => f.severity === "ERROR") }
          : undefined,
        slides: opened.slides?.map((s) => ({ id: s.id, number: s.number, image_url: s.image_url })),
        visual_checklist: await checklist(),
        ...links(app, user, a.deck_id),
      };
    },
  }),

  export_pptx: tool({
    title: "Export PPTX",
    description:
      "Download link for the deck's PPTX (and its local path on a stdio server). It always exports; when the version has lint ERRORs, ask the user why it goes out anyway and pass it as `reason`: the export is recorded with it.",
    input: z.object({
      deck_id: deckId,
      version,
      reason: z.string().optional().describe("Why a version with lint ERRORs is exported anyway (recorded)."),
    }),
    readOnly: true, // the deck does not change; an off-charter export is only logged
    role: "viewer",
    run: async (app, user, a) => {
      const r = await app.decks.exportPath(user, a.deck_id, a.version);
      // the soft gate (review.ts): never a block, a record when the export is off-charter
      const errors = (await app.decks.lint(user, a.deck_id, r.version)).findings.filter((f) => f.severity === "ERROR").length;
      await recordExport(app.decks, user, a.deck_id, r.version, errors, a.reason);
      return {
        version: r.version,
        lint_errors: errors,
        ...(errors && !a.reason?.trim() ? { warning: `v${r.version} has ${errors} lint ERROR(s): pass \`reason\` to record why it goes out anyway` } : {}),
        download_url: `${app.publicUrl}/decks/${a.deck_id}/deck.pptx?v=${r.version}&${token(app, user, a.deck_id)}`,
        ...(user.local ? { path: r.path } : {}),
      };
    },
  }),

  set_approval: tool({
    title: "Set approval status",
    description:
      "Only on packs with approval on (open_deck's `approval.enabled`). Move the deck to in_review (an editor requests a review of a draft), approved (the pack owner or an admin, on a deck in review) or back to draft (the approver sends it back, or an editor withdraws it). Never needed to export.",
    input: z.object({
      deck_id: deckId,
      status: z.enum(["draft", "in_review", "approved"]),
      note: z.string().optional().describe("Why: recorded with the change."),
    }),
    role: "viewer",
    run: (app, user, a) => setApproval(app.decks, user, a.deck_id, a.status, a.note),
  }),

  export_pdf: tool({
    title: "Export PDF",
    description: "Download link for the deck as a PDF, one page per slide, rendered like the previews (and its local path on a stdio server).",
    input: z.object({ deck_id: deckId, version }),
    readOnly: true,
    role: "viewer",
    run: async (app, user, a) => {
      const r = await app.decks.exportPdf(user, a.deck_id, a.version);
      return {
        version: r.version,
        download_url: `${app.publicUrl}/decks/${a.deck_id}/deck.pdf?v=${r.version}&${token(app, user, a.deck_id)}`,
        ...(user.local ? { path: r.path } : {}),
      };
    },
  }),

  list_decks: tool({
    title: "List decks",
    description:
      "Your decks and the decks shared with you, newest change first: id, title, pack, owner, version and your role (owner, editor, commenter, viewer). Find one with `query` (words in its title or slides, e.g. the client's name) and `pack_id`.",
    input: z.object({
      query: z.string().optional().describe("Words the deck's title or slide text must all contain (case and accents ignored)."),
      pack_id: z.string().optional().describe("Only the decks on this pack."),
    }),
    readOnly: true,
    run: async (app, user, a) => ({ decks: await app.decks.list(user, a) }),
  }),

  delete_deck: tool({
    title: "Delete deck",
    description:
      "The deck's owner, or an admin: delete the deck for good, with every version, comment, share and file built from it. Cannot be undone: ask the user to confirm first.",
    input: z.object({ deck_id: deckId }),
    run: (app, user, a) => app.decks.remove(user, a.deck_id),
  }),

  rename_deck: tool({
    title: "Rename deck",
    description:
      "Editor access. Give the deck the name lists show (by default its DeckSpec title); the slides do not change and no version is added. An empty title goes back to the default.",
    input: z.object({ deck_id: deckId, title: z.string().max(200) }),
    role: "editor",
    run: (app, user, a) => app.decks.rename(user, a.deck_id, a.title),
  }),

  duplicate_deck: tool({
    title: "Duplicate deck",
    description:
      "View access. A new deck you own, a copy of this deck's current version: its history starts fresh at v1, without the original's comments or shares. Default title: the original's + \" (copy)\".",
    input: z.object({ deck_id: deckId, title: z.string().max(200).optional() }),
    ui: true,
    role: "viewer",
    run: async (app, user, a) => {
      const r = await app.decks.duplicate(user, a.deck_id, a.title);
      return { ...r, ...links(app, user, r.deck_id) };
    },
  }),

  share_deck: tool({
    title: "Share deck",
    description:
      "Owner only. Give a user (their id) or a team a role on the deck: viewer (read, export, present), commenter (+ comment) or editor (+ change it). Sharing again changes the role. People see the deck only if they see its brand pack.",
    input: z.object({
      deck_id: deckId,
      principal_type: z.enum(["user", "team"]),
      principal: z.string().min(1).describe("The user id or team."),
      role: z.enum(["viewer", "commenter", "editor"]),
    }),
    role: "owner",
    run: (app, user, a) => share(app.decks, user, a.deck_id, a.principal_type, a.principal, a.role),
  }),

  unshare_deck: tool({
    title: "Unshare deck",
    description: "Owner only. Remove a share given with share_deck.",
    input: z.object({ deck_id: deckId, principal_type: z.enum(["user", "team"]), principal: z.string().min(1) }),
    role: "owner",
    run: (app, user, a) => unshare(app.decks, user, a.deck_id, a.principal_type, a.principal),
  }),

  list_shares: tool({
    title: "List shares",
    description:
      "Who has access to the deck: its owner, the people and teams it is shared with (with their role), its general access, and its share link `url` (owner only). The owner, or an admin (who never gets the link).",
    input: z.object({ deck_id: deckId }),
    readOnly: true,
    run: async (app, user, a) => {
      const { link_key, ...r } = await shares(app.decks, user, a.deck_id);
      return { ...r, ...(link_key ? { url: shareUrl(app, a.deck_id, link_key) } : {}) };
    },
  }),

  set_general_access: tool({
    title: "Set general access",
    description:
      "Owner only (an admin may only set private). Who the deck's share link opens for besides the people with access: private (nobody else), workspace (anyone signed in who sees its brand pack) or anyone (anybody with the link, no sign-in), with `role` viewer or commenter.",
    input: z.object({
      deck_id: deckId,
      access: z.enum(["private", "workspace", "anyone"]),
      role: z.enum(["viewer", "commenter"]).default("viewer"),
    }),
    run: (app, user, a) => setGeneralAccess(app.decks, user, a.deck_id, a.access, a.role),
  }),

  reset_link: tool({
    title: "Reset share link",
    description: "The deck's owner, or an admin: a new share link; every copy of the old one stops working. Returns the new `url` to the owner.",
    input: z.object({ deck_id: deckId }),
    run: async (app, user, a) => {
      const r = await resetLink(app.decks, user, a.deck_id);
      return { deck_id: a.deck_id, ...(r.link_key ? { url: shareUrl(app, a.deck_id, r.link_key) } : {}) };
    },
  }),

  transfer_deck: tool({
    title: "Transfer deck",
    description: "The deck's owner, or an admin: make another user (their id) its owner. The former owner keeps editor access.",
    input: z.object({ deck_id: deckId, to: z.string().min(1) }),
    run: (app, user, a) => transfer(app.decks, user, a.deck_id, a.to),
  }),

  upload_url: tool({
    title: "Upload URL",
    description:
      "A one-time URL to upload a file (a template or deck .pptx, an image) without base64: POST it as multipart field `file`, e.g. `curl -F file=@deck.pptx '<upload_url>'`. Returns {file_id, name, size, type}; pass the file_id to import_pptx / import_pack, or use an image as `file:<file_id>` in a clone value's `image`. Valid 15 minutes.",
    input: z.object({}),
    readOnly: true,
    run: async (app, user) => ({
      upload_url: `${app.publicUrl}/api/files?ticket=${await uploadTicket(app.secret, user)}`,
      method: "POST",
      field: "file",
      max_bytes: MAX_UPLOAD,
    }),
  }),

  import_pack: tool({
    title: "Import brand pack",
    description:
      "Install a company's brand pack from its template (.pptx or .potx). First call without `manifest`: returns the extracted template map, draft tokens and a draft manifest (guessed roles, grid, placeholders). Review the roles (core://pack-contract) in a pack.yaml manifest and call again: the pack is validated (template lints clean, a test deck builds clean) and published, restricted to your teams unless visibility is 'workspace'.",
    input: z.object({
      template: File,
      manifest: z.record(z.string(), z.unknown()).optional().describe("pack.yaml content."),
      tokens: z.record(z.string(), z.unknown()).optional().describe("tokens.json (DTCG); default: the draft."),
      template_map: z.record(z.string(), z.unknown()).optional().describe("Reviewed template-map; default: the draft."),
      voice: z.string().optional().describe("voice.md: tone, register, banned words."),
      visibility: z.enum(["workspace", "team"]).default("team"),
      teams: z.array(z.string()).optional(),
    }),
    run: async (app, user, a) =>
      importPack(app.db, user, app.data, { ...a, template: await materialize(app, user, a.template) }),
  }),

  open_pack: tool({
    title: "Open brand pack",
    description:
      "A brand pack's charter, read-only: DESIGN.md, palette and fonts (tokens.json), voice, storyline, exemplar, anti-slop rules, placeholders, the template slides with their roles, and its exemplar pages and icons (also pack://<id>/exemplar/<file> and pack://<id>/icons/<file>). `extends` and `inherited`: what it takes from its group pack.",
    input: z.object({ pack_id: z.string() }),
    readOnly: true,
    run: (app, user, a) => packPortal(app.db, user, a.pack_id),
  }),

  compliance_report: tool({
    title: "Brand compliance report",
    description:
      "For pack owners and admins: per pack they manage, the decks made on it (by owner and team), the lint ERRORs and WARNs of each deck's latest version, the trend week by week and the approval status. Decks not linted yet are linted a few at a time: call again to fill them in.",
    input: z.object({ pack_id: z.string().optional().describe("One pack; default: every pack you manage.") }),
    readOnly: true,
    run: (app, user, a) => compliance(app.db, app.decks, user, a.pack_id),
  }),

  revoke_sessions: tool({
    title: "Revoke sessions",
    description:
      "Admin only: sign a user out everywhere. Every web session the user holds now stops working; they can sign in again (to block sign-in, deactivate them in the IdP, which deprovisions them over SCIM).",
    input: z.object({ user: z.string().min(1).describe("The user's id (OIDC sub) or user name.") }),
    run: (app, user, a) => app.access.revokeUser(user, a.user),
  }),

  library_list: tool({
    title: "List slide library",
    description:
      "The approved slides of a brand pack's library (case studies, references, client logos, team bios, boilerplate), newest first: entry_id, title, tags and a thumbnail_url. Search with `query` (words of the title or tags) and `tags`. Look here for proof points before naming a gap. Pack managers pass status 'pending' to see the proposals to review.",
    input: z.object({
      pack_id: z.string().optional().describe("Default: every pack you see."),
      query: z.string().optional(),
      tags: z.array(z.string()).optional().describe("Entries carrying every one of these tags."),
      status: z.enum(["approved", "pending", "all"]).default("approved"),
    }),
    readOnly: true,
    run: (app, user, a) => libraryList(app, user, a),
  }),

  library_insert: tool({
    title: "Insert library slide",
    description:
      "Insert an approved library slide into a deck, as a new version (like copy_slides): a chart, diagram or composition goes into a deck on any pack, a template or imported slide only into a deck on the entry's pack. `at` is the 0-based position (default: before the closing slide, else at the end). Adapt its text with patch_deck if the audience needs it.",
    input: z.object({ entry_id: z.string(), deck_id: deckId, at: z.number().int().min(0).optional() }),
    ui: true,
    role: "editor",
    run: async (app, user, a) => ({ ...(await libraryInsert(app, user, a)), ...links(app, user, a.deck_id) }),
  }),

  library_add: tool({
    title: "Add to slide library",
    description:
      "Propose a slide of a deck you edit for its pack's library, with a title and tags (e.g. case-study, reference, team, boilerplate, the sector). The pack's owner or an admin approves it; their own additions are approved at once. Only add a slide the user asked to share: everyone who sees the pack will reuse it.",
    input: z.object({
      deck_id: deckId,
      slide_id: z.string(),
      title: z.string().min(1).max(200),
      tags: z.array(z.string().max(40)).max(20).optional(),
    }),
    run: (app, user, a) => libraryAdd(app, user, a),
  }),

  library_review: tool({
    title: "Review library entry",
    description: "The pack's owner or an admin: approve a pending library entry, or remove an entry (rejecting a proposal). Its author may also withdraw a pending one (remove).",
    input: z.object({ entry_id: z.string(), action: z.enum(["approve", "remove"]) }),
    run: (app, user, a) => (a.action === "approve" ? libraryApprove(app, user, a.entry_id) : libraryRemove(app, user, a.entry_id)),
  }),

  m365_list: tool({
    title: "Browse Microsoft 365",
    description:
      "Browse the user's OneDrive and SharePoint (as them: only what they can open). Default: their OneDrive root. `folder_id` (+ `drive_id`) lists a folder, `search` finds files in a drive, `sites` finds SharePoint sites by name and `site_id` lists a site's document libraries (each a drive_id). Items give drive_id, item_id, name, folder, web_url. When Microsoft 365 is not connected, the error gives the URL where the user connects it (in a browser signed in to Calque).",
    input: z.object({
      drive_id: z.string().optional().describe("A drive (a SharePoint document library); default: the user's OneDrive."),
      folder_id: z.string().optional(),
      search: z.string().optional(),
      sites: z.string().optional().describe("Find SharePoint sites by name."),
      site_id: z.string().optional(),
    }),
    readOnly: true,
    run: (app, user, a) => m365(app).list(user, a),
  }),

  m365_import: tool({
    title: "Import from Microsoft 365",
    description:
      "Copy a OneDrive or SharePoint file (PowerPoint, Word, Excel, PDF, CSV, text, image) into Calque: returns a file_id, used like an upload: import_pptx / import_pack `file`, an image as `file:<file_id>`, or a document to read in the web chat.",
    input: z.object({ item_id: z.string(), drive_id: z.string().optional().describe("Default: the user's OneDrive.") }),
    run: (app, user, a) => m365(app).import(user, app.data, a),
  }),

  m365_save: tool({
    title: "Save to Microsoft 365",
    description:
      "Save the deck as PPTX (default) or PDF into a OneDrive or SharePoint folder (default: the user's OneDrive root) and return its `web_url`. A name already taken gets a new one: nothing is overwritten. Like export_pptx, a PPTX with lint ERRORs goes out with a `reason`, recorded.",
    input: z.object({
      deck_id: deckId,
      version,
      format: z.enum(["pptx", "pdf"]).default("pptx"),
      drive_id: z.string().optional(),
      folder_id: z.string().optional().describe("Default: the drive's root."),
      name: z.string().optional().describe("File name; default: the deck title and version."),
      reason: z.string().optional().describe("Why a version with lint ERRORs is saved anyway (recorded)."),
    }),
    role: "viewer",
    run: async (app, user, a) => {
      const client = m365(app);
      const deck = await app.decks.deck(user, a.deck_id, "viewer");
      const r = a.format === "pdf" ? await app.decks.exportPdf(user, a.deck_id, a.version) : await app.decks.exportPath(user, a.deck_id, a.version);
      let errors = 0;
      if (a.format === "pptx") {
        errors = (await app.decks.lint(user, a.deck_id, r.version)).findings.filter((f) => f.severity === "ERROR").length;
        await recordExport(app.decks, user, a.deck_id, r.version, errors, a.reason);
      }
      const name = fileName(a.name?.replace(/\.(pptx|pdf)$/i, "") || `${deck.title} v${r.version}`, `.${a.format}`);
      const saved = await client.save(user, r.path, name, a);
      await audit(app.db, user, "save_m365", "deck", a.deck_id, { version: r.version, format: a.format, name: saved.name, drive_id: saved.drive_id });
      return {
        version: r.version,
        ...saved,
        ...(a.format === "pptx" ? { lint_errors: errors } : {}),
        ...(errors && !a.reason?.trim() ? { warning: `v${r.version} has ${errors} lint ERROR(s): pass \`reason\` to record why it goes out anyway` } : {}),
      };
    },
  }),
} satisfies Record<string, Tool>;

function m365(app: App): M365 {
  if (!app.m365) throw new Error("Microsoft 365 is not set up on this server (CALQUE_M365_CLIENT_ID, see apps/server/README.md)");
  return app.m365;
}

export const toolNamed = (name: string): Tool | undefined => (TOOLS as Record<string, Tool>)[name];
