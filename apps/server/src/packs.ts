import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { designMd, readPack } from "@calque/design";
import { parse, stringify } from "yaml";
import { engine, REPO } from "./engine.ts";
import type { Db } from "./db.ts";

/** Who is calling. `local`: stdio or auth disabled, sees every pack and may pass file paths. */
export interface User {
  id: string;
  name?: string;
  teams: string[];
  local?: boolean;
}

export interface PackRow {
  id: string;
  dir: string;
  visibility: "workspace" | "team";
  teams: string[];
  owner: string | null;
  /** The current release: every publish, edit or restore adds one (pack_versions). */
  version: number;
  /** Hidden from pickers; decks already on it still open. */
  archived: boolean;
}

export class NotFound extends Error {}
export class Forbidden extends Error {}

export const ADMIN_TEAM = process.env.CALQUE_ADMIN_TEAM ?? "calque-admins";
export const isAdmin = (u: User) => u.local === true || u.teams.includes(ADMIN_TEAM);

/** Edit, share, archive and restore a pack: its owner, or an admin (seeded packs have no owner). */
const manages = (p: PackRow, user: User) => isAdmin(user) || p.owner === user.id;

export function visible(p: PackRow, user: User): boolean {
  return (
    user.local === true ||
    p.visibility === "workspace" ||
    p.owner === user.id ||
    p.teams.some((t) => user.teams.includes(t))
  );
}

/** Register the packs shipped in `packs/` (CALQUE_PACKS) for the whole workspace, once. */
export async function seedPacks(db: Db, dir = process.env.CALQUE_PACKS ?? join(REPO, "packs")): Promise<void> {
  for (const id of await readdir(dir)) {
    if (!existsSync(join(dir, id, "pack.yaml"))) continue;
    await db.query(
      "insert into packs (id, dir, visibility) values ($1, $2, 'workspace') on conflict (id) do nothing",
      [id, join(dir, id)],
    );
  }
  // every pack has its first release on record (seeded, or published before versions existed)
  await db.query(
    "insert into pack_versions (pack_id, version, dir, note) select id, version, dir, 'initial version' from packs on conflict do nothing",
  );
}

/** A pack `user` manages; 404 if they cannot see it, 403 if they see it but do not manage it. */
async function managedPack(db: Db, user: User, id: string, what: string): Promise<PackRow> {
  const { rows } = await db.query<PackRow>("select * from packs where id = $1", [id]);
  const row = rows[0];
  if (row && manages(row, user)) return row;
  if (!row || !visible(row, user)) throw new NotFound(`no pack ${JSON.stringify(id)}`);
  throw new Forbidden(`only the owner of ${id} or ${ADMIN_TEAM} ${what}`);
}

/** Record a new release of pack `id` living in `dir`, and make it current. Returns its number. */
async function release(db: Db, id: string, dir: string, note: string, author: string): Promise<number> {
  const version = await nextVersion(db, id);
  await db.query("update packs set dir = $2, version = $3 where id = $1", [id, dir, version]);
  await db.query("insert into pack_versions (pack_id, version, dir, note, author) values ($1, $2, $3, $4, $5)", [id, version, dir, note, author]);
  return version;
}

/** Where release `version` of pack `id` is kept: a release is never overwritten, so it can be restored. */
const releaseDir = (data: string, id: string, version: number) => join(data, "pack-versions", id, String(version));
const nextVersion = async (db: Db, id: string) =>
  Number((await db.query<{ next: number }>("select coalesce(max(version), 0) + 1 as next from pack_versions where pack_id = $1", [id])).rows[0]?.next ?? 1);

export async function getPack(db: Db, user: User, id: string): Promise<PackRow> {
  const { rows } = await db.query<PackRow>("select * from packs where id = $1", [id]);
  const row = rows[0];
  // a pack the caller may not see does not exist for them
  if (!row || !visible(row, user)) throw new NotFound(`no pack ${JSON.stringify(id)}`);
  return row;
}

