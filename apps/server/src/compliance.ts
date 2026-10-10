import type { Db } from "./db.ts";
import type { Decks, Finding } from "./decks.ts";
import { Forbidden, getPack, listPacks, type User } from "./packs.ts";
import { approvalOn } from "./review.ts";

/** Brand compliance (M16): for each pack its owner or an admin manages, the decks made on it (by
owner and team), the lint ERRORs and WARNs of their latest versions, the trend week by week, and
their approval status. Titles and counts: never a deck's content. */

/** Keep a version's lint counts: lint_deck, review_deck and export_pptx all lint (Decks.lint). */
export async function recordLint(db: Db, id: string, version: number, findings: Finding[]) {
  const n = (s: Finding["severity"]) => findings.filter((f) => f.severity === s).length;
  await db.query(
    `insert into deck_lint (deck_id, version, errors, warns) values ($1, $2, $3, $4)
     on conflict (deck_id, version) do update set errors = $3, warns = $4, at = now()`,
    [id, version, n("ERROR"), n("WARN")],
  );
}

/** The dashboard lints a latest version nobody linted yet as the server itself: its viewer may
manage the pack without having access to the deck. */
const SERVER: User = { id: "calque", teams: [], local: true };
// ponytail: lints at most this many unlinted decks per call (a build + lint each); the rest show
// as not linted yet and fill in on the next refresh. A background job if packs grow large.
const LINTS_PER_CALL = 10;

type Row = {
  id: string;
  title: string;
  owner: string;
  owner_teams: string[];
  head: number;
  approval: "draft" | "in_review" | "approved";
  updated_at: string;
  errors: number | null;
  warns: number | null;
};

type Tally = { decks: number; errors: number; warns: number };
const tally = (rows: Row[]): Tally => ({
  decks: rows.length,
  errors: rows.reduce((s, r) => s + (r.errors ?? 0), 0),
  warns: rows.reduce((s, r) => s + (r.warns ?? 0), 0),
});
const groupBy = (rows: Row[], keys: (r: Row) => string[]) => {
  const out = new Map<string, Row[]>();
  for (const r of rows) for (const k of keys(r)) out.set(k, [...(out.get(k) ?? []), r]);
  return out;
};

export async function compliance(db: Db, decks: Decks, user: User, packId?: string) {
  if (packId) await getPack(db, user, packId); // 404 when they do not see it
  const packs = (await listPacks(db, user, { manage: true })).filter((p) => p.editable && (!packId || p.id === packId));
  if (!packs.length) throw new Forbidden(packId ? `only the owner of ${packId} or an admin sees its compliance` : "only pack owners and admins see brand compliance");

  let budget = LINTS_PER_CALL;
  const out = [];
  for (const p of packs) {
    const q = () =>
      db.query<Row>(
        `select d.id, d.title, d.owner, d.owner_teams, d.head, d.approval, v.created_at as updated_at, l.errors, l.warns
         from decks d join deck_versions v on v.deck_id = d.id and v.version = d.head
         left join deck_lint l on l.deck_id = d.id and l.version = d.head
         where d.pack_id = $1 order by v.created_at desc`,
        [p.id],
      );
    let { rows } = await q();
    const unlinted = rows.filter((r) => r.errors === null).slice(0, budget);
    budget -= unlinted.length;
    for (const r of unlinted) await decks.lint(SERVER, r.id).catch(() => undefined); // records the counts
    if (unlinted.length) rows = (await q()).rows;

    const names = new Map(
      (
        await db.query<{ author: string; author_name: string }>(
          `select distinct on (author) author, author_name from deck_versions
           where author = any($1::text[]) and author_name is not null order by author, created_at desc`,
          [[...new Set(rows.map((r) => r.owner))]],
        )
      ).rows.map((r) => [r.author, r.author_name]),
    );
    const { rows: trend } = await db.query<{ week: string; versions: number; decks: number; errors: number; warns: number }>(
      `select date_trunc('week', v.created_at) as week, count(*)::int as versions, count(distinct l.deck_id)::int as decks,
         sum(l.errors)::int as errors, sum(l.warns)::int as warns
       from deck_lint l join deck_versions v on v.deck_id = l.deck_id and v.version = l.version
       join decks d on d.id = l.deck_id where d.pack_id = $1
       group by 1 order by 1 desc limit 12`,
      [p.id],
    );
    const linted = rows.filter((r) => r.errors !== null);
    const { rows: dirs } = await db.query<{ dir: string }>("select dir from packs where id = $1", [p.id]); // an admin may not see it
    const approval = (await approvalOn(dirs[0]?.dir ?? ""))
      ? Object.fromEntries((["draft", "in_review", "approved"] as const).map((s) => [s, rows.filter((r) => r.approval === s).length]))
      : null;
    out.push({
      pack_id: p.id,
      name: p.name,
      summary: { ...tally(rows), linted: linted.length, clean: linted.filter((r) => r.errors === 0).length },
      by_owner: [...groupBy(rows, (r) => [r.owner])].map(([owner, rs]) => ({ owner, name: names.get(owner) ?? null, ...tally(rs) })),
      by_team: [...groupBy(rows, (r) => (r.owner_teams.length ? r.owner_teams : ["(no team)"]))].map(([team, rs]) => ({ team, ...tally(rs) })),
      approval,
      trend: trend.map((t) => ({ ...t, week: new Date(t.week).toISOString().slice(0, 10) })),
      decks: rows.map((r) => ({
        id: r.id,
        title: r.title,
        owner: r.owner,
        owner_name: names.get(r.owner) ?? null,
        teams: r.owner_teams,
        version: r.head,
        updated_at: r.updated_at,
        errors: r.errors,
        warns: r.warns,
        ...(approval ? { approval: r.approval } : {}),
      })),
    });
  }
  return { packs: out };
}
