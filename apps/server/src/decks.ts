import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DeckSpec, PatchOp } from "@calque/deckspec";
import { audit } from "./audit.ts";
import { recordLint } from "./compliance.ts";
import type { Db } from "./db.ts";
import { engine } from "./engine.ts";
import { copyFile, FILE_REF, getFile, saveFile, uploadPath } from "./files.ts";
import { isAdmin } from "./models.ts";
import { Forbidden, getPack, listPacks, NotFound, visible, type PackRow, type User } from "./packs.ts";

export interface Issue {
  slide: string | null;
  message: string;
}
export interface Hole {
  slide: string;
  shape_id: number;
  was: string;
}
interface BuildReport {
  path: string;
  warnings: Issue[];
  holes: Hole[];
  slides: Record<string, { position: number; source: number }>;
}
export interface Finding {
  severity: "ERROR" | "WARN" | "NOTE";
  slide: number | null;
  slide_id?: string | null;
  shape_id: number | null;
  check: string;
  message: string;
}
export interface ShapeBox {
  shape_id: number;
  bbox_px: [number, number, number, number];
  kind: string;
  role: string;
}
export interface RenderedSlide {
  id: string;
  number: number;
  png: string;
  width_px: number;
  height_px: number;
  shapes: ShapeBox[];
}
export interface Comment {
  id: number;
  deck_id: string;
  version: number;
  slide_id: string;
  shape_id: number | null;
  text: string;
  author: string;
  /** The author's display name (the token's `name` claim), null for a guest or a nameless user. */
  author_name: string | null;
  status: "open" | "resolved";
  /** A thread's weight: a suggestion, or required (blocks approval until resolved, review.ts). */
  type: "suggestion" | "required";
  /** A reply's thread: the comment it answers (replies have no status of their own). */
  parent_id: number | null;
  created_at: string;
}
export type Thread = Comment & { replies: Comment[] };

/** The name versions and comments show for `user`: their display name, never for a guest. */
const nameOf = (user: User) => (user.anonymous ? null : (user.name ?? null));

interface DeckRow {
  id: string;
  pack_id: string;
  owner: string;
  /** The current DeckSpec's title. */
  title: string;
  /** The name set by rename_deck, shown instead of `title`; null: none. */
  name: string | null;
  head: number;
  general_access: GeneralAccess;
  general_role: "viewer" | "commenter";
  link_key: string;
  approval: "draft" | "in_review" | "approved";
  /** The pack release the deck was created on. */
  pack_version: number | null;
  /** The deck's type (internal, external, marketing…): approval may apply to some types only (review.ts). */
  kind: string | null;
}

/** What an import recognised: slides kept drawn, imported as clones, demoted (and why), and
drawn slides changed in Calque after the file was exported (the file wins). */
export interface ImportReport {
  drawn: string[];
  imported: string[];
  demoted: { slide: string; reason: string }[];
  conflicts: { slide: string; reason: string }[];
}

export class Conflict extends Error {}

/** Every `file:<id>` image reference in a DeckSpec's clone values, rewritten by `fn`. */
function mapFileRefs(spec: DeckSpec, fn: (id: string) => string): DeckSpec {
  return {
    ...spec,
    slides: spec.slides.map((s) => {
      if (s.source.kind !== "clone") return s;
      const values = Object.fromEntries(
        Object.entries(s.source.values).map(([k, v]) =>
          v && typeof v === "object" && !Array.isArray(v) && v.image?.startsWith(FILE_REF) ? [k, { ...v, image: fn(v.image.slice(FILE_REF.length)) }] : [k, v],
        ),
      );
      return { ...s, source: { ...s.source, values } };
    }),
  };
}

/** What a caller may do on a deck, each role including the ones before it. */
export const ROLES = ["viewer", "commenter", "editor", "owner"] as const;
export type Role = (typeof ROLES)[number];

const rank = (r: Role) => ROLES.indexOf(r);

/** Who the deck's share link opens for, besides its owner and the people and teams it is shared
with: nobody else, anyone signed in who sees its pack, or anyone at all. */
export type GeneralAccess = "private" | "workspace" | "anyone";
type Sharing = { id: string; owner: string; pack_id: string; general_access: GeneralAccess; general_role: "viewer" | "commenter"; link_key: string };

/** The best role `user` holds on each of `ids` through a share: to them or to one of their teams. */
export async function granted(db: Db, user: User, ids: string[]): Promise<Map<string, Role>> {
  const out = new Map<string, Role>();
  if (!ids.length || user.anonymous) return out;
  const { rows } = await db.query<{ deck_id: string; role: Role }>(
    `select deck_id, role from deck_shares where deck_id = any($1::uuid[])
       and ((principal_type = 'user' and principal = $2) or (principal_type = 'team' and principal = any($3::text[])))`,
    [ids, user.id, user.teams],
  );
  for (const r of rows) {
    const had = out.get(r.deck_id);
    if (!had || rank(r.role) > rank(had)) out.set(r.deck_id, r.role);
  }
  return out;
}

