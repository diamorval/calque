import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { engine, REPO } from "./engine.ts";
import type { Db } from "./db.ts";

/** Who is calling. `local`: stdio or auth disabled, sees every pack and may pass file paths. */
export interface User {
  id: string;
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
}

type Finding = { severity: string; slide: number | null; shape_id: number | null; check: string; message: string };

/** Stage a pack from a template; publish it when the manifest is given and it validates.

Without a manifest, returns the extractor's drafts (template map, tokens) for review: the caller
assigns roles in a pack.yaml and calls again. Publishing needs: the pack loads, the template lints
clean, and a cover/content/closing test deck builds and lints clean. */
export async function importPack(db: Db, user: User, data: string, input: ImportPackInput) {
  const draft = await engine<{ template_map: Record<string, unknown>; tokens: Record<string, unknown> }>("extract", {
    template: input.template,
  });
  if (!input.manifest) {
    return { status: "draft" as const, template_map: draft.template_map, tokens: draft.tokens };
  }
  const id = String(input.manifest.id ?? "");
  const { rows } = await db.query<PackRow>("select * from packs where id = $1", [id]);
  if (rows[0] && rows[0].owner !== user.id && !user.local) throw new Error(`pack id ${JSON.stringify(id)} is taken`);

  const stage = join(data, "packs", `.stage-${id}-${Date.now()}`);
  await mkdir(stage, { recursive: true });
  try {
    await cp(input.template, join(stage, "template.pptx"));
    await writeFile(join(stage, "pack.yaml"), stringify(input.manifest));
    await writeFile(join(stage, "tokens.json"), JSON.stringify(input.tokens ?? draft.tokens, null, 2) + "\n");
    await writeFile(join(stage, "template-map.yaml"), stringify(input.template_map ?? draft.template_map));
    await engine("validate_pack", { pack: stage });
    const problems = await validateStaged(stage, input.manifest);
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
