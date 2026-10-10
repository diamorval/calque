import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { designMd, readPack } from "@calque/design";
import { parse, stringify } from "yaml";
import { engine, REPO } from "./engine.ts";
import { audit } from "./audit.ts";
import type { Db } from "./db.ts";

/** Who is calling. `local`: stdio or auth disabled, sees every pack and may pass file paths. */
export interface User {
  id: string;
  name?: string;
  teams: string[];
  local?: boolean;
  /** Not signed in: someone who opened a deck's "Anyone with the link" share link. */
  anonymous?: boolean;
  /** The deck share link key this request presented (`?k=`, src/shares.ts). */
  key?: string;
  /** The per-user URL token this request came with (`?t=`, src/preview.ts), passed on as is. */
  token?: string;
}

export interface PackRow {
  id: string;
  dir: string;
  visibility: "workspace" | "team";
  teams: string[];
  owner: string | null;
  /** Co-managers (user ids): they edit, share with teams, archive and restore it like its owner. */
  managers: string[];
  /** The current release: every publish, edit or restore adds one (pack_versions). */
  version: number;
  /** Hidden from pickers; decks already on it still open. */
  archived: boolean;
  /** The pack /new preselects (one per workspace). */
  is_default: boolean;
}

export class NotFound extends Error {}
export class Forbidden extends Error {}

export const ADMIN_TEAM = process.env.CALQUE_ADMIN_TEAM ?? "calque-admins";
export const isAdmin = (u: User) => u.local === true || u.teams.includes(ADMIN_TEAM);

/** Edit, share, archive and restore a pack: its owner, a co-manager, or an admin (seeded packs have no owner). */
export const manages = (p: PackRow, user: User) => isAdmin(user) || p.owner === user.id || (p.managers ?? []).includes(user.id);

/** Only admins offer a pack to the whole workspace; others publish to their teams. */
function checkWorkspace(user: User, visibility: "workspace" | "team") {
  if (visibility === "workspace" && !isAdmin(user)) throw new Forbidden(`only ${ADMIN_TEAM} publish a pack to the whole workspace: restrict it to teams`);
}

export function visible(p: PackRow, user: User): boolean {
  return (
    user.local === true ||
    p.visibility === "workspace" ||
    p.owner === user.id ||
    (p.managers ?? []).includes(user.id) ||
    p.teams.some((t) => user.teams.includes(t))
  );
}

/** Register the packs shipped in `packs/` (CALQUE_PACKS) for the whole workspace, once. Test packs
(`test: true` in pack.yaml, e.g. acme-test) only with CALQUE_TEST_PACKS=1 (tests, e2e, dev); else a
copy seeded earlier is archived. CALQUE_DEFAULT_PACK: the default pack, unless an admin chose one. */
export async function seedPacks(
  db: Db,
  dir = process.env.CALQUE_PACKS ?? join(REPO, "packs"),
  opts = { tests: process.env.CALQUE_TEST_PACKS === "1", defaultPack: process.env.CALQUE_DEFAULT_PACK },
): Promise<void> {
  for (const id of await readdir(dir)) {
    const manifest = join(dir, id, "pack.yaml");
    if (!existsSync(manifest)) continue;
    if (parse(await readFile(manifest, "utf8"))?.test === true && !opts.tests) {
      await db.query("update packs set archived = true where id = $1 and owner is null", [id]);
      continue;
    }
    await db.query(
      "insert into packs (id, dir, visibility) values ($1, $2, 'workspace') on conflict (id) do nothing",
      [id, join(dir, id)],
    );
  }
  if (opts.defaultPack)
    await db.query("update packs set is_default = true where id = $1 and not exists (select 1 from packs where is_default)", [opts.defaultPack]);
  // every pack has its first release on record (seeded, or published before versions existed)
  await db.query(
    "insert into pack_versions (pack_id, version, dir, note) select id, version, dir, 'initial version' from packs on conflict do nothing",
  );
}

