import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeckSpec, PatchOp } from "@calque/deckspec";
import type { Db } from "./db.ts";
import { engine } from "./engine.ts";
import { Forbidden, getPack, listPacks, NotFound, type User } from "./packs.ts";

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
  status: "open" | "resolved";
  created_at: string;
}

interface DeckRow {
  id: string;
  pack_id: string;
  owner: string;
  title: string;
  head: number;
}

export class Conflict extends Error {}

/** What a caller may do on a deck, each role including the ones before it. */
export const ROLES = ["viewer", "commenter", "editor", "owner"] as const;
export type Role = (typeof ROLES)[number];

/** The caller's role on a deck, null: none (the deck does not exist for them). A preview link's
guest has its link's role on that one deck, never more than whoever minted it still has; the local
user owns every deck. */
export function access(user: User, deck: { id: string; owner: string }): Role | null {
  const own: Role | null = user.local || deck.owner === user.id ? "owner" : null;
  if (!user.guest) return own;
  if (!own || user.guest.deck !== deck.id) return null;
  return ROLES[Math.min(ROLES.indexOf(own), ROLES.indexOf(user.guest.role))] ?? null;
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

  /** Deck `id`, if `user` has at least role `need` on it. */
  async deck(user: User, id: string, need: Role): Promise<DeckRow & { packDir: string; role: Role }> {
    const { rows } = await this.db.query<DeckRow>("select * from decks where id = $1", [id]).catch(() => ({ rows: [] }));
    const row = rows[0];
    const role = row ? access(user, row) : null;
    // a deck the caller has no access to does not exist for them
    if (!row || !role) throw new NotFound(`no deck ${JSON.stringify(id)}`);
    if (ROLES.indexOf(role) < ROLES.indexOf(need)) throw new Forbidden(`${need} access needed on deck ${id}`);
    const pack = await getPack(this.db, user, row.pack_id); // a deck on a hidden pack is hidden too
    return { ...row, packDir: pack.dir, role };
  }

  /** The user's decks, newest change first (decks on packs they no longer see are left out). */
  async list(user: User) {
    const { rows } = await this.db.query<DeckRow & { updated_at: string }>(
      `select d.*, v.created_at as updated_at from decks d
       join deck_versions v on v.deck_id = d.id and v.version = d.head
       where d.owner = $1 order by v.created_at desc`,
      [user.id],
    );
    const seen = new Set((await listPacks(this.db, user)).map((p) => p.id));
    return rows.filter((r) => seen.has(r.pack_id)).map(({ id, pack_id, title, head, updated_at }) => ({ id, pack_id, title, head, updated_at }));
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
    const { rows } = await this.db.query<{ version: number; note: string; author: string; created_at: string }>(
      "select version, note, author, created_at from deck_versions where deck_id = $1 order by version",
      [id],
    );
    return rows;
  }

  /** New deck: builds before anything is stored, so a deck that does not build is never saved. */
  async create(user: User, spec: DeckSpec, note: string, id: string = randomUUID()) {
    const pack = await getPack(this.db, user, spec.pack_id);
    await mkdir(this.dir(id), { recursive: true });
    const report = await this.build(pack.dir, id, spec, 1);
    await this.db.query("insert into decks (id, pack_id, owner, title, head) values ($1, $2, $3, $4, 1)", [
      id,
      spec.pack_id,
      user.id,
      spec.title,
    ]);
    await this.db.query(
      "insert into deck_versions (deck_id, version, spec, note, author) values ($1, 1, $2, $3, $4)",
      [id, JSON.stringify(spec), note, user.id],
    );
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
    if (spec.pack_id !== deck.pack_id) throw new Error("a deck stays on its pack");
    const next = from + 1;
    const report = await this.build(deck.packDir, id, spec, next);
    const { rows } = await this.db.query(
      "update decks set head = $3, title = $4 where id = $1 and head = $2 returning head",
      [id, from, next, spec.title],
    );
    if (!rows.length) throw new Conflict(`deck ${id} changed since version ${from}: reopen it and retry`);
    await this.db.query(
      "insert into deck_versions (deck_id, version, spec, note, author, undo_to) values ($1, $2, $3, $4, $5, $6)",
      [id, next, JSON.stringify(spec), note, user.id, undoTo],
    );
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

  /** Build version `version` (cached on disk with its report). */
  async build(packDir: string, id: string, spec: DeckSpec, version: number): Promise<BuildReport> {
    const out = this.pptx(id, version);
    const meta = `${out}.json`;
    if (existsSync(meta)) return JSON.parse(await readFile(meta, "utf8"));
    const tmp = `${out}.${randomUUID()}.tmp.pptx`;
    const base = spec.base ? join(this.dir(id), spec.base) : undefined;
    try {
      const report = await engine<BuildReport>("build", { pack: packDir, deck: spec, out: tmp, base });
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
    return { deck, version: v, spec, report: await this.build(deck.packDir, id, spec, v) };
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
      pptx: join(this.dir(id), spec.base),
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
    const res = await engine<{ deck: DeckSpec }>("import", { pack: pack.dir, pptx: file, dest: this.dir(id), language });
    return this.create(user, res.deck, "import", id);
  }

  async exportPath(user: User, id: string, version?: number): Promise<{ version: number; path: string }> {
    const { version: v, report } = await this.report(user, id, version);
    return { version: v, path: report.path };
  }

  async addComment(user: User, id: string, c: { slide_id: string; shape_id?: number | null | undefined; text: string }) {
    const deck = await this.deck(user, id, "commenter");
    const { rows } = await this.db.query<Comment>(
      `insert into comments (deck_id, version, slide_id, shape_id, text, author) values ($1, $2, $3, $4, $5, $6)
       returning *`,
      [id, deck.head, c.slide_id, c.shape_id ?? null, c.text, user.guest ? `guest (${user.guest.label})` : user.id],
    );
    return rows[0] as Comment;
  }

  async comments(user: User, id: string, status?: "open" | "resolved") {
    await this.deck(user, id, "viewer");
    const { rows } = await this.db.query<Comment>(
      `select * from comments where deck_id = $1 and ($2::text is null or status = $2) order by id`,
      [id, status ?? null],
    );
    return rows;
  }

  async resolve(user: User, id: string, ids: number[]) {
    await this.deck(user, id, "editor");
    if (ids.length) await this.db.query("update comments set status = 'resolved' where deck_id = $1 and id = any($2)", [id, ids]);
  }
}

function summary(r: BuildReport) {
  return { slides: Object.keys(r.slides), warnings: r.warnings, holes: r.holes };
}