/** Whether `user` presented deck `deck`'s current share link key. */
function presents(user: User, deck: Sharing): boolean {
  const [got, want] = [Buffer.from(user.key ?? ""), Buffer.from(deck.link_key)];
  return !!user.key && got.length === want.length && timingSafeEqual(got, want);
}

/** The caller's role on a deck, null: none (the deck does not exist for them). The best of: owner;
a share to them or their team, while they see the deck's pack; the general role if they present
the deck's share link key and its general access lets them in ("workspace": signed in and seeing
the pack, "anyone": anybody). The local user owns every deck. Admins get nothing here: they manage
a deck's access without reading it. */
export async function access(db: Db, user: User, deck: Sharing): Promise<Role | null> {
  const link = presents(user, deck);
  if (user.anonymous) return link && deck.general_access === "anyone" ? deck.general_role : null;
  if (user.local || deck.owner === user.id) return "owner";
  const { rows } = await db.query<PackRow>("select * from packs where id = $1", [deck.pack_id]);
  const sees = !!rows[0] && visible(rows[0], user);
  let best = (sees && (await granted(db, user, [deck.id])).get(deck.id)) || null;
  if (link && (deck.general_access === "anyone" || (deck.general_access === "workspace" && sees)) && (!best || rank(deck.general_role) > rank(best)))
    best = deck.general_role;
  return best;
}

/** Deck versions, their built PPTX and renders. Every change is a new DeckSpec version. */
export class Decks {
  readonly db: Db;
  readonly data: string;
  private readonly renders = new Map<string, Promise<RenderedSlide[]>>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(db: Db, data: string) {
    this.db = db;
    this.data = data;
  }

  dir(id: string): string {
    return join(this.data, "decks", id);
  }

  pptx(id: string, version: number): string {
    return join(this.dir(id), `v${version}.pptx`);
  }

  /** The imported deck `base` of deck `id`: a file in that deck's own folder, never elsewhere. */
  basePath(id: string, base: string): string {
    const path = resolve(this.dir(id), base);
    if (dirname(path) !== resolve(this.dir(id))) throw new Error(`base ${JSON.stringify(base)} is not a file of this deck`);
    return path;
  }

  /** Deck `id`, if `user` has at least role `need` on it. */
  async deck(user: User, id: string, need: Role): Promise<DeckRow & { packDir: string; role: Role }> {
    const { rows } = await this.db.query<DeckRow>("select * from decks where id = $1", [id]).catch(() => ({ rows: [] }));
    const row = rows[0];
    const role = row ? await access(this.db, user, row) : null;
    // a deck the caller has no access to does not exist for them
    if (!row || !role) throw new NotFound(`no deck ${JSON.stringify(id)}`);
    if (rank(role) < rank(need)) throw new Forbidden(`${need} access needed on deck ${id}`);
    // a deck on a hidden pack is hidden too, except through an "Anyone with the link" link
    const pack =
      user.anonymous || (row.general_access === "anyone" && presents(user, row))
        ? ((await this.db.query<PackRow>("select * from packs where id = $1", [row.pack_id])).rows[0] as PackRow)
        : await getPack(this.db, user, row.pack_id);
    return { ...row, title: row.name ?? row.title, packDir: pack.dir, role };
  }

  /** The user's decks and the decks shared with them, with their role, newest change first (decks
  on packs they no longer see are left out). `pack_id` keeps the decks on that pack; `query` the
  decks whose name or current slides' text contain every word of it (case and accents ignored), so
  a client's name finds the decks made for it. */
  async list(user: User, filter: { query?: string | undefined; pack_id?: string | undefined } = {}) {
    const { rows } = await this.db.query<DeckRow & { updated_at: string; spec: DeckSpec }>(
      `select d.*, v.created_at as updated_at, v.spec from decks d
       join deck_versions v on v.deck_id = d.id and v.version = d.head
       where (d.owner = $1 or d.id in (select deck_id from deck_shares
         where (principal_type = 'user' and principal = $1) or (principal_type = 'team' and principal = any($2::text[]))))
         and ($3::text is null or d.pack_id = $3)
       order by v.created_at desc`,
      [user.id, user.teams, filter.pack_id || null],
    );
    const seen = new Set((await listPacks(this.db, user, { archived: true })).map((p) => p.id));
    const words = fold(filter.query ?? "").split(/\s+/).filter(Boolean);
    const matches = (r: DeckRow & { spec: DeckSpec }) => {
      if (!words.length) return true;
      const text = fold([r.name ?? "", ...strings(r.spec)].join("\n"));
      return words.every((w) => text.includes(w));
    };
    const grants = await granted(this.db, user, rows.filter((r) => r.owner !== user.id).map((r) => r.id));
    return rows
      .filter((r) => seen.has(r.pack_id) && matches(r))
      .map(({ id, pack_id, pack_version, owner, title, name, head, updated_at, kind }) => ({
        id,
        pack_id,
        pack_version,
        kind,
        owner,
        title: name ?? title,
        head,
        updated_at,
        role: owner === user.id ? ("owner" as Role) : (grants.get(id) as Role),
      }));
  }

