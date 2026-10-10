import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DeckSpec, PatchOp, Slide } from "@calque/deckspec";
import type { Db } from "./db.ts";
import type { Decks, Finding, Role } from "./decks.ts";
import { REPO } from "./engine.ts";
import { getFile, MAX_UPLOAD, uploadTicket } from "./files.ts";
import type { Models } from "./models.ts";
import { importPack, listPacks, type User } from "./packs.ts";
import { userToken } from "./preview.ts";
import { approvalOf, recordExport, setApproval } from "./review.ts";
import { resetLink, setGeneralAccess, share, shares, transfer, unshare } from "./shares.ts";

export interface App {
  db: Db;
  decks: Decks;
  models: Models;
  data: string;
  /** seals model keys and web sessions */
  secret: string;
  publicUrl: string;
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
  const dir = join(app.data, "uploads");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.pptx`);
  await writeFile(path, Buffer.from(f.base64, "base64"));
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
    description: "Import an existing deck to edit it in place: each slide becomes a clone of the imported file, edited by shape_id with patch_deck.",
    input: z.object({ file: File, pack_id: z.string(), language: z.string().min(2) }),
    ui: true,
    run: async (app, user, a) => {
      const r = await app.decks.importPptx(user, await materialize(app, user, a.file), a.pack_id, a.language);
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

  list_decks: tool({
    title: "List decks",
    description: "Your decks and the decks shared with you, newest change first: id, title, pack, owner, version and your role (owner, editor, commenter, viewer).",
    input: z.object({}),
    readOnly: true,
    run: async (app, user) => ({ decks: await app.decks.list(user) }),
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
} satisfies Record<string, Tool>;

export const toolNamed = (name: string): Tool | undefined => (TOOLS as Record<string, Tool>)[name];