/** The packs seeded from CALQUE_PACKS still offered to the whole workspace (no owner, not
archived): main.ts logs them at start-up, so a client deployment notices a pack it did not mean to ship. */
export async function seededPacks(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>("select id from packs where owner is null and visibility = 'workspace' and not archived order by id");
  return rows.map((r) => r.id);
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

/** Every pack's current release: id -> directory (engine.ts sends it, to resolve `extends`). */
export async function packDirs(db: Db): Promise<Record<string, string>> {
  const { rows } = await db.query<{ id: string; dir: string }>("select id, dir from packs");
  return Object.fromEntries(rows.map((r) => [r.id, r.dir]));
}

/** A pack may extend (inherit voice, storyline, exemplar, slop rules from) a pack its publisher sees. */
async function checkParent(db: Db, user: User, manifest: Record<string, unknown>) {
  if (manifest.extends !== undefined && manifest.extends !== null) await getPack(db, user, String(manifest.extends));
}

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
          /** The group pack it inherits voice, storyline, exemplar and slop rules from. */
          extends: (m.extends as string | undefined) ?? null,
          visibility: r.visibility,
          teams: r.teams,
          owner: r.owner,
          managers: r.managers ?? [],
          pack_version: r.version,
          archived: r.archived,
          default: r.is_default,
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
  const stage = join(data, "packs", `.stage-${randomUUID()}`);
  await mkdir(stage, { recursive: true });
  try {
    // extract on the staged copy: the engine rewrites a .potx in place as a .pptx
    await cp(input.template, join(stage, "template.pptx"));
    const draft = await engine<Draft>("extract", { template: join(stage, "template.pptx"), tokens: input.tokens });
    if (!input.manifest) {
      return { status: "draft" as const, manifest: draft.manifest, template_map: draft.template_map, tokens: draft.tokens, review: draft.review };
    }
    const id = String(input.manifest.id ?? "");
    // checked before it names a folder (the engine checks the manifest only after staging)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`pack id ${JSON.stringify(id)}: lowercase letters, digits and dashes`);
    const { rows } = await db.query<PackRow>("select * from packs where id = $1", [id]);
    if (rows[0] && !manages(rows[0], user)) throw new Error(`pack id ${JSON.stringify(id)} is taken`);
    checkWorkspace(user, input.visibility);

    await checkParent(db, user, input.manifest);
    let manifest = input.manifest;
    await writeFile(join(stage, "tokens.json"), JSON.stringify(draft.tokens, null, 2) + "\n");
    await writeFile(join(stage, "template-map.yaml"), stringify(input.template_map ?? draft.template_map));
    if (input.voice) await writeFile(join(stage, "voice.md"), input.voice);
    if (input.fonts && existsSync(input.fonts)) {
      await cp(input.fonts, join(stage, "fonts"), { recursive: true });
      manifest = await withFonts(manifest, input.fonts);
    }
    await writeFile(join(stage, "pack.yaml"), stringify(manifest));
    await engine("validate_pack", { pack: stage });
    const problems = await validateStaged(stage, manifest);
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
    await audit(db, user, "publish", "pack", id, { version, visibility: input.visibility, teams: input.teams ?? user.teams });
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

  const deck = await testDeck(dir, manifest);
  const language = deck.language;
  const out = join(dir, ".test-deck.pptx");
  const built = await engine<{ slides: Record<string, { position: number; source: number }> }>("build", { pack: dir, deck, out });
  const sources = Object.fromEntries(Object.values(built.slides).map((s) => [String(s.position), s.source]));
  const test = await engine<{ findings: Finding[] }>("lint", { pack: dir, pptx: out, language, sources });
  await rm(out);
  return [...problems, ...errors(test.findings).map((p) => `test deck ${p}`)];
}

/** The test deck a pack must build clean: its cover, content and closing slides, titles filled. */
async function testDeck(dir: string, manifest: Record<string, unknown>) {
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
  return { pack_id: manifest.id, language, title: "Test", slides: ["cover", "content", "closing"].map(slide) };
}

type Draft = {
  manifest: Record<string, unknown>;
  template_map: { slides: { number: number; layout: string; shapes: { kind: string; text?: string }[] }[] };
  tokens: Record<string, unknown>;
  /** Resolved token values (path -> hex colour or font family), for a person to review. */
  review: { colors: Record<string, string>; fonts: Record<string, string> };
};

const FONT = /^[\w .-]+\.(ttf|otf)$/i;
const ROLE_NAMES = new Set(["cover", "summary", "divider", "subsection", "content", "closing", "appendix", "imported"]);

/** Archetype names a pack may declare under roles.archetypes: the cloned forms of core/forms.yaml. */
async function archetypes(): Promise<string[]> {
  const { forms } = parse(await readFile(join(REPO, "core/forms.yaml"), "utf8")) as { forms: Record<string, string> };
  return Object.keys(forms).filter((f) => forms[f] === "clone" && !ROLE_NAMES.has(f));
}

/** A font file's family (OpenType `name` table, id 1): the name PowerPoint writes on a run. */
export function fontFamily(b: Buffer): string | null {
  try {
    for (let i = 0; i < b.readUInt16BE(4); i++) {
      const rec = 12 + i * 16;
      if (b.toString("latin1", rec, rec + 4) !== "name") continue;
      const at = b.readUInt32BE(rec + 8);
      const strings = at + b.readUInt16BE(at + 4);
      let found: [number, string] | null = null; // [preference, name]
      for (let j = 0; j < b.readUInt16BE(at + 2); j++) {
        const r = at + 6 + j * 12;
        const [platform, , language, nameId, length = 0, offset = 0] = [0, 2, 4, 6, 8, 10].map((o) => b.readUInt16BE(r + o));
        if (nameId !== 1) continue;
        const raw = Buffer.from(b.subarray(strings + offset, strings + offset + length));
        // Windows US English first, then any Unicode (UTF-16BE) record, then Mac Roman
        const pref = platform === 3 && language === 0x409 ? 0 : platform === 0 || platform === 3 ? 1 : 2;
        if (!found || pref < found[0]) found = [pref, pref < 2 ? raw.swap16().toString("utf16le") : raw.toString("latin1")];
      }
      return found?.[1].trim() || null;
    }
  } catch {
    // not an OpenType file
  }
  return null;
}

/** The manifest with the pack's font files listed and their families allowed by lint. */
async function withFonts(manifest: Record<string, unknown>, fontsDir: string): Promise<Record<string, unknown>> {
  const files = (await readdir(fontsDir)).sort();
  if (!files.length) return manifest;
  const families = (await Promise.all(files.map(async (f) => fontFamily(await readFile(join(fontsDir, f)))))).filter((f): f is string => !!f);
  const lint = (manifest.lint ?? {}) as { extra_fonts?: string[] };
  return {
    ...manifest,
    fonts: { ...(manifest.fonts as object), files },
    lint: { ...lint, extra_fonts: [...new Set([...(lint.extra_fonts ?? []), ...families])] },
  };
}

/** Web import, step 1: stage the template (.pptx or .potx) as a draft pack (extracted map,
tokens, manifest) with one PNG per template slide, for the reviewer to assign roles on. `tokens`:
the company's tokens.json, used instead of the drafted one. Only its creator sees the draft. */
export async function draftPack(user: User, data: string, template: Buffer, id: string, name: string, tokens?: Record<string, unknown>) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("pack id: lowercase letters, digits and dashes");
  const draftId = randomUUID();
  const dir = join(data, "pack-drafts", draftId);
  await mkdir(join(dir, "fonts"), { recursive: true });
  await writeFile(join(dir, "template.pptx"), template);
  await writeFile(join(dir, "owner"), user.id);
  const d = await engine<Draft>("extract", { template: join(dir, "template.pptx"), pack_id: id, name, tokens });
  await writeFile(join(dir, "pack.yaml"), stringify(d.manifest));
  await writeFile(join(dir, "tokens.json"), JSON.stringify(d.tokens, null, 2));
  await writeFile(join(dir, "template-map.yaml"), stringify(d.template_map));
  await engine("render", { pack: dir, pptx: join(dir, "template.pptx"), out_dir: join(dir, "render") });
  return {
    draft_id: draftId,
    manifest: d.manifest,
    review: d.review,
    archetypes: await archetypes(),
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

/** Add a font file to a draft. Its family is allowed by lint when the draft is published. */
export async function addFont(user: User, data: string, draftId: string, name: string, bytes: Buffer) {
  if (!FONT.test(name)) throw new Error("fonts: .ttf or .otf files");
  const family = fontFamily(bytes);
  if (!family) throw new Error(`fonts: ${name} has no readable family name`);
  const dir = await draftDir(user, data, draftId);
  await writeFile(join(dir, "fonts", name), bytes);
  return { fonts: (await readdir(join(dir, "fonts"))).sort(), family };
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
    ...(await draftDocs(dir)),
    fonts: (await readdir(join(dir, "fonts"))).sort(),
    archetypes: await archetypes(),
    slides: tmap.slides.map((s) => ({
      number: s.number,
      layout: s.layout,
      texts: s.shapes.filter((sh) => sh.kind === "text" && sh.text).map((sh) => sh.text as string),
      image_url: `/api/packs/drafts/${draftId}/slides/${s.number}.png`,
    })),
  };
}

/** Swap a draft's template.pptx (a new version of the company template). The extractor re-drafts the
template map and the template-bound parts of the manifest (roles, never_clone, grid, placeholders,
fonts its slides use); the rest (name, languages, fonts, lint rules) and tokens.json are kept. Review again, then publish:
the new template must lint clean against the pack's tokens. */
export async function replaceTemplate(user: User, data: string, draftId: string, template: Buffer) {
  const dir = await draftDir(user, data, draftId);
  const current = parse(await readFile(join(dir, "pack.yaml"), "utf8")) as Record<string, unknown> & { lint?: object };
  const tokens = JSON.parse(await readFile(join(dir, "tokens.json"), "utf8")) as Record<string, unknown>;
  await writeFile(join(dir, "template.pptx"), template); // a .potx is rewritten in place by the extractor
  const d = await engine<Draft>("extract", { template: join(dir, "template.pptx"), pack_id: current.id, name: current.name, tokens });
  const m = d.manifest as Record<string, unknown> & { lint?: { placeholders?: string[]; extra_fonts?: string[] } };
  const lint = (current.lint ?? {}) as { extra_fonts?: string[] };
  const extra_fonts = [...new Set([...(lint.extra_fonts ?? []), ...(m.lint?.extra_fonts ?? [])])];
  const manifest = {
    ...current,
    roles: m.roles,
    never_clone: m.never_clone,
    grid: m.grid,
    lint: { ...lint, placeholders: m.lint?.placeholders ?? [], ...(extra_fonts.length ? { extra_fonts } : {}) },
  };
  await writeFile(join(dir, "pack.yaml"), stringify(manifest));
  await writeFile(join(dir, "template-map.yaml"), stringify(d.template_map));
  return draftView(dir, draftId);
}

/** Swap a draft's tokens.json (DTCG, the pack's source of truth), the way an import takes the
company's tokens.json: through the extractor, which returns the resolved colours and fonts to review.
The template must still lint clean against them when the draft is published. */
export async function replaceTokens(user: User, data: string, draftId: string, bytes: Buffer) {
  const dir = await draftDir(user, data, draftId);
  let tokens: unknown;
  try {
    tokens = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("tokens.json: not valid JSON");
  }
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) throw new Error("tokens.json: a DTCG token tree (a JSON object)");
  const d = await engine<Draft>("extract", { template: join(dir, "template.pptx"), tokens });
  await writeFile(join(dir, "tokens.json"), JSON.stringify(d.tokens, null, 2) + "\n");
  return { tokens: Object.keys(d.tokens).sort(), review: d.review };
}