/** The packs `user` sees, archived ones left out. `archived`: keep them (decks on them still open).
`manage`: the Brand packs page, also every pack an admin manages. */
export async function listPacks(db: Db, user: User, opts: { archived?: boolean; manage?: boolean } = {}) {
  const { rows } = await db.query<PackRow>("select * from packs order by id");
  return Promise.all(
    rows
      .filter((r) => (visible(r, user) || (opts.manage && manages(r, user))) && (opts.archived || opts.manage || !r.archived))
      .map(async (r) => {
        const m = parse(await readFile(join(r.dir, "pack.yaml"), "utf8"));
        return {
          id: r.id,
          name: m.name as string,
          version: m.version as string,
          default_language: m.default_language as string | null,
          languages: Object.keys(m.missing_value ?? {}),
          visibility: r.visibility,
          teams: r.teams,
          owner: r.owner,
          pack_version: r.version,
          archived: r.archived,
          editable: manages(r, user),
        };
      }),
  );
}

export interface ImportPackInput {
  template: string; // local path to the uploaded template.pptx
  manifest?: Record<string, unknown> | undefined;
  tokens?: Record<string, unknown> | undefined;
  template_map?: Record<string, unknown> | undefined;
  visibility: "workspace" | "team";
  teams?: string[] | undefined;
  voice?: string | undefined; // voice.md
  fonts?: string | undefined; // a directory of font files
  note?: string | undefined; // the changelog line of this release
}

type Finding = { severity: string; slide: number | null; shape_id: number | null; check: string; message: string };

