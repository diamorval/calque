// Designs: DesignSpec documents (social posts, ads, banners, posters, web sections), versioned like
// decks. The engine validates, lays out (headless Chromium), lints and exports them; this store
// keeps the versions and caches each version's renders under <data>/designs/<id>/v<n>/.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesignPatchOp, DesignSpec } from "@calque/deckspec";
import { audit } from "./audit.ts";
import type { Db } from "./db.ts";
import type { Decks } from "./decks.ts";
import { engine } from "./engine.ts";
import { FILE_REF, getFile } from "./files.ts";
import { Forbidden, getPack, NotFound, type PackRow, type User } from "./packs.ts";

export const OUTPUTS = ["png", "pdf", "svg", "html"] as const;
export type Output = (typeof OUTPUTS)[number];
export const CODE_TARGETS = ["html", "react", "tailwind"] as const;

export interface DesignFinding {
  severity: "ERROR" | "WARN";
  artboard: string;
  node: string | null;
  check: string;
  message: string;
}

export interface RenderedArtboard {
  id: string;
  format: string;
  width: number;
  height: number;
  mode: string | null;
  files: Partial<Record<Output, string>>;
  boxes: Record<string, { x: number; y: number; w: number; h: number }>;
}

export interface DesignRender {
  artboards: RenderedArtboard[];
  findings: DesignFinding[];
  warnings: { severity: string; artboard: string | null; node: string | null; message: string }[];
}

interface DesignRow {
  id: string;
  pack_id: string;
  owner: string;
  title: string;
  head: number;
  pack_version: number | null;
  created_at: string;
}

const nameOf = (user: User) => (user.anonymous ? null : (user.name ?? null));

/** Every `file:<id>` image of a DesignSpec (artboards and components). */
function fileRefs(spec: DesignSpec): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    const node = n as { type?: string; src?: string; children?: unknown[] };
    if (node.type === "image" && node.src?.startsWith(FILE_REF)) out.push(node.src.slice(FILE_REF.length));
    node.children?.forEach(walk);
  };
  spec.artboards.forEach((b) => b.children.forEach(walk));
  for (const c of Object.values(spec.components ?? {})) [c.node, ...Object.values(c.variants ?? {})].forEach(walk);
  return out;
}

export class Designs {
  readonly db: Db;
  readonly data: string;
  private readonly decks: Decks;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(db: Db, data: string, decks: Decks) {
    this.db = db;
    this.data = data;
    this.decks = decks;
  }

  dir(id: string, version: number): string {
    return join(this.data, "designs", id, `v${version}`);
  }

  /** Design `id` if `user` owns it (designs are not shared yet: anyone else gets NotFound). */
  async design(user: User, id: string): Promise<DesignRow & { packDir: string; pack: PackRow }> {
    const { rows } = await this.db.query<DesignRow>("select * from designs where id = $1", [id]).catch(() => ({ rows: [] }));
    const row = rows[0];
    if (!row || row.owner !== user.id || user.anonymous) throw new NotFound(`no design ${JSON.stringify(id)}`);
    const pack = await getPack(this.db, user, row.pack_id);
    return { ...row, packDir: await this.decks.releaseDir(pack, row.pack_version), pack };
  }

  async list(user: User) {
    const { rows } = await this.db.query<DesignRow>("select * from designs where owner = $1 order by created_at desc", [user.id]);
    return rows.map(({ id, title, pack_id, head, created_at }) => ({ design_id: id, title, pack_id, version: head, created_at }));
  }

  async spec(id: string, version: number): Promise<DesignSpec> {
    const { rows } = await this.db.query<{ spec: DesignSpec }>("select spec from design_versions where design_id = $1 and version = $2", [id, version]);
    if (!rows[0]) throw new NotFound(`design ${id} has no version ${version}`);
    return rows[0].spec;
  }

  async versions(id: string) {
    const { rows } = await this.db.query<{ version: number; note: string; author_name: string | null; created_at: string }>(
      "select version, note, author_name, created_at from design_versions where design_id = $1 order by version",
      [id],
    );
    return rows;
  }

  /** New design: rendered (PNG) before anything is stored, so a design that does not lay out is never saved. */
  async create(user: User, spec: DesignSpec, note: string) {
    const pack = await getPack(this.db, user, spec.pack_id);
    if (pack.archived) throw new Forbidden(`pack ${spec.pack_id} is archived: no new designs on it`);
    await this.ownFiles(user, spec);
    const id = randomUUID();
    const render = await this.renderTo(pack.dir, spec, this.dir(id, 1), ["png"], 1);
    await this.db.query("insert into designs (id, pack_id, owner, title, head, pack_version) values ($1, $2, $3, $4, 1, $5)", [
      id,
      spec.pack_id,
      user.id,
      spec.title,
      pack.version,
    ]);
    await this.db.query("insert into design_versions (design_id, version, spec, note, author, author_name) values ($1, 1, $2, $3, $4, $5)", [
      id,
      JSON.stringify(spec),
      note,
      user.id,
      nameOf(user),
    ]);
    await audit(this.db, user, "create", "design", id, { title: spec.title, pack_id: spec.pack_id, note });
    return { design_id: id, version: 1, ...render };
  }