  /** Name deck `id` (an editor): lists and the editor show it instead of its DeckSpec title. No new
  version, the slides do not change. An empty name goes back to the DeckSpec title. */
  async rename(user: User, id: string, name: string) {
    const deck = await this.deck(user, id, "editor");
    const next = name.trim() || null;
    await this.db.query("update decks set name = $2 where id = $1", [id, next]);
    await audit(this.db, user, "rename", "deck", id, { from: deck.title, to: next });
    const { rows } = await this.db.query<{ title: string }>("select coalesce(name, title) as title from decks where id = $1", [id]);
    return { deck_id: id, title: rows[0]?.title ?? deck.title };
  }

  /** A new deck owned by `user` (a viewer of `id`): a copy of `id`'s current version, as its v1. The
  history, comments and shares stay with the original. The imported file comes along, and the
  uploaded images it places are copied to `user`'s uploads. */
  async duplicate(user: User, id: string, name?: string) {
    if (user.anonymous) throw new Forbidden("sign in to duplicate a deck");
    const src = await this.deck(user, id, "viewer");
    let spec = await this.spec(id, src.head);
    const copy = randomUUID();
    await mkdir(this.dir(copy), { recursive: true });
    try {
      if (spec.base) await cp(this.basePath(id, spec.base), join(this.dir(copy), spec.base));
      const refs = new Map<string, string>();
      mapFileRefs(spec, (fid) => (refs.set(fid, fid), fid));
      for (const fid of refs.keys()) {
        const { rows } = await this.db.query<{ name: string; type: string }>("select name, type from files where id = $1", [fid]);
        if (!rows[0]) throw new NotFound(`deck ${id} places file ${fid}, which no longer exists`);
        const f = await saveFile(this.db, this.data, user, rows[0].name, rows[0].type, await readFile(uploadPath(this.data, fid)));
        refs.set(fid, f.file_id);
      }
      spec = mapFileRefs(spec, (fid) => `${FILE_REF}${refs.get(fid) ?? fid}`);
      const r = await this.create(user, spec, `duplicate of ${src.title} v${src.head}`, copy);
      const title = name?.trim() || `${src.title} (copy)`;
      await this.db.query("update decks set name = $2 where id = $1", [copy, title]);
      return { ...r, title, duplicated_from: id };
    } catch (e) {
      await rm(this.dir(copy), { recursive: true, force: true });
      throw e;
    }
  }

  async spec(id: string, version: number): Promise<DeckSpec> {
    const { rows } = await this.db.query<{ spec: DeckSpec }>(
      "select spec from deck_versions where deck_id = $1 and version = $2",
      [id, version],
    );
    if (!rows[0]) throw new NotFound(`deck ${id} has no version ${version}`);
    return rows[0].spec;
  }

  async versions(id: string) {
    const { rows } = await this.db.query<{ version: number; note: string; author: string; author_name: string | null; created_at: string }>(
      "select version, note, author, author_name, created_at from deck_versions where deck_id = $1 order by version",
      [id],
    );
    return rows;
  }

  /** New deck: builds before anything is stored, so a deck that does not build is never saved. */
  async create(user: User, spec: DeckSpec, note: string, id: string = randomUUID()) {
    const pack = await getPack(this.db, user, spec.pack_id);
    if (pack.archived) throw new Error(`pack ${spec.pack_id} is archived: no new decks on it`);
    await this.ownFiles(user, spec);
    await mkdir(this.dir(id), { recursive: true });
    const report = await this.build(pack.dir, id, spec, 1);
    await this.db.query("insert into decks (id, pack_id, owner, title, head, pack_version, owner_teams) values ($1, $2, $3, $4, 1, $5, $6)", [
      id,
      spec.pack_id,
      user.id,
      spec.title,
      pack.version,
      JSON.stringify(user.teams),
    ]);
    await this.db.query(
      "insert into deck_versions (deck_id, version, spec, note, author, author_name) values ($1, 1, $2, $3, $4, $5)",
      [id, JSON.stringify(spec), note, user.id, nameOf(user)],
    );
    await audit(this.db, user, "create", "deck", id, { title: spec.title, pack_id: spec.pack_id, note });
    return { deck_id: id, version: 1, ...summary(report) };
  }

