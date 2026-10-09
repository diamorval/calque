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
import { linkToken, type Link } from "./preview.ts";
import { createLink, previewLink, revokeLink, share, shares, transfer, unshare } from "./shares.ts";

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

/** The deck's preview link for `user`: their automatic guest link (a guest passes its own on, never extends it). */
const token = async (app: App, user: User, id: string) =>
  encodeURIComponent(user.guest ? user.guest.token : linkToken(app.secret, await previewLink(app.db, user, id)));
const links = async (app: App, user: User, id: string) => ({ preview_url: `${app.publicUrl}/decks/${id}?t=${await token(app, user, id)}` });
const linkUrl = (app: App, l: Link) => `${app.publicUrl}/decks/${l.deck_id}?t=${encodeURIComponent(linkToken(app.secret, l))}`;

async function openDeck(app: App, user: User, id: string, v?: number, render = true) {
  const deck = await app.decks.deck(user, id, "viewer");
  const at = v ?? deck.head;
  const t = await token(app, user, id);
  const spec = await app.decks.spec(id, at);
  const slides = render
    ? (await app.decks.render(user, id, at)).slides.map(({ id: sid, number, width_px, height_px, shapes }) => ({
        id: sid,
        number,
        image_url: `${app.publicUrl}/decks/${id}/slides/${number}.png?v=${at}&t=${t}`,
        width_px,
        height_px,
        shapes,
      }))
    : undefined;
  const open = await app.decks.comments(user, id, "open");
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
    open_comments: open,
    ...(await links(app, user, id)),
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
      return { ...r, ...(await links(app, user, r.deck_id)) };
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
      return { ...r, ...(await links(app, user, a.deck_id)) };
    },
  }),

  open_deck: tool({
    title: "Open deck",
    description: "A deck's DeckSpec, version history, rendered slides (PNG URL + shape map with shape_id and bbox) and open comments.",
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
      return { ...r, ...(await links(app, user, r.deck_id)) };
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
      await app.decks.resolve(user, a.deck_id, a.resolves ?? []);
      return { ...r, resolved: a.resolves ?? [], ...(await links(app, user, a.deck_id)) };
    },
  }),

  restore_version: tool({
    title: "Restore version",
    description: "Undo the last change, or go back to a given version. Either way it is a new version: nothing is lost.",
    input: z.object({ deck_id: deckId, version }),
    ui: true,
    role: "editor",
    run: async (app, user, a) => ({ ...(await app.decks.restore(user, a.deck_id, a.version)), ...(await links(app, user, a.deck_id)) }),
  }),

  add_comment: tool({
    title: "Comment",
    description: "Comment on a slide, or on one shape of it (shape_id from the shape map).",
    input: z.object({ deck_id: deckId, slide_id: z.string(), shape_id: z.number().int().optional(), text: z.string().min(1) }),
    appOnly: true,
    role: "commenter",
    run: async (app, user, a) => ({ comment: await app.decks.addComment(user, a.deck_id, a) }),
  }),

  list_comments: tool({
    title: "List comments",
    description: "Comments left on the deck (in the preview or the in-chat UI), each anchored on a slide id and shape_id. Apply them with patch_deck and pass their ids in `resolves`.",
    input: z.object({ deck_id: deckId, status: z.enum(["open", "resolved"]).optional().default("open") }),
    readOnly: true,
    role: "viewer",
    run: async (app, user, a) => ({ comments: await app.decks.comments(user, a.deck_id, a.status), ...(await links(app, user, a.deck_id)) }),
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
        ...(await links(app, user, a.deck_id)),
      };
    },
  }),

  export_pptx: tool({
    title: "Export PPTX",
    description: "Download link for the deck's PPTX (and its local path on a stdio server).",
    input: z.object({ deck_id: deckId, version }),
    readOnly: true,
    role: "viewer",
    run: async (app, user, a) => {
      const r = await app.decks.exportPath(user, a.deck_id, a.version);
      return {
        version: r.version,
        download_url: `${app.publicUrl}/decks/${a.deck_id}/deck.pptx?v=${r.version}&t=${await token(app, user, a.deck_id)}`,
        ...(user.local ? { path: r.path } : {}),
      };
    },
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
      "Owner only. Give a user (their id), a team, or the whole workspace a role on the deck: viewer (read, export, present), commenter (+ comment) or editor (+ change it). Sharing again changes the role. People see the deck only if they see its brand pack.",
    input: z.object({
      deck_id: deckId,
      principal_type: z.enum(["user", "team", "workspace"]),
      principal: z.string().optional().describe("The user id or team; none for the workspace."),
      role: z.enum(["viewer", "commenter", "editor"]),
    }),
    role: "owner",
    run: (app, user, a) => share(app.decks, user, a.deck_id, a.principal_type, a.principal, a.role),
  }),

  unshare_deck: tool({
    title: "Unshare deck",
    description: "Owner only. Remove a share given with share_deck.",
    input: z.object({ deck_id: deckId, principal_type: z.enum(["user", "team", "workspace"]), principal: z.string().optional() }),
    role: "owner",
    run: (app, user, a) => unshare(app.decks, user, a.deck_id, a.principal_type, a.principal),
  }),

  list_shares: tool({
    title: "List shares",
    description: "Owner only. Who the deck is shared with (users, teams, workspace, with their role) and its live guest links with their URL.",
    input: z.object({ deck_id: deckId }),
    readOnly: true,
    role: "owner",
    run: async (app, user, a) => {
      const r = await shares(app.decks, user, a.deck_id);
      return { ...r, links: r.links.map((l) => ({ ...l, url: linkUrl(app, l) })) };
    },
  }),

  create_link: tool({
    title: "Create guest link",
    description: "Owner only. A link that lets whoever holds it view (or comment on) this one deck without an account, until it expires or is revoked.",
    input: z.object({
      deck_id: deckId,
      role: z.enum(["viewer", "commenter"]).default("viewer"),
      expires_in_days: z.number().int().min(1).max(90).default(7),
      label: z.string().max(100).optional().describe("Who it is for; comments through it are signed `guest (<label>)`."),
    }),
    role: "owner",
    run: async (app, user, a) => {
      const l = await createLink(app.decks, user, a.deck_id, a.role, a.expires_in_days, a.label);
      return { ...l, url: linkUrl(app, l) };
    },
  }),

  revoke_link: tool({
    title: "Revoke guest link",
    description: "The deck's owner, or an admin: the link (an id from list_shares) opens nothing from now on.",
    input: z.object({ deck_id: deckId, link_id: z.string() }),
    run: (app, user, a) => revokeLink(app.decks, user, a.deck_id, a.link_id),
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
