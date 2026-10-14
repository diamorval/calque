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
import { ROLES, type Decks, type Role } from "./decks.ts";
import { engine } from "./engine.ts";
import { FILE_REF, getFile } from "./files.ts";
import { Forbidden, getPack, NotFound, visible, type PackRow, type User } from "./packs.ts";

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
const rank = (r: Role) => ROLES.indexOf(r);

export type PrincipalType = "user" | "team";

export interface DesignComment {
  id: number;
  design_id: string;
  version: number;
  artboard: string;
  node: string | null;
  text: string;
  author: string;
  author_name: string | null;
  status: "open" | "resolved";
  parent_id: number | null;
  created_at: string;
}

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

  /** Design `id` if `user` holds at least `need` on it: its owner (and the local user), or a share
  to them or one of their teams while they see its pack. Anyone else: it does not exist for them. */
  async design(user: User, id: string, need: Role = "viewer"): Promise<DesignRow & { packDir: string; pack: PackRow; role: Role }> {
    const { rows } = await this.db.query<DesignRow>("select * from designs where id = $1", [id]).catch(() => ({ rows: [] }));
    const row = rows[0];
    const role = row && !user.anonymous ? await this.roleOf(user, row) : null;
    if (!row || !role) throw new NotFound(`no design ${JSON.stringify(id)}`);
    if (rank(role) < rank(need)) throw new Forbidden(`${need} access needed on design ${id}`);
    const pack = (await this.db.query<PackRow>("select * from packs where id = $1", [row.pack_id])).rows[0] as PackRow;
    return { ...row, packDir: await this.decks.releaseDir(pack, row.pack_version), pack, role };
  }

  private async roleOf(user: User, row: DesignRow): Promise<Role | null> {
    if (user.local || row.owner === user.id) return "owner";
    const pack = (await this.db.query<PackRow>("select * from packs where id = $1", [row.pack_id])).rows[0];
    if (!pack || !visible(pack, user)) return null;
    const { rows } = await this.db.query<{ role: Role }>(
      `select role from design_shares where design_id = $1
         and ((principal_type = 'user' and principal = $2) or (principal_type = 'team' and principal = any($3::text[])))`,
      [row.id, user.id, user.teams],
    );
    return rows.map((r) => r.role).sort((a, b) => rank(b) - rank(a))[0] ?? null;
  }

  /** The caller's designs and those shared with them, newest change first, with their role. */
  async list(user: User) {
    if (user.anonymous) return [];
    // the first artboard of the current version: the cover the lists show
    const { rows } = await this.db.query<DesignRow & { cover: string | null; artboards: number; updated_at: string }>(
      `select d.*, v.spec->'artboards'->0->>'id' as cover, jsonb_array_length(v.spec->'artboards') as artboards, v.created_at as updated_at
       from designs d join design_versions v on v.design_id = d.id and v.version = d.head
       where d.owner = $1 or $4 or exists (select 1 from design_shares s where s.design_id = d.id
         and ((s.principal_type = 'user' and s.principal = $2) or (s.principal_type = 'team' and s.principal = any($3::text[]))))
       order by v.created_at desc`,
      [user.id, user.id, user.teams, !!user.local],
    );
    const out = [];
    for (const r of rows) {
      const role = await this.roleOf(user, r);
      if (!role) continue; // shared, but on a pack they no longer see
      out.push({ design_id: r.id, title: r.title, pack_id: r.pack_id, version: r.head, cover: r.cover, artboards: r.artboards, updated_at: r.updated_at, owner: r.owner, role });
    }
    return out;
  }

  // --- sharing: people and teams with a role; the owner manages it -----------------------------

  async shares(user: User, id: string) {
    const d = await this.design(user, id, "viewer");
    const { rows } = await this.db.query<{ principal_type: PrincipalType; principal: string; role: Role; granted_by: string; created_at: string }>(
      "select principal_type, principal, role, granted_by, created_at from design_shares where design_id = $1 order by created_at",
      [id],
    );
    return { owner: d.owner, role: d.role, shares: rows };
  }

  async share(user: User, id: string, type: PrincipalType, principal: string, role: Exclude<Role, "owner">) {
    const d = await this.design(user, id, "owner");
    const p = principal.trim();
    if (!p) throw new Error(`a ${type} share needs the ${type}'s id`);
    if (type === "user" && p === d.owner) throw new Error("the owner already has every right on the design");
    await this.db.query(
      `insert into design_shares (design_id, principal_type, principal, role, granted_by) values ($1, $2, $3, $4, $5)
       on conflict (design_id, principal_type, principal) do update set role = $4, granted_by = $5, created_at = now()`,
      [id, type, p, role, user.id],
    );
    await audit(this.db, user, "share", "design", id, { principal_type: type, principal: p, role });
    return { principal_type: type, principal: p, role };
  }

  async unshare(user: User, id: string, type: PrincipalType, principal: string) {
    await this.design(user, id, "owner");
    const { rows } = await this.db.query("delete from design_shares where design_id = $1 and principal_type = $2 and principal = $3 returning role", [id, type, principal.trim()]);
    if (!rows.length) throw new NotFound(`design ${id} is not shared with ${type} ${JSON.stringify(principal)}`);
    await audit(this.db, user, "unshare", "design", id, { principal_type: type, principal });
    return { principal_type: type, principal };
  }

  // --- comments: on an artboard, or one node of it; replies in a thread ------------------------

  async addComment(user: User, id: string, c: { artboard?: string | undefined; node?: string | undefined; text: string; parent_id?: number | undefined }) {
    const d = await this.design(user, id, "commenter");
    let { artboard, node } = c;
    if (c.parent_id !== undefined) {
      const parent = (await this.db.query<DesignComment>("select * from design_comments where id = $1 and design_id = $2", [c.parent_id, id])).rows[0];
      if (!parent) throw new NotFound(`no comment ${c.parent_id} on design ${id}`);
      if (parent.parent_id !== null) throw new Error("reply to the thread's first comment");
      ({ artboard, node } = { artboard: parent.artboard, node: parent.node ?? undefined });
    }
    const spec = await this.spec(id, d.head);
    if (!artboard || !spec.artboards.some((b) => b.id === artboard)) throw new Error(`no artboard ${JSON.stringify(artboard)}: comment on one of ${spec.artboards.map((b) => b.id).join(", ")}`);
    const { rows } = await this.db.query<DesignComment>(
      `insert into design_comments (design_id, version, artboard, node, text, author, author_name, parent_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [id, d.head, artboard, node ?? null, c.text, user.id, nameOf(user), c.parent_id ?? null],
    );
    await audit(this.db, user, "comment", "design", id, { comment: rows[0]?.id });
    return rows[0] as DesignComment;
  }

  /** Threads (first comment + replies), `status` filtering the threads. */
  async comments(user: User, id: string, status?: "open" | "resolved") {
    await this.design(user, id, "viewer");
    const { rows } = await this.db.query<DesignComment>("select * from design_comments where design_id = $1 order by id", [id]);
    const threads = rows.filter((c) => c.parent_id === null && (!status || c.status === status));
    return threads.map((t) => ({ ...t, replies: rows.filter((c) => c.parent_id === t.id) }));
  }

  /** An editor resolves (or reopens) any thread, a commenter their own. */
  async resolve(user: User, id: string, ids: number[], status: "open" | "resolved" = "resolved") {
    if (!ids.length) return [];
    const d = await this.design(user, id, "commenter");
    const editor = rank(d.role) >= rank("editor");
    const { rows } = await this.db.query<{ id: number }>(
      `update design_comments set status = $3 where design_id = $1 and id = any($2::int[]) and parent_id is null and ($4 or author = $5) returning id`,
      [id, ids, status, editor, user.id],
    );
    if (rows.length !== ids.length) {
      const missing = ids.filter((i) => !rows.some((r) => r.id === i));
      throw new Forbidden(`cannot ${status === "open" ? "reopen" : "resolve"} comment(s) ${missing.join(", ")}: not on this design, a reply, or another person's (editors resolve any)`);
    }
    return rows.map((r) => r.id);
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
      const d = await this.design(user, id, "editor");
      const r = await engine<{ design: DesignSpec }>("design_patch", { pack: d.packDir, design: await this.spec(id, d.head), ops });
      return this.commit(user, d, r.design, note);
    });
  }

  /** Go back to `version` (default: the one before the current), as a new version. */
  restore(user: User, id: string, version?: number) {
    return this.serial(id, async () => {
      const d = await this.design(user, id, "editor");
      const v = version ?? d.head - 1;
      if (v < 1 || v > d.head) throw new Error(`no version ${v} (1..${d.head})`);
      return this.commit(user, d, await this.spec(id, v), `restore v${v}`);
    });
  }

  private async commit(user: User, d: DesignRow & { packDir: string }, spec: DesignSpec, note: string) {
    if (spec.pack_id !== d.pack_id) throw new Error(`a design stays on its pack (${d.pack_id})`);
    // the uploads a change adds must be the caller's; those already in the design stay
    await this.ownFiles(user, spec, await this.spec(d.id, d.head));
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

  /** The caller must own every uploaded file the spec shows that `before` did not. */
  private async ownFiles(user: User, spec: DesignSpec, before?: DesignSpec) {
    const had = new Set(before ? fileRefs(before) : []);
    for (const fid of fileRefs(spec)) if (!had.has(fid)) await getFile(this.db, this.data, user, fid);
  }

  // ponytail: in-process lock, one server instance (as decks.ts)
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(id) ?? Promise.resolve()).then(fn, fn);
    this.locks.set(id, run.catch(() => undefined));
    return run;
  }
}