  /** Run one mutation of deck `id` at a time: versions are built to `v<n>.pptx` before commit. */
  // ponytail: in-process lock, one server instance; a Postgres advisory lock for several.
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(id) ?? Promise.resolve()).then(fn, fn);
    this.locks.set(id, run.catch(() => undefined));
    return run;
  }

  /** Store `spec` as the next version of `id`, if `id` is still at `from` (else Conflict). */
  async commit(user: User, id: string, from: number, spec: DeckSpec, note: string, undoTo: number | null = from) {
    const deck = await this.deck(user, id, "editor");
    // a version on another pack is a re-brand (or a restore across one): the caller must see it
    const packDir = spec.pack_id === deck.pack_id ? deck.packDir : (await getPack(this.db, user, spec.pack_id)).dir;
    await this.ownFiles(user, spec);
    const next = from + 1;
    const report = await this.build(packDir, id, spec, next);
    // an approval is for the version approved: a change sends the deck back to draft (review.ts);
    // a commit on another pack (rebrand_deck, or restoring a version from before it) moves the deck
    const { rows } = await this.db.query(
      `update decks set head = $3, title = $4, approval = case when approval = 'approved' then 'draft' else approval end,
         pack_version = case when pack_id = $5 then pack_version else (select version from packs where id = $5) end, pack_id = $5
       where id = $1 and head = $2 returning head`,
      [id, from, next, spec.title, spec.pack_id],
    );
    if (!rows.length) throw new Conflict(`deck ${id} changed since version ${from}: reopen it and retry`);
    await this.db.query(
      "insert into deck_versions (deck_id, version, spec, note, author, author_name, undo_to) values ($1, $2, $3, $4, $5, $6, $7)",
      [id, next, JSON.stringify(spec), note, user.id, nameOf(user), undoTo],
    );
    await audit(this.db, user, "edit", "deck", id, { version: next, note });
    return { deck_id: id, version: next, ...summary(report) };
  }

  patch(user: User, id: string, ops: PatchOp[], note: string) {
    return this.serial(id, () => this.patchNow(user, id, ops, note));
  }

  private async patchNow(user: User, id: string, ops: PatchOp[], note: string) {
    const deck = await this.deck(user, id, "editor");
    const spec = await this.spec(id, deck.head);
    const res = await engine<{ deck: DeckSpec }>("patch", { pack: deck.packDir, deck: spec, ops });
    return this.commit(user, id, deck.head, res.deck, note);
  }

  /** Back to `version` as a new version; no version = undo the last change. */
  restore(user: User, id: string, version?: number) {
    return this.serial(id, () => this.restoreNow(user, id, version));
  }

  private async restoreNow(user: User, id: string, version?: number) {
    const deck = await this.deck(user, id, "editor");
    let target = version;
    if (target === undefined) {
      const { rows } = await this.db.query<{ undo_to: number | null }>(
        "select undo_to from deck_versions where deck_id = $1 and version = $2",
        [id, deck.head],
      );
      if (rows[0]?.undo_to == null) throw new Error("nothing to undo");
      target = rows[0].undo_to;
    }
    const { rows } = await this.db.query<{ undo_to: number | null }>(
      "select undo_to from deck_versions where deck_id = $1 and version = $2",
      [id, target],
    );
    if (!rows[0]) throw new NotFound(`deck ${id} has no version ${target}`);
    // undoing the restore walks on back from the restored version
    return this.commit(user, id, deck.head, await this.spec(id, target), `restore v${target}`, rows[0].undo_to);
  }

  /** A DeckSpec may only place the uploaded files of the user writing it. */
  private async ownFiles(user: User, spec: DeckSpec) {
    const ids: string[] = [];
    mapFileRefs(spec, (fid) => (ids.push(fid), fid));
    for (const fid of ids) await getFile(this.db, this.data, user, fid);
  }

  /** Build version `version` (cached on disk with its report). */
  async build(packDir: string, id: string, spec: DeckSpec, version: number): Promise<BuildReport> {
    const out = this.pptx(id, version);
    const meta = `${out}.json`;
    if (existsSync(meta)) return JSON.parse(await readFile(meta, "utf8"));
    const tmp = `${out}.${randomUUID()}.tmp.pptx`;
    const base = spec.base ? this.basePath(id, spec.base) : undefined;
    // images come from the deck's folder, uploads or the pack, nowhere else on the server
    const image_roots = [this.dir(id), join(this.data, "uploads"), packDir];
    try {
      // `file:<id>` images are the user's uploads: the engine finds `<id>` under the uploads root
      const deck = mapFileRefs(spec, (fid) => fid);
      const report = await engine<BuildReport>("build", { pack: packDir, deck, out: tmp, base, image_roots });
      await rename(tmp, out);
      await writeFile(meta, JSON.stringify({ ...report, path: out }));
      return { ...report, path: out };
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async report(user: User, id: string, version?: number) {
    const deck = await this.deck(user, id, "viewer");
    const v = version ?? deck.head;
    const spec = await this.spec(id, v);
    // a version from before a re-brand builds and lints on its own pack
    const packDir = spec.pack_id === deck.pack_id ? deck.packDir : (await getPack(this.db, user, spec.pack_id)).dir;
    return { deck: { ...deck, packDir }, version: v, spec, report: await this.build(packDir, id, spec, v) };
  }

  async lint(user: User, id: string, version?: number): Promise<{ version: number; findings: Finding[]; safe_checks: string[] }> {
    const { deck, version: v, spec, report } = await this.report(user, id, version);
    const byPos = new Map(Object.entries(report.slides).map(([sid, s]) => [s.position, sid]));
    // template slide numbers only mean something for slides cloned from the pack template
    const sources = spec.base
      ? undefined
      : Object.fromEntries(Object.values(report.slides).map((s) => [String(s.position), s.source]));
    const res = await engine<{ findings: Finding[]; safe_checks: string[] }>("lint", {
      pack: deck.packDir,
      pptx: report.path,
      language: spec.language,
      sources,
    });
    await recordLint(this.db, id, v, res.findings);
    return { version: v, safe_checks: res.safe_checks, findings: res.findings.map((f) => ({ ...f, slide_id: f.slide ? (byPos.get(f.slide) ?? null) : null })) };
  }

  /** PNG per slide + shape map. Renders go to one directory per deck: the engine only redraws
  slides whose content changed. */
  async render(user: User, id: string, version?: number): Promise<{ version: number; slides: RenderedSlide[] }> {
    const { deck, version: v, spec, report } = await this.report(user, id, version);
    const key = `${id}@${v}`;
    let job = this.renders.get(key);
    if (!job) {
      const sources = spec.base
        ? undefined
        : Object.fromEntries(Object.values(report.slides).map((s) => [String(s.position), s.source]));
      const ids = new Map(Object.entries(report.slides).map(([sid, s]) => [s.position, sid]));
      job = engine<{ slides: { number: number; width_px: number; height_px: number; shapes: ShapeBox[] }[] }>("render", {
        pack: deck.packDir,
        pptx: report.path,
        out_dir: join(this.dir(id), "render"),
        sources,
      }).then((r) =>
        r.slides.map((s) => ({
          ...s,
          id: ids.get(s.number) ?? `s${s.number}`,
          png: join(this.dir(id), "render", `slide-${s.number}.png`),
        })),
      );
      job.catch(() => this.renders.delete(key));
      // ponytail: one render dir per deck, so only the latest rendered version keeps its PNGs
      this.renders.clear();
      this.renders.set(key, job);
    }
    return { version: v, slides: await job };
  }

  /** Apply the engine's safe fixes to the imported base; a new version points at the fixed copy. */
  fixBase(user: User, id: string) {
    return this.serial(id, () => this.fixBaseNow(user, id));
  }

  private async fixBaseNow(user: User, id: string) {
    const deck = await this.deck(user, id, "editor");
    const spec = await this.spec(id, deck.head);
    if (!spec.base) return { applied: [] as unknown[], version: deck.head };
    const name = `base-v${deck.head + 1}.pptx`;
    const res = await engine<{ applied: unknown[] }>("fix", {
      pack: deck.packDir,
      pptx: this.basePath(id, spec.base),
      out: join(this.dir(id), name),
    });
    if (!res.applied.length) {
      await rm(join(this.dir(id), name), { force: true });
      return { applied: [], version: deck.head };
    }
    const done = await this.commit(user, id, deck.head, { ...spec, base: name }, `review: ${res.applied.length} safe fixes`);
    return { applied: res.applied, version: done.version };
  }

  async importPptx(user: User, file: string, packId: string, language: string) {
    const pack = await getPack(this.db, user, packId);
    const id = randomUUID();
    await mkdir(this.dir(id), { recursive: true });
    const res = await engine<{ deck: DeckSpec; report: ImportReport }>("import", { pack: pack.dir, pptx: file, dest: this.dir(id), language });
    return { ...(await this.create(user, res.deck, "import", id)), import: res.report };
  }

  /** Re-import a PPTX edited in PowerPoint into deck `id`, as its next version: slides the engine
  tagged keep their ids (comments stay anchored), drawn slides stay drawn with the edits merged. */
  reimport(user: User, id: string, file: string, language?: string) {
    return this.serial(id, () => this.reimportNow(user, id, file, language));
  }

  private async reimportNow(user: User, id: string, file: string, language?: string) {
    const deck = await this.deck(user, id, "editor");
    const spec = await this.spec(id, deck.head);
    // a new base per version: older versions keep building on theirs
    const base = `base-v${deck.head + 1}-${randomUUID().slice(0, 8)}.pptx`;
    const res = await engine<{ deck: DeckSpec; report: ImportReport }>("import", {
      pack: deck.packDir,
      pptx: file,
      dest: this.dir(id),
      language: language ?? spec.language,
      base_id: base,
      previous: spec,
    });
    try {
      return { ...(await this.commit(user, id, deck.head, res.deck, "re-import from PowerPoint")), import: res.report };
    } catch (e) {
      await rm(join(this.dir(id), base), { force: true });
      throw e;
    }
  }

  /** Move deck `id` to pack `packId` as its next version (engine `rebrand`): drawn slides redraw
  on the new pack, template clones move by role; imported clones cannot move (`drop` leaves them
  out). Older versions stay on the old pack, and restoring one moves the deck back. */
  rebrand(user: User, id: string, packId: string, drop = false) {
    return this.serial(id, () => this.rebrandNow(user, id, packId, drop));
  }

  private async rebrandNow(user: User, id: string, packId: string, drop: boolean) {
    const deck = await this.deck(user, id, "editor");
    if (packId === deck.pack_id) throw new Error(`deck ${id} is already on ${packId}`);
    const to = await getPack(this.db, user, packId);
    const spec = await this.spec(id, deck.head);
    const res = await engine<{ deck: DeckSpec; report: Record<string, unknown> }>("rebrand", {
      pack: deck.packDir,
      to_pack: to.dir,
      deck: spec,
      drop,
    });
    const r = await this.commit(user, id, deck.head, res.deck, `re-brand ${deck.pack_id} -> ${packId}`);
    return { ...r, rebrand: res.report };
  }

  /** Copy slides of deck `from` (viewer access) into deck `to` (editor access) at `at`, as the next
  version of `to`. Drawn slides copy to any pack (they are redrawn on the target's); template and
  imported clones only to a deck on the same pack. Imported slides are grafted into the target's
  base file. Ids taken in the target get a `-copy` suffix; the result maps old ids to new ones.
  Images uploaded by someone else are copied to the caller's uploads. `reader`: who must be able to
  read `from` (default the caller; the slide library reads its own decks, library.ts). */
  copySlides(user: User, from: string, ids: string[], to: string, at?: number, version?: number, reader: User = user) {
    return this.serial(to, () => this.copyNow(user, from, ids, to, at, version, reader));
  }

  /** `slides` with the `file:<id>` images `user` does not own rewritten to copies of their own. */
  private async adoptFiles(user: User, slides: DeckSpec["slides"]): Promise<DeckSpec["slides"]> {
    const ids = new Set<string>();
    mapFileRefs({ slides } as DeckSpec, (fid) => (ids.add(fid), fid));
    const copies = new Map<string, string>();
    for (const fid of ids) {
      const mine = await getFile(this.db, this.data, user, fid).then(
        () => true,
        () => false,
      );
      if (!mine) copies.set(fid, (await copyFile(this.db, this.data, user, fid)).file_id);
    }
    return copies.size ? mapFileRefs({ slides } as DeckSpec, (fid) => `${FILE_REF}${copies.get(fid) ?? fid}`).slides : slides;
  }

  /** A one-slide deck owned by `owner` (a slide library's), holding a copy of slide `slideId` of
  deck `from` (viewer access): its images copied to `owner`, an imported slide grafted into a file
  of its own. Returns the new deck's id. */
  async snapshot(user: User, from: string, slideId: string, owner: User, title: string): Promise<string> {
    const src = await this.deck(user, from, "viewer");
    const spec = await this.spec(from, src.head);
    const found = spec.slides.find((x) => x.id === slideId);
    if (!found) throw new NotFound(`deck ${from} has no slide ${JSON.stringify(slideId)}`);
    const [slide] = (await this.adoptFiles(owner, [structuredClone(found)])) as [DeckSpec["slides"][number]];
    const id = randomUUID();
    await mkdir(this.dir(id), { recursive: true });
    const one: DeckSpec = { ...spec, title, slides: [slide] };
    delete one.base;
    try {
      if (slide.source.kind === "clone" && slide.source.from === "base") {
        if (!spec.base) throw new Error(`deck ${from} has no imported file`);
        one.base = "base.pptx";
        const res = await engine<{ slides: number[] }>("graft", {
          pack: src.packDir,
          out: join(this.dir(id), one.base),
          sources: [{ pptx: this.basePath(from, spec.base), slide: slide.source.slide }],
        });
        slide.source.slide = res.slides[0] as number;
      }
      await this.create(owner, one, `from ${src.title}`, id);
    } catch (e) {
      await rm(this.dir(id), { recursive: true, force: true });
      throw e;
    }
    return id;
  }

  private async copyNow(user: User, from: string, ids: string[], to: string, at?: number, version?: number, reader: User = user) {
    const src = await this.deck(reader, from, "viewer");
    const srcSpec = await this.spec(from, version ?? src.head);
    const dst = await this.deck(user, to, "editor");
    const spec = structuredClone(await this.spec(to, dst.head));
    const picked = ids.map((sid) => {
      const s = srcSpec.slides.find((x) => x.id === sid);
      if (!s) throw new NotFound(`deck ${from} has no slide ${JSON.stringify(sid)}`);
      return structuredClone(s);
    });
    picked.splice(0, picked.length, ...(await this.adoptFiles(user, picked)));
    const clones = picked.filter((s) => s.source.kind === "clone");
    if (clones.length && src.pack_id !== dst.pack_id)
      throw new Error(
        `slides ${clones.map((s) => s.id).join(", ")} are cloned from the ${src.pack_id} template or an imported file: ` +
          `they copy only to a deck on ${src.pack_id} (charts, diagrams and compositions copy to any pack)`,
      );
    const taken = new Set(spec.slides.map((s) => s.id));
    const renamed: Record<string, string> = {};
    for (const s of picked) {
      let sid = s.id;
      for (let k = 1; taken.has(sid); k++) sid = `${s.id}-copy${k > 1 ? k : ""}`;
      taken.add(sid);
      renamed[s.id] = sid;
      s.id = sid;
    }
    const grafted = picked.filter((s) => s.source.kind === "clone" && s.source.from === "base");
    let base: string | undefined;
    if (grafted.length) {
      if (!srcSpec.base) throw new Error(`deck ${from} has no imported file`);
      base = `base-v${dst.head + 1}-${randomUUID().slice(0, 8)}.pptx`;
      const res = await engine<{ slides: number[] }>("graft", {
        pack: dst.packDir,
        base: spec.base ? this.basePath(to, spec.base) : undefined,
        out: join(this.dir(to), base),
        sources: grafted.map((s) => ({ pptx: this.basePath(from, srcSpec.base as string), slide: (s.source as { slide: number }).slide })),
      });
      grafted.forEach((s, i) => ((s.source as { slide: number }).slide = res.slides[i] as number));
      spec.base = base;
    }
    const last = spec.slides.at(-1);
    const pos = Math.min(at ?? (last?.message_type === "closing" ? spec.slides.length - 1 : spec.slides.length), spec.slides.length);
    spec.slides.splice(pos, 0, ...picked);
    try {
      const r = await this.commit(user, to, dst.head, spec, `copy ${picked.length} slide(s) from ${src.title}`);
      return { ...r, copied: renamed };
    } catch (e) {
      if (base) await rm(join(this.dir(to), base), { force: true });
      throw e;
    }
  }

  async exportPath(user: User, id: string, version?: number): Promise<{ version: number; path: string }> {
    const { version: v, report } = await this.report(user, id, version);
    await audit(this.db, user, "export", "deck", id, { version: v });
    return { version: v, path: report.path };
  }

  /** The version as a PDF, rendered by LibreOffice as the previews are; redone when the PPTX is newer. */
  async exportPdf(user: User, id: string, version?: number): Promise<{ version: number; path: string }> {
    const { deck, version: v, report } = await this.report(user, id, version);
    const out = join(this.dir(id), `v${v}.pdf`);
    if (!existsSync(out) || statSync(out).mtimeMs < statSync(report.path).mtimeMs)
      await engine("pdf", { pack: deck.packDir, pptx: report.path, out });
    return { version: v, path: out };
  }

  /** Erase deck `id`: its versions, comments, shares, agent conversation and every file under its folder (built PPTX,
  renders, imported base). The owner, or a signed-in admin. The audit log keeps that it existed. */
  remove(user: User, id: string) {
    return this.serial(id, () => this.removeNow(user, id));
  }

  private async removeNow(user: User, id: string) {
    const { rows } = await this.db.query<DeckRow>("select * from decks where id = $1", [id]).catch(() => ({ rows: [] as DeckRow[] }));
    const row = rows[0];
    const role = row ? await access(this.db, user, row) : null;
    const admin = !user.anonymous && isAdmin(user);
    if (!row || (!role && !admin)) throw new NotFound(`no deck ${JSON.stringify(id)}`);
    if (role !== "owner" && !admin) throw new Forbidden(`owner access needed on deck ${id}`);
    for (const t of ["comments", "deck_shares", "deck_lint", "chats", "deck_versions"]) await this.db.query(`delete from ${t} where deck_id = $1`, [id]);
    await this.db.query("delete from decks where id = $1", [id]);
    await rm(this.dir(id), { recursive: true, force: true });
    for (const k of this.renders.keys()) if (k.startsWith(`${id}@`)) this.renders.delete(k);
    await audit(this.db, user, "delete", "deck", id, { title: row.title, owner: row.owner, pack_id: row.pack_id });
    return { deck_id: id, deleted: true };
  }

  /** A comment on a slide (or one shape), or with `parent_id` a reply in that comment's thread.
  `type` "required" marks a thread that blocks approval until resolved (a reply is never required). */
  async addComment(
    user: User,
    id: string,
    c: { slide_id?: string | undefined; shape_id?: number | null | undefined; text: string; parent_id?: number | undefined; type?: Comment["type"] | undefined },
  ) {
    const deck = await this.deck(user, id, "commenter");
    let anchor = { slide_id: c.slide_id, shape_id: c.shape_id ?? null };
    if (c.parent_id !== undefined) {
      const { rows } = await this.db.query<Comment>("select * from comments where deck_id = $1 and id = $2", [id, c.parent_id]);
      const parent = rows[0];
      if (!parent) throw new NotFound(`deck ${id} has no comment ${c.parent_id}`);
      if (parent.parent_id !== null) throw new Error("reply to the thread's first comment: threads are one level deep");
      anchor = { slide_id: parent.slide_id, shape_id: parent.shape_id };
    }
    if (!anchor.slide_id) throw new Error("a comment needs a slide_id (or a parent_id to reply)");
    const { rows } = await this.db.query<Comment>(
      `insert into comments (deck_id, version, slide_id, shape_id, text, author, author_name, parent_id, type) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning *`,
      [id, deck.head, anchor.slide_id, anchor.shape_id, c.text, user.anonymous ? "guest" : user.id, nameOf(user), c.parent_id ?? null, c.parent_id === undefined ? (c.type ?? "suggestion") : "suggestion"],
    );
    return rows[0] as Comment;
  }

  /** The deck's comment threads (first comment + its replies), by the first comment's status. */
  async comments(user: User, id: string, status?: "open" | "resolved"): Promise<Thread[]> {
    await this.deck(user, id, "viewer");
    const { rows } = await this.db.query<Comment>("select * from comments where deck_id = $1 order by id", [id]);
    const threads = rows.filter((c) => c.parent_id === null && (!status || c.status === status)).map((c) => ({ ...c, replies: [] as Comment[] }));
    const byId = new Map(threads.map((t) => [t.id, t]));
    for (const r of rows) if (r.parent_id !== null) byId.get(r.parent_id)?.replies.push(r);
    return threads;
  }

  /** Resolve (or reopen) comment threads `ids`; returns the ids changed (unknown ids are skipped).
  An editor may close any thread, a signed-in commenter only the ones they started. */
  async resolve(user: User, id: string, ids: number[], status: "open" | "resolved" = "resolved") {
    const deck = await this.deck(user, id, "commenter");
    if (!ids.length) return [];
    const { rows } = await this.db.query<{ id: number; author: string }>(
      "select id, author from comments where deck_id = $1 and id = any($2) and parent_id is null",
      [id, ids],
    );
    const others = rows.filter((c) => user.anonymous || c.author !== user.id).map((c) => c.id);
    if (rank(deck.role) < rank("editor") && others.length)
      throw new Forbidden(`editor access needed to ${status === "open" ? "reopen" : "resolve"} others' comments: ${others.join(", ")}`);
    const found = rows.map((c) => c.id);
    if (found.length) await this.db.query("update comments set status = $3 where deck_id = $1 and id = any($2)", [id, found, status]);
    return found;
  }
}

/** Lowercase, accents off: "Société" finds "societe". */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The text a DeckSpec carries: its title and every string in its slides. */
function strings(spec: DeckSpec): string[] {
  const out = [spec.title];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(spec.slides);
  return out;
}

function summary(r: BuildReport) {
  return { slides: Object.keys(r.slides), warnings: r.warnings, holes: r.holes };
}