/** What a published edit carries: the reviewed manifest (its `lint.slop_rules` included), and the
pack's own docs. A doc left out stays as it is; an empty one is removed (a subsidiary then inherits
its group's). */
export interface EditInput {
  manifest: Record<string, unknown>;
  voice?: string | undefined;
  exemplar?: string | undefined;
  storyline?: string | undefined;
  note?: string | undefined;
}

const DOCS = ["exemplar", "storyline"] as const;
const LOGO = /^logo\.(png|svg|jpe?g)$/i;
const IMAGE = /^[\w .-]+\.(png|jpe?g|svg|webp|gif)$/i;

/** A draft's own exemplar and storyline (markdown), exemplar images and logo asset, for review. */
async function draftDocs(dir: string) {
  const m = parse(await readFile(join(dir, "pack.yaml"), "utf8")) as { docs?: Record<string, string> };
  const text = async (key: (typeof DOCS)[number]) => {
    const path = join(dir, m.docs?.[key] ?? `${key}.md`);
    return existsSync(path) ? readFile(path, "utf8") : "";
  };
  return {
    exemplar: await text("exemplar"),
    storyline: await text("storyline"),
    exemplar_images: existsSync(join(dir, "exemplar")) ? (await readdir(join(dir, "exemplar"))).filter((f) => IMAGE.test(f)).sort() : [],
    logo: (await readdir(dir)).find((f) => LOGO.test(f)) ?? null,
  };
}

