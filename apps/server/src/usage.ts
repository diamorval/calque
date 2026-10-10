import type { Db } from "./db.ts";
import { ADMIN_TEAM, Forbidden, isAdmin, type User } from "./packs.ts";

/** Usage metering (S16): one row per web agent run, who ran it (and their teams then), on which
model, the tokens the provider counted (AI SDK usage) and how long it took. Never the content.
Admins read it summed per user, team and model over a period (usage_report, GET /api/admin/usage).
Rows older than CALQUE_RETENTION_DAYS go with the retention purge. MCP clients run on the user's
own subscription: nothing to meter here. */

export interface Run {
  model_id: string;
  /** "chat" or "apply-comments" */
  run: string;
  deck_id?: string | undefined;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
}

export async function recordUsage(db: Db, user: User, r: Run) {
  await db.query(
    "insert into usage (user_id, teams, model_id, run, deck_id, input_tokens, output_tokens, duration_ms) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [user.anonymous ? "guest" : user.id, JSON.stringify(user.teams), r.model_id, r.run, r.deck_id ?? null, r.input_tokens, r.output_tokens, r.duration_ms],
  );
}

interface Sum {
  runs: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
}

/** Admins: runs and tokens per user, per team (a user in two teams counts in both; "(no team)") and
per model, between `since` (default 30 days ago) and `until` (default now). */
export async function usageReport(db: Db, user: User, f: { since?: string | undefined; until?: string | undefined } = {}) {
  if (!isAdmin(user)) throw new Forbidden(`only ${ADMIN_TEAM} read usage`);
  const until = f.until ? new Date(f.until) : new Date();
  const since = f.since ? new Date(f.since) : new Date(until.getTime() - 30 * 86_400_000);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) throw new Error("since and until: ISO dates");
  const sums = "count(*)::int as runs, sum(input_tokens)::int as input_tokens, sum(output_tokens)::int as output_tokens, sum(duration_ms)::int as duration_ms";
  const period = "at >= $1 and at < $2";
  const by = async <K extends string>(col: K, from = "usage") =>
    (await db.query<Sum & Record<K, string>>(`select ${col}, ${sums} from ${from} where ${period} group by 1 order by sum(input_tokens + output_tokens) desc, 1`, [since, until])).rows;
  const [total] = (await db.query<Sum>(`select ${sums} from usage where ${period}`, [since, until])).rows;
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    total: { runs: total?.runs ?? 0, input_tokens: total?.input_tokens ?? 0, output_tokens: total?.output_tokens ?? 0, duration_ms: total?.duration_ms ?? 0 },
    by_user: await by("user_id"),
    by_team: await by(
      "team",
      "(select u.*, coalesce(t.team, '(no team)') as team from usage u left join lateral jsonb_array_elements_text(u.teams) as t(team) on true) x",
    ),
    by_model: await by("model_id"),
  };
}
