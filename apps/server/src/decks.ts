import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeckSpec, PatchOp } from "@calque/deckspec";
import type { Db } from "./db.ts";
import { engine } from "./engine.ts";
import { getPack, listPacks, NotFound, type User } from "./packs.ts";

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

/** What an import recognised: slides kept drawn, imported as clones, demoted (and why), and
drawn slides changed in Calque after the file was exported (the file wins). */
export interface ImportReport {
  drawn: string[];
  imported: string[];
  demoted: { slide: string; reason: string }[];
  conflicts: { slide: string; reason: string }[];
}

export class Conflict extends Error {}

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

  async deck(user: User, id: string): Promise<DeckRow & { packDir: string }> {
    const { rows } = await this.db.query<DeckRow>("select * from decks where id = $1", [id]).catch(() => ({ rows: [] }));
    const row = rows[0];
    if (!row) throw new NotFound(`no deck ${JSON.stringify(id)}`);
    const pack = await getPack(this.db, user, row.pack_id); // a deck on a hidden pack is hidden too
    return { ...row, packDir: pack.dir };
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
    const deck = await this.deck(user, id);
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
    const deck = await this.deck(user, id);
    const spec = await this.spec(id, deck.head);
    const res = await engine<{ deck: DeckSpec }>("patch", { pack: deck.packDir, deck: spec, ops });
    return this.commit(user, id, deck.head, res.deck, note);
  }

  /** Back to `version` as a new version; no version = undo the last change. */
  restore(user: User, id: string, version?: number) {
    return this.serial(id, () => this.restoreNow(user, id, version));
  }

  private async restoreNow(user: User, id: string, version?: number) {
    const deck = await this.deck(user, id);
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
    const deck = await this.deck(user, id);
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
    const deck = await this.deck(user, id);
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
    const res = await engine<{ deck: DeckSpec; report: ImportReport }>("import", { pack: pack.dir, pptx: file, dest: this.dir(id), language });
    return { ...(await this.create(user, res.deck, "import", id)), import: res.report };
  }

  /** Re-import a PPTX edited in PowerPoint into deck `id`, as its next version: slides the engine
  tagged keep their ids (comments stay anchored), drawn slides stay drawn with the edits merged. */
  reimport(user: User, id: string, file: string, language?: string) {
    return this.serial(id, () => this.reimportNow(user, id, file, language));
  }

  private async reimportNow(user: User, id: string, file: string, language?: string) {
    const deck = await this.deck(user, id);
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

  async exportPath(user: User, id: string, version?: number): Promise<{ version: number; path: string }> {
    const { version: v, report } = await this.report(user, id, version);
    return { version: v, path: report.path };
  }

  async addComment(user: User, id: string, c: { slide_id: string; shape_id?: number | null | undefined; text: string }) {
    const deck = await this.deck(user, id);
    const { rows } = await this.db.query<Comment>(
      `insert into comments (deck_id, version, slide_id, shape_id, text, author) values ($1, $2, $3, $4, $5, $6)
       returning *`,
      [id, deck.head, c.slide_id, c.shape_id ?? null, c.text, user.id],
    );
    return rows[0] as Comment;
  }

  async comments(user: User, id: string, status?: "open" | "resolved") {
    await this.deck(user, id);
    const { rows } = await this.db.query<Comment>(
      `select * from comments where deck_id = $1 and ($2::text is null or status = $2) order by id`,
      [id, status ?? null],
    );
    return rows;
  }

  async resolve(user: User, id: string, ids: number[]) {
    await this.deck(user, id);
    if (ids.length) await this.db.query("update comments set status = 'resolved' where deck_id = $1 and id = any($2)", [id, ids]);
  }
}

function summary(r: BuildReport) {
  return { slides: Object.keys(r.slides), warnings: r.warnings, holes: r.holes };
}