/** Write the edited exemplar and storyline into draft `dir`; the manifest's `docs` follows them. */
async function withDocs(dir: string, manifest: Record<string, unknown>, input: EditInput): Promise<Record<string, unknown>> {
  const docs = { ...((manifest.docs as Record<string, string> | undefined) ?? {}) };
  const removed = new Set<string>();
  for (const key of DOCS) {
    const value = input[key];
    if (value === undefined) continue;
    const path = join(dir, docs[key] ?? `${key}.md`);
    if (value.trim()) {
      await writeFile(path, value);
      docs[key] ??= `${key}.md`;
    } else {
      await rm(path, { force: true });
      removed.add(key);
    }
  }
  const kept = Object.fromEntries(Object.entries(docs).filter(([k]) => !removed.has(k)));
  const rest = { ...manifest };
  delete rest.docs;
  return Object.keys(kept).length ? { ...rest, docs: kept } : rest;
}

/** Add an image to a draft's exemplar pages (`exemplar/`), or (`bytes` null) take one out. */
export async function exemplarImage(user: User, data: string, draftId: string, name: string, bytes: Buffer | null) {
  if (!IMAGE.test(name) || basename(name) !== name) throw new Error("exemplar: an image file (.png, .jpg, .svg, .webp, .gif)");
  const dir = await draftDir(user, data, draftId);
  await mkdir(join(dir, "exemplar"), { recursive: true });
  if (bytes) await writeFile(join(dir, "exemplar", name), bytes);
  else await rm(join(dir, "exemplar", name), { force: true });
  return { exemplar_images: (await draftDocs(dir)).exemplar_images };
}