/** Stage a pack from a template; publish it when the manifest is given and it validates.

Without a manifest, returns the extractor's drafts (template map, tokens) for review: the caller
assigns roles in a pack.yaml and calls again. Publishing needs: the pack loads, the template lints
clean, and a cover/content/closing test deck builds and lints clean. */
export async function importPack(db: Db, user: User, data: string, input: ImportPackInput) {
  const draft = await engine<Draft>("extract", { template: input.template });
  if (!input.manifest) {
    return { status: "draft" as const, manifest: draft.manifest, template_map: draft.template_map, tokens: draft.tokens };
  }
  const id = String(input.manifest.id ?? "");
  const { rows } = await db.query<PackRow>("select * from packs where id = $1", [id]);
  if (rows[0] && !manages(rows[0], user)) throw new Error(`pack id ${JSON.stringify(id)} is taken`);

  const stage = join(data, "packs", `.stage-${id}-${Date.now()}`);
  await mkdir(stage, { recursive: true });
  try {
    await cp(input.template, join(stage, "template.pptx"));
    await writeFile(join(stage, "pack.yaml"), stringify(input.manifest));
    await writeFile(join(stage, "tokens.json"), JSON.stringify(input.tokens ?? draft.tokens, null, 2) + "\n");
    await writeFile(join(stage, "template-map.yaml"), stringify(input.template_map ?? draft.template_map));
    if (input.voice) await writeFile(join(stage, "voice.md"), input.voice);
    if (input.fonts && existsSync(input.fonts)) {
      await cp(input.fonts, join(stage, "fonts"), { recursive: true });
      const files = (await readdir(input.fonts)).sort();
      const m = { ...input.manifest, fonts: { ...(input.manifest.fonts as object), files } };
      await writeFile(join(stage, "pack.yaml"), stringify(m));
    }
    await engine("validate_pack", { pack: stage });
    const problems = await validateStaged(stage, input.manifest);
    if (problems.length) return { status: "invalid" as const, problems };
    await writeDesign(stage);

    const dir = releaseDir(data, id, await nextVersion(db, id));
    await rm(dir, { recursive: true, force: true });
    await cp(stage, dir, { recursive: true });
    await db.query(
      `insert into packs (id, dir, visibility, teams, owner) values ($1, $2, $3, $4, $5)
       on conflict (id) do update set visibility = $3, teams = $4, archived = false`,
      [id, dir, input.visibility, JSON.stringify(input.teams ?? user.teams), user.id],
    );
    const version = await release(db, id, dir, input.note || (rows[0] ? "re-import" : "import"), user.id);
    return { status: "published" as const, id, version, visibility: input.visibility, teams: input.teams ?? user.teams };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** DESIGN.md is generated from tokens.json and the template map: regenerate it with every release. */
async function writeDesign(dir: string) {
  await writeFile(join(dir, "DESIGN.md"), designMd(readPack(dir)));
}

async function validateStaged(dir: string, manifest: Record<string, unknown>): Promise<string[]> {
  const errors = (fs: Finding[]) =>
    fs.filter((f) => f.severity === "ERROR").map((f) => `${f.slide ? `s${f.slide}` : "deck"} ${f.check}: ${f.message}`);
  const tpl = await engine<{ findings: Finding[] }>("lint", { pack: dir, pptx: join(dir, "template.pptx"), template: true });
  const problems = errors(tpl.findings).map((p) => `template ${p}`);

  const tmap = parse(await readFile(join(dir, "template-map.yaml"), "utf8")) as {
    slides: { number: number; slots?: Record<string, number> }[];
  };
  const roles = manifest.roles as Record<string, number[]>;
  const language = (manifest.default_language as string | null) ?? Object.keys(manifest.missing_value as object)[0];
  const slide = (role: string) => {
    const slot = tmap.slides.find((s) => s.number === roles[role]?.[0])?.slots?.title;
    const values = slot ? { [String(slot)]: `Test ${role}` } : {};
    return { id: role, message: `Test ${role}`, message_type: role === "content" ? "narrative" : role, form: role, source: { kind: "clone", role, values } };
  };
  const out = join(dir, ".test-deck.pptx");
  const deck = { pack_id: manifest.id, language, title: "Test", slides: ["cover", "content", "closing"].map(slide) };
  const built = await engine<{ slides: Record<string, { position: number; source: number }> }>("build", { pack: dir, deck, out });
  const sources = Object.fromEntries(Object.values(built.slides).map((s) => [String(s.position), s.source]));
  const test = await engine<{ findings: Finding[] }>("lint", { pack: dir, pptx: out, language, sources });
  await rm(out);
  return [...problems, ...errors(test.findings).map((p) => `test deck ${p}`)];
}

type Draft = { manifest: Record<string, unknown>; template_map: { slides: { number: number; layout: string; shapes: { kind: string; text?: string }[] }[] }; tokens: Record<string, unknown> };

const FONT = /^[\w .-]+\.(ttf|otf)$/i;

/** Web import, step 1: stage the template as a draft pack (extracted map, tokens, manifest) with
one PNG per template slide, for the reviewer to assign roles on. Only its creator sees it. */
export async function draftPack(user: User, data: string, template: Buffer, id: string, name: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("pack id: lowercase letters, digits and dashes");
  const draftId = randomUUID();
  const dir = join(data, "pack-drafts", draftId);
  await mkdir(join(dir, "fonts"), { recursive: true });
  await writeFile(join(dir, "template.pptx"), template);
  await writeFile(join(dir, "owner"), user.id);
  const d = await engine<Draft>("extract", { template: join(dir, "template.pptx"), pack_id: id, name });
  await writeFile(join(dir, "pack.yaml"), stringify(d.manifest));
  await writeFile(join(dir, "tokens.json"), JSON.stringify(d.tokens, null, 2));
  await writeFile(join(dir, "template-map.yaml"), stringify(d.template_map));
  await engine("render", { pack: dir, pptx: join(dir, "template.pptx"), out_dir: join(dir, "render") });
  return {
    draft_id: draftId,
    manifest: d.manifest,
    slides: d.template_map.slides.map((s) => ({
      number: s.number,
      layout: s.layout,
      texts: s.shapes.filter((sh) => sh.kind === "text" && sh.text).map((sh) => sh.text as string),
      image_url: `/api/packs/drafts/${draftId}/slides/${s.number}.png`,
    })),
  };
}

/** A draft's directory, if `user` created it. */
export async function draftDir(user: User, data: string, draftId: string): Promise<string> {
  const dir = join(data, "pack-drafts", draftId);
  if (!/^[0-9a-f-]{36}$/.test(draftId) || !existsSync(join(dir, "owner"))) throw new NotFound(`no draft ${draftId}`);
  if (!user.local && (await readFile(join(dir, "owner"), "utf8")) !== user.id) throw new NotFound(`no draft ${draftId}`);
  return dir;
}

export async function addFont(user: User, data: string, draftId: string, name: string, bytes: Buffer) {
  if (!FONT.test(name)) throw new Error("fonts: .ttf or .otf files");
  const dir = await draftDir(user, data, draftId);
  await writeFile(join(dir, "fonts", name), bytes);
  return { fonts: (await readdir(join(dir, "fonts"))).sort() };
}

/** Edit a published pack, step 1: copy it whole (exemplars, icons, notes included) into a draft
with one PNG per template slide, for the same review as an import. Owner or admin. */
export async function editPack(db: Db, user: User, data: string, id: string) {
  const pack = await managedPack(db, user, id, "edit it");
  const draftId = randomUUID();
  const dir = join(data, "pack-drafts", draftId);
  await cp(pack.dir, dir, { recursive: true });
  await mkdir(join(dir, "fonts"), { recursive: true });
  await writeFile(join(dir, "owner"), user.id);
  await writeFile(join(dir, "edits"), id);
  return draftView(dir, draftId);
}

/** A draft for review: its manifest, voice, fonts and one PNG per template slide (rendered now). */
async function draftView(dir: string, draftId: string) {
  await rm(join(dir, "render"), { recursive: true, force: true });
  await engine("render", { pack: dir, pptx: join(dir, "template.pptx"), out_dir: join(dir, "render") });
  const tmap = parse(await readFile(join(dir, "template-map.yaml"), "utf8")) as Draft["template_map"];
  return {
    draft_id: draftId,
    manifest: parse(await readFile(join(dir, "pack.yaml"), "utf8")) as Record<string, unknown>,
    voice: existsSync(join(dir, "voice.md")) ? await readFile(join(dir, "voice.md"), "utf8") : "",
    fonts: (await readdir(join(dir, "fonts"))).sort(),
    slides: tmap.slides.map((s) => ({
      number: s.number,
      layout: s.layout,
      texts: s.shapes.filter((sh) => sh.kind === "text" && sh.text).map((sh) => sh.text as string),
      image_url: `/api/packs/drafts/${draftId}/slides/${s.number}.png`,
    })),
  };
}

/** Swap a draft's template.pptx (a new version of the company template). The extractor re-drafts the
template map and the template-bound parts of the manifest (roles, never_clone, grid, placeholders);
the rest (name, languages, fonts, lint rules) and tokens.json are kept. Review again, then publish:
the new template must lint clean against the pack's tokens. */
export async function replaceTemplate(user: User, data: string, draftId: string, template: Buffer) {
  const dir = await draftDir(user, data, draftId);
  const current = parse(await readFile(join(dir, "pack.yaml"), "utf8")) as Record<string, unknown> & { lint?: object };
  await writeFile(join(dir, "template.pptx"), template);
  const d = await engine<Draft>("extract", { template: join(dir, "template.pptx"), pack_id: current.id, name: current.name });
  const m = d.manifest as Record<string, unknown> & { lint?: { placeholders?: string[] } };
  const manifest = { ...current, roles: m.roles, never_clone: m.never_clone, grid: m.grid, lint: { ...current.lint, placeholders: m.lint?.placeholders ?? [] } };
  await writeFile(join(dir, "pack.yaml"), stringify(manifest));
  await writeFile(join(dir, "template-map.yaml"), stringify(d.template_map));
  return draftView(dir, draftId);
}

/** Swap a draft's tokens.json (DTCG, the pack's source of truth). Checked when the draft is published. */
export async function replaceTokens(user: User, data: string, draftId: string, bytes: Buffer) {
  const dir = await draftDir(user, data, draftId);
  let tokens: unknown;
  try {
    tokens = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("tokens.json: not valid JSON");
  }
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) throw new Error("tokens.json: a DTCG token tree (a JSON object)");
  await writeFile(join(dir, "tokens.json"), JSON.stringify(tokens, null, 2) + "\n");
  return { tokens: Object.keys(tokens).sort() };
}

/** Edit, step 2: the reviewed manifest and voice over the copy; validated like an import, then
published as the pack's next release (same id, same visibility). The previous release is kept. */
async function publishEdit(
  db: Db,
  user: User,
  data: string,
  dir: string,
  id: string,
  input: { manifest: Record<string, unknown>; voice?: string | undefined; note?: string | undefined },
) {
  const fonts = (await readdir(join(dir, "fonts"))).sort();
  const manifest = { ...input.manifest, id, ...(fonts.length ? { fonts: { ...(input.manifest.fonts as object), files: fonts } } : {}) };
  await writeFile(join(dir, "pack.yaml"), stringify(manifest));
  if (input.voice !== undefined) await writeFile(join(dir, "voice.md"), input.voice);
  await engine("validate_pack", { pack: dir });
  const problems = await validateStaged(dir, manifest);
  if (problems.length) return { status: "invalid" as const, problems };
  await writeDesign(dir);

  await managedPack(db, user, id, "edit it"); // still theirs to change
  const out = releaseDir(data, id, await nextVersion(db, id));
  const skip = new Set(["owner", "edits", "render"].map((f) => join(dir, f)));
  await rm(out, { recursive: true, force: true });
  await cp(dir, out, { recursive: true, filter: (src) => !skip.has(src) });
  const version = await release(db, id, out, input.note || "edit", user.id);
  await rm(dir, { recursive: true, force: true });
  return { status: "published" as const, id, version };
}

/** Web import, step 2: the reviewed manifest and voice; validated, then published (importPack). */
export async function publishDraft(
  db: Db,
  user: User,
  data: string,
  draftId: string,
  input: {
    manifest: Record<string, unknown>;
    voice?: string | undefined;
    note?: string | undefined;
    visibility: "workspace" | "team";
    teams?: string[] | undefined;
  },
) {
  const dir = await draftDir(user, data, draftId);
  if (existsSync(join(dir, "edits"))) return publishEdit(db, user, data, dir, await readFile(join(dir, "edits"), "utf8"), input);
  const r = await importPack(db, user, data, {
    ...input,
    template: join(dir, "template.pptx"),
    tokens: JSON.parse(await readFile(join(dir, "tokens.json"), "utf8")),
    template_map: parse(await readFile(join(dir, "template-map.yaml"), "utf8")),
    fonts: join(dir, "fonts"),
  });
  if (r.status === "published") await rm(dir, { recursive: true, force: true });
  return r;
}

/** Who sees a pack: the whole workspace, or the listed teams (and its owner). Owner or admin. */
export async function setVisibility(db: Db, user: User, id: string, visibility: "workspace" | "team", teams: string[]) {
  await managedPack(db, user, id, "change its visibility");
  await db.query("update packs set visibility = $2, teams = $3 where id = $1", [id, visibility, JSON.stringify(teams)]);
  return { id, visibility, teams };
}

/** Archive a pack (a finished client engagement): gone from pickers and new decks, while decks
already on it still open, build and export. Owner or admin; `archived: false` brings it back. */
export async function archivePack(db: Db, user: User, id: string, archived: boolean) {
  await managedPack(db, user, id, "archive it");
  await db.query("update packs set archived = $2 where id = $1", [id, archived]);
  return { id, archived };
}

/** A pack's releases, newest first: the changelog, and what `restorePack` can go back to. */
export async function packVersions(db: Db, user: User, id: string) {
  const pack = await managedPack(db, user, id, "see its history");
  const { rows } = await db.query<{ version: number; note: string; author: string | null; created_at: string }>(
    "select version, note, author, created_at from pack_versions where pack_id = $1 order by version desc",
    [id],
  );
  return { id, current: pack.version, versions: rows };
}

/** Roll back: release `version` becomes current again, recorded as a new release (history only grows). */
export async function restorePack(db: Db, user: User, id: string, version: number, note?: string) {
  await managedPack(db, user, id, "restore it");
  const { rows } = await db.query<{ dir: string }>("select dir from pack_versions where pack_id = $1 and version = $2", [id, version]);
  const dir = rows[0]?.dir;
  if (!dir || !existsSync(join(dir, "pack.yaml"))) throw new NotFound(`pack ${id} has no version ${version}`);
  return { id, version: await release(db, id, dir, note || `restore v${version}`, user.id) };
}
