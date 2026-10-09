import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
}

export class NotFound extends Error {}
export class Forbidden extends Error {}

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
}

export async function getPack(db: Db, user: User, id: string): Promise<PackRow> {
  const { rows } = await db.query<PackRow>("select * from packs where id = $1", [id]);
  const row = rows[0];
  // a pack the caller may not see does not exist for them
  if (!row || !visible(row, user)) throw new NotFound(`no pack ${JSON.stringify(id)}`);
  return row;
}

export async function listPacks(db: Db, user: User) {
  const { rows } = await db.query<PackRow>("select * from packs order by id");
  return Promise.all(
    rows
      .filter((r) => visible(r, user))
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
          editable: user.local === true || r.owner === user.id,
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
    if (rows[0] && rows[0].owner !== user.id && !user.local) throw new Error(`pack id ${JSON.stringify(id)} is taken`);

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

    const dir = join(data, "packs", id);
    await rm(dir, { recursive: true, force: true });
    await cp(stage, dir, { recursive: true });
    await db.query(
      `insert into packs (id, dir, visibility, teams, owner) values ($1, $2, $3, $4, $5)
       on conflict (id) do update set dir = $2, visibility = $3, teams = $4`,
      [id, dir, input.visibility, JSON.stringify(input.teams ?? user.teams), user.id],
    );
    return { status: "published" as const, id, visibility: input.visibility, teams: input.teams ?? user.teams };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
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
with one PNG per template slide, for the same review as an import. Owner only. */
export async function editPack(db: Db, user: User, data: string, id: string) {
  const pack = await getPack(db, user, id);
  if (!user.local && pack.owner !== user.id) throw new Forbidden(`only the owner of ${id} edits it`);
  const draftId = randomUUID();
  const dir = join(data, "pack-drafts", draftId);
  await cp(pack.dir, dir, { recursive: true });
  await mkdir(join(dir, "fonts"), { recursive: true });
  await writeFile(join(dir, "owner"), user.id);
  await writeFile(join(dir, "edits"), id);
  await engine("render", { pack: dir, pptx: join(dir, "template.pptx"), out_dir: join(dir, "render") });
  const tmap = parse(await readFile(join(dir, "template-map.yaml"), "utf8")) as Draft["template_map"];
  return {
    draft_id: draftId,
    manifest: parse(await readFile(join(dir, "pack.yaml"), "utf8")) as Record<string, unknown>,
    voice: existsSync(join(dir, "voice.md")) ? await readFile(join(dir, "voice.md"), "utf8") : "",
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

/** Edit, step 2: the reviewed manifest and voice over the copy; validated like an import, then
replaces the pack (same id, same visibility). */
async function publishEdit(db: Db, data: string, dir: string, id: string, input: { manifest: Record<string, unknown>; voice?: string | undefined }) {
  const manifest = await withFonts({ ...input.manifest, id }, join(dir, "fonts"));
  await writeFile(join(dir, "pack.yaml"), stringify(manifest));
  if (input.voice !== undefined) await writeFile(join(dir, "voice.md"), input.voice);
  await engine("validate_pack", { pack: dir });
  const problems = await validateStaged(dir, manifest);
  if (problems.length) return { status: "invalid" as const, problems };

  const out = join(data, "packs", id);
  const skip = new Set(["owner", "edits", "render"].map((f) => join(dir, f)));
  await rm(out, { recursive: true, force: true });
  await cp(dir, out, { recursive: true, filter: (src) => !skip.has(src) });
  await db.query("update packs set dir = $2 where id = $1", [id, out]);
  await rm(dir, { recursive: true, force: true });
  return { status: "published" as const, id };
}

/** Web import, step 2: the reviewed manifest and voice; validated, then published (importPack). */
export async function publishDraft(
  db: Db,
  user: User,
  data: string,
  draftId: string,
  input: { manifest: Record<string, unknown>; voice?: string | undefined; visibility: "workspace" | "team"; teams?: string[] | undefined },
) {
  const dir = await draftDir(user, data, draftId);
  if (existsSync(join(dir, "edits"))) return publishEdit(db, data, dir, await readFile(join(dir, "edits"), "utf8"), input);
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

/** Who sees a pack: the whole workspace, or the listed teams (and its owner). Owner only. */
export async function setVisibility(db: Db, user: User, id: string, visibility: "workspace" | "team", teams: string[]) {
  const pack = await getPack(db, user, id);
  if (!user.local && pack.owner !== user.id) throw new Forbidden(`only the owner of ${id} changes its visibility`);
  await db.query("update packs set visibility = $2, teams = $3 where id = $1", [id, visibility, JSON.stringify(teams)]);
  return { id, visibility, teams };
}