/** Replace a draft's logo asset (`logo.png|svg|jpg` at the pack root). A pack whose logo is drawn
in its template has none: a new logo there is a new template. */
export async function replaceLogo(user: User, data: string, draftId: string, name: string, bytes: Buffer) {
  const ext = /\.(png|svg|jpe?g)$/i.exec(name)?.[1]?.toLowerCase();
  if (!ext) throw new Error("logo: a .png, .svg or .jpg file");
  const dir = await draftDir(user, data, draftId);
  const current = (await draftDocs(dir)).logo;
  if (!current) throw new Error("this pack has no logo asset: its logo is in the template, replace the template instead");
  await rm(join(dir, current));
  await writeFile(join(dir, `logo.${ext}`), bytes);
  return { logo: `logo.${ext}` };
}

/** Preview a pending edit before publishing it: the test deck (cover, content, closing) built on the
draft, with `manifest` (the roles being reviewed) applied, one PNG per slide. */
export async function previewDraft(user: User, data: string, draftId: string, manifest?: Record<string, unknown>) {
  const dir = await draftDir(user, data, draftId);
  if (manifest) await writeFile(join(dir, "pack.yaml"), stringify(await withFonts({ ...manifest }, join(dir, "fonts"))));
  const m = parse(await readFile(join(dir, "pack.yaml"), "utf8")) as Record<string, unknown>;
  const out = join(dir, "preview");
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const deck = await testDeck(dir, m);
  await engine("build", { pack: dir, deck, out: join(out, "sample.pptx") });
  const r = await engine<{ slides: { number: number }[] }>("render", { pack: dir, pptx: join(out, "sample.pptx"), out_dir: out });
  const t = Date.now(); // same URLs after another preview, new pictures
  return { slides: r.slides.map((s) => ({ number: s.number, image_url: `/api/packs/drafts/${draftId}/preview/${s.number}.png?t=${t}` })) };
}

