import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { family, flatten, hex6, resolve, type TokenTree } from "@calque/design";
import { parse } from "yaml";
import type { Db } from "./db.ts";
import { engine } from "./engine.ts";
import { getPack, NotFound, type User } from "./packs.ts";

/** The read-only brand portal (M17): a pack's charter as people read it in the app, and the
pack's images (exemplar pages, icons, rendered template slides) as files. */

/** What pack `dir` resolves to with the pack it `extends` merged in (the engine's `describe_pack`,
the one place inheritance is decided): its manifest, docs (voice, exemplar, storyline) and
exemplar images. */
export interface Resolved {
  id: string;
  extends: { id: string; dir: string }[];
  manifest: Record<string, unknown>;
  docs: Partial<Record<"voice" | "exemplar" | "storyline", string>>;
  exemplar_dir: string | null;
}

export async function resolvePack(dir: string): Promise<Resolved> {
  const manifest = parse(await readFile(join(dir, "pack.yaml"), "utf8")) as Record<string, unknown>;
  if (manifest.extends) return engine<Resolved>("describe_pack", { pack: dir });
  // nothing to inherit: its own files, without starting the engine
  const docs: Resolved["docs"] = {};
  for (const key of ["voice", "exemplar", "storyline"] as const) if (existsSync(join(dir, `${key}.md`))) docs[key] = join(dir, `${key}.md`);
  return { id: String(manifest.id), extends: [], manifest, docs, exemplar_dir: existsSync(join(dir, "exemplar")) ? join(dir, "exemplar") : null };
}

const IMAGE = /\.(png|jpe?g|svg|webp|gif)$/i;
export const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", webp: "image/webp", gif: "image/gif" };
export const imageType = (name: string) => IMAGE_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** The image files of a pack's `exemplar/` (inherited with its exemplar) or `icons/` folder. */
export async function packImages(dir: string, kind: "exemplar" | "icons", resolved?: Resolved): Promise<{ name: string; path: string }[]> {
  const folder = kind === "icons" ? join(dir, "icons") : (resolved ?? (await resolvePack(dir))).exemplar_dir;
  if (!folder || !existsSync(folder)) return [];
  return (await readdir(folder))
    .filter((f) => IMAGE.test(f))
    .sort()
    .map((name) => ({ name, path: join(folder, name) }));
}

/** One of those images, by its file name only. */
export async function packImage(db: Db, user: User, id: string, kind: "exemplar" | "icons", name: string) {
  const pack = await getPack(db, user, id);
  const found = basename(name) === name ? (await packImages(pack.dir, kind)).find((f) => f.name === name) : undefined;
  if (!found) throw new NotFound(`pack ${id} has no ${kind} image ${JSON.stringify(name)}`);
  return found.path;
}

const renders = new Map<string, Promise<unknown>>();

/** Template slide `n` of pack `id`, rendered once per release into the data dir. */
export async function templateSlide(db: Db, user: User, data: string, id: string, n: number): Promise<string> {
  const pack = await getPack(db, user, id);
  if (!Number.isInteger(n)) throw new NotFound(`pack ${id} has no template slide ${n}`);
  const out = join(data, "pack-renders", id, String(pack.version));
  let job = renders.get(out);
  if (!job) {
    job = engine("render", { pack: pack.dir, pptx: join(pack.dir, "template.pptx"), out_dir: out });
    job.catch(() => renders.delete(out));
    renders.set(out, job);
  }
  await job;
  const path = join(out, `slide-${n}.png`);
  if (!existsSync(path)) throw new NotFound(`pack ${id} has no template slide ${n}`);
  return path;
}

type Manifest = {
  name: string;
  version: string;
  default_language: string | null;
  missing_value: Record<string, string>;
  roles: Record<string, number[]> & { archetypes?: Record<string, number[]> };
  never_clone?: number[];
  fonts: { files?: string[]; fallback: Record<string, string> };
  lint: { placeholders?: string[]; slop_rules?: { severity: string; lang: string; note: string }[] };
  approval?: boolean;
};