  /** Apply patch ops (the engine's design_patch) as the next version. */
  patch(user: User, id: string, ops: DesignPatchOp[], note: string) {
    return this.serial(id, async () => {
      const d = await this.design(user, id);
      const r = await engine<{ design: DesignSpec }>("design_patch", { pack: d.packDir, design: await this.spec(id, d.head), ops });
      return this.commit(user, d, r.design, note);
    });
  }

  /** Go back to `version` (default: the one before the current), as a new version. */
  restore(user: User, id: string, version?: number) {
    return this.serial(id, async () => {
      const d = await this.design(user, id);
      const v = version ?? d.head - 1;
      if (v < 1 || v > d.head) throw new Error(`no version ${v} (1..${d.head})`);
      return this.commit(user, d, await this.spec(id, v), `restore v${v}`);
    });
  }

  private async commit(user: User, d: DesignRow & { packDir: string }, spec: DesignSpec, note: string) {
    if (spec.pack_id !== d.pack_id) throw new Error(`a design stays on its pack (${d.pack_id})`);
    await this.ownFiles(user, spec);
    const next = d.head + 1;
    const render = await this.renderTo(d.packDir, spec, this.dir(d.id, next), ["png"], 1);
    const { rows } = await this.db.query("update designs set head = $3, title = $4 where id = $1 and head = $2 returning head", [d.id, d.head, next, spec.title]);
    if (!rows.length) throw new Error(`design ${d.id} changed meanwhile: reopen it and retry`);
    await this.db.query("insert into design_versions (design_id, version, spec, note, author, author_name) values ($1, $2, $3, $4, $5, $6)", [
      d.id,
      next,
      JSON.stringify(spec),
      note,
      user.id,
      nameOf(user),
    ]);
    await audit(this.db, user, "edit", "design", d.id, { version: next, note });
    return { design_id: d.id, version: next, ...render };
  }

  /** The renders of a version: `outputs` at `scale`, cached per version and scale. */
  async render(user: User, id: string, version: number | undefined, outputs: Output[], scale = 1): Promise<DesignRender & { version: number }> {
    const d = await this.design(user, id);
    const v = version ?? d.head;
    const spec = await this.spec(id, v);
    const dir = scale === 1 ? this.dir(id, v) : join(this.dir(id, v), `x${scale}`);
    const meta = join(dir, "render.json");
    // one render of a design at a time: they share its cache folder
    return this.serial(id, async () => {
      let have: Output[] = [];
      if (existsSync(meta)) {
        const cached = JSON.parse(await readFile(meta, "utf8")) as DesignRender;
        if (cached.artboards.every((a) => outputs.every((o) => a.files[o] && existsSync(a.files[o])))) return { version: v, ...cached };
        have = OUTPUTS.filter((o) => cached.artboards.every((a) => a.files[o]));
      }
      // re-render what was there too: the folder is replaced as a whole
      return { version: v, ...(await this.renderTo(d.packDir, spec, dir, [...have, ...outputs], scale)) };
    });
  }

  /** One artboard as html, react or tailwind code. */
  async code(user: User, id: string, artboard: string, target: (typeof CODE_TARGETS)[number], version?: number) {
    const d = await this.design(user, id);
    const v = version ?? d.head;
    const r = await engine<{ filename: string; code: string }>("design_code", {
      pack: d.packDir,
      design: await this.spec(id, v),
      artboard,
      target,
      image_roots: [d.packDir],
      file_root: join(this.data, "uploads"),
    });
    return { version: v, filename: r.filename, code: r.code };
  }

  private async renderTo(packDir: string, spec: DesignSpec, dir: string, outputs: readonly Output[], scale: number): Promise<DesignRender> {
    const tmp = `${dir}.tmp-${randomUUID()}`;
    await mkdir(tmp, { recursive: true });
    try {
      const all = [...new Set<Output>(["png", ...outputs])];
      const r = await engine<DesignRender>("design_render", {
        pack: packDir,
        design: spec,
        out_dir: tmp,
        outputs: all,
        scale,
        image_roots: [packDir],
        file_root: join(this.data, "uploads"),
      });
      // the files move with the folder: point them at their final place
      await rm(dir, { recursive: true, force: true });
      await rename(tmp, dir);
      const artboards = r.artboards.map((a) => ({
        ...a,
        files: Object.fromEntries(Object.entries(a.files).map(([k, f]) => [k, join(dir, f.split(/[\\/]/).pop() as string)])),
      }));
      const out = { artboards, findings: r.findings, warnings: r.warnings };
      await writeFile(join(dir, "render.json"), JSON.stringify(out));
      return out;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /** The caller must own every uploaded file the spec shows. */
  private async ownFiles(user: User, spec: DesignSpec) {
    for (const fid of fileRefs(spec)) await getFile(this.db, this.data, user, fid);
  }

  // ponytail: in-process lock, one server instance (as decks.ts)
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(id) ?? Promise.resolve()).then(fn, fn);
    this.locks.set(id, run.catch(() => undefined));
    return run;
  }
}