/** Edit, step 2: the reviewed manifest and voice over the copy; validated like an import, then
published as the pack's next release (same id, same visibility). The previous release is kept. */
async function publishEdit(
  db: Db,
  user: User,
  data: string,
  dir: string,
  id: string,
  input: EditInput,
) {
  await checkParent(db, user, input.manifest);
  const manifest = await withDocs(dir, await withFonts({ ...input.manifest, id }, join(dir, "fonts")), input);
  await writeFile(join(dir, "pack.yaml"), stringify(manifest));
  if (input.voice !== undefined) await writeFile(join(dir, "voice.md"), input.voice);
  await engine("validate_pack", { pack: dir });
  const problems = await validateStaged(dir, manifest);
  if (problems.length) return { status: "invalid" as const, problems };
  await writeDesign(dir);

  await managedPack(db, user, id, "edit it"); // still theirs to change
  const out = releaseDir(data, id, await nextVersion(db, id));
  const skip = new Set(["owner", "edits", "render", "preview"].map((f) => join(dir, f)));
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
  input: EditInput & { visibility: "workspace" | "team"; teams?: string[] | undefined },
) {
  const dir = await draftDir(user, data, draftId);
  if (existsSync(join(dir, "edits"))) {
    const r = await publishEdit(db, user, data, dir, await readFile(join(dir, "edits"), "utf8"), input);
    if (r.status === "published") await audit(db, user, "edit", "pack", r.id);
    return r;
  }
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

/** Who sees a pack: the whole workspace (admins only), or the listed teams (and its owner and
co-managers). Its managers or an admin. */
export async function setVisibility(db: Db, user: User, id: string, visibility: "workspace" | "team", teams: string[]) {
  await managedPack(db, user, id, "change its visibility");
  checkWorkspace(user, visibility);
  await db.query("update packs set visibility = $2, teams = $3 where id = $1", [id, visibility, JSON.stringify(teams)]);
  await audit(db, user, "visibility", "pack", id, { visibility, teams });
  return { id, visibility, teams };
}

/** Co-managers of pack `id` (user ids, the owner left out): its owner or an admin sets them. */
export async function setManagers(db: Db, user: User, id: string, managers: string[]) {
  const pack = await managedPack(db, user, id, "change its managers");
  if (!isAdmin(user) && pack.owner !== user.id) throw new Forbidden(`only the owner of ${id} or ${ADMIN_TEAM} change its managers`);
  const list = [...new Set(managers.map((m) => m.trim()).filter((m) => m && m !== pack.owner))];
  await db.query("update packs set managers = $2 where id = $1", [id, JSON.stringify(list)]);
  await audit(db, user, "managers", "pack", id, { managers: list });
  return { id, managers: list };
}

/** Archive a pack (a finished client engagement): gone from pickers and new decks, while decks
already on it still open, build and export. Owner or admin; `archived: false` brings it back. */
export async function archivePack(db: Db, user: User, id: string, archived: boolean) {
  await managedPack(db, user, id, "archive it");
  // an archived pack is no one's default
  await db.query("update packs set archived = $2, is_default = is_default and not $2 where id = $1", [id, archived]);
  return { id, archived };
}

/** Admins: make pack `id` the one /new preselects for everyone (it must be workspace-wide, so all
see it); `on: false` leaves the workspace with no default. */
export async function setDefaultPack(db: Db, user: User, id: string, on = true) {
  if (!isAdmin(user)) throw new Forbidden(`only ${ADMIN_TEAM} set the default pack`);
  const pack = await getPack(db, user, id);
  if (on && (pack.archived || pack.visibility !== "workspace")) throw new Error(`the default pack must be workspace-wide and not archived: ${id} is not`);
  if (on) await db.query("update packs set is_default = false where is_default and id <> $1", [id]);
  await db.query("update packs set is_default = $2 where id = $1", [id, on]);
  await audit(db, user, "default", "pack", id, { on });
  return { id, default: on };
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