const text = async (path: string | undefined) => (path ? await readFile(path, "utf8") : null);

/** Pack `id`'s charter for anyone who sees the pack: DESIGN.md, palette and fonts (tokens.json),
voice, storyline, exemplar (text and pages), icons, rules, and the template slides with their roles.
`inherited` names what comes from the parent pack. */
export async function packPortal(db: Db, user: User, id: string) {
  const pack = await getPack(db, user, id);
  const r = await resolvePack(pack.dir);
  const m = r.manifest as unknown as Manifest;
  const tokens = JSON.parse(await readFile(join(pack.dir, "tokens.json"), "utf8")) as TokenTree;
  const flat = flatten(tokens);
  const values = resolve(tokens);
  const colors = [...flat.entries()]
    .filter(([path, t]) => t.$type === "color" && !path.startsWith("theme."))
    .map(([path, t]) => ({ path, hex: hex6(values.get(path)), description: t.$description ?? null, role: path.startsWith("role.") }));
  const fonts = [...flat.keys()]
    .filter((p) => p.startsWith("role.font."))
    .map((p) => {
      const role = p.slice("role.font.".length);
      return { role, family: family(values.get(p)), weight: values.get(`role.fontWeight.${role}`) ?? null, fallback: m.fonts.fallback[role] ?? m.fonts.fallback.body ?? null };
    });

  const tmap = parse(await readFile(join(pack.dir, "template-map.yaml"), "utf8")) as { slides: { number: number; layout: string; description?: string }[] };
  const rolesOf = (n: number) => [
    ...Object.entries(m.roles).flatMap(([role, ns]) => (role !== "archetypes" && Array.isArray(ns) && ns.includes(n) ? [role] : [])),
    ...Object.entries(m.roles.archetypes ?? {}).flatMap(([a, ns]) => (ns.includes(n) ? [a] : [])),
  ];
  const own = (path: string | undefined) => !!path && path.startsWith(join(pack.dir, "/"));
  const ownRules = (parse(await readFile(join(pack.dir, "pack.yaml"), "utf8")) as Manifest).lint?.slop_rules;
  const inherited: string[] = r.extends.length ? (["voice", "storyline", "exemplar"] as const).filter((k) => r.docs[k] && !own(r.docs[k])) : [];
  if (r.extends.length && !ownRules && m.lint.slop_rules) inherited.push("slop_rules");
  const url = (kind: string, name: string) => `/api/packs/${id}/${kind}/${encodeURIComponent(name)}`;

  return {
    id,
    name: m.name,
    version: m.version,
    pack_version: pack.version,
    default_language: m.default_language,
    languages: Object.keys(m.missing_value ?? {}),
    extends: r.extends.map((p) => p.id),
    inherited,
    approval: m.approval === true,
    design_md: await text(existsSync(join(pack.dir, "DESIGN.md")) ? join(pack.dir, "DESIGN.md") : undefined),
    voice: await text(r.docs.voice),
    storyline: await text(r.docs.storyline),
    exemplar: await text(r.docs.exemplar),
    colors,
    fonts,
    font_files: m.fonts.files ?? [],
    rules: (m.lint.slop_rules ?? []).map((s) => ({ severity: s.severity, lang: s.lang, note: s.note })),
    placeholders: m.lint.placeholders ?? [],
    slides: tmap.slides.map((s) => ({
      number: s.number,
      layout: s.layout,
      description: s.description ?? null,
      roles: rolesOf(s.number),
      never_clone: (m.never_clone ?? []).includes(s.number),
      image_url: `/api/packs/${id}/slides/${s.number}.png`,
    })),
    exemplar_images: (await packImages(pack.dir, "exemplar", r)).map((f) => ({ name: f.name, url: url("exemplar", f.name) })),
    icons: (await packImages(pack.dir, "icons")).map((f) => ({ name: f.name, url: url("icons", f.name) })),
  };
}
