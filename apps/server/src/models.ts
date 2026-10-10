import { PROVIDERS, testModel, type ModelConfig, type ModelOptions, type ProviderId, type ProviderInfo } from "@calque/llm";
import { audit } from "./audit.ts";
import type { Db } from "./db.ts";
import { allowedHosts, checkEndpoint } from "./egress.ts";
import { ADMIN_TEAM, Forbidden, isAdmin, NotFound, type User } from "./packs.ts";
import { sealer } from "./seal.ts";

export { Forbidden, isAdmin };

/** The web app's AI models (PipesHub pattern): several providers, keys encrypted at rest, one default.
Only admins change them. Keys and custom header values never leave the server.

Per team (S9): a model restricted to teams runs only for their members (and admins); a team may
have its own default. The agent runs the model asked for if the user may use it, else their first
team's default (in the order of their teams), else the workspace default. */

export class InvalidModel extends Error {}

interface Row {
  id: string;
  provider: ProviderId;
  model: string;
  base_url: string | null;
  api_key: string | null;
  label: string | null;
  options: string | null; // ModelOptions, JSON
  headers: string | null; // sealed JSON
  is_default: boolean;
  updated_by: string;
  /** the teams it is restricted to; []: everyone */
  teams: string[];
}

/** Whether `user` may run model `r`: open to everyone, to one of their teams, or they are an admin. */
const usable = (r: Pick<Row, "teams">, user?: User) => !user || !r.teams.length || isAdmin(user) || r.teams.some((t) => user.teams.includes(t));

export interface ModelInput {
  /** edit this configuration; unset: a new one */
  id?: string | undefined;
  provider: ProviderId;
  model: string;
  /** tells two configurations of one model apart (two Azure regions, two Ollama hosts) */
  label?: string | undefined;
  api_key?: string | undefined;
  base_url?: string | undefined;
  /** replaces the stored headers; unset keeps them */
  headers?: Record<string, string> | undefined;
  resource?: string | undefined;
  api_version?: string | undefined;
  managed_identity?: boolean | undefined;
  default?: boolean | undefined;
  /** restrict it to these teams ([]: everyone); unset keeps the stored ones */
  teams?: string[] | undefined;
}

/** The egress policy (egress.ts) on the endpoint the server will call: the base URL, else the Azure
resource's, else the provider's public default (allow-list only: not resolved) or Ollama's localhost. */
async function egress(provider: ProviderId, baseUrl: string | null | undefined, o: ModelOptions = {}) {
  const own = baseUrl ?? (o.resource ? `https://${o.resource}.openai.azure.com/openai` : undefined);
  const url = own ?? (PROVIDERS[provider] as ProviderInfo).defaultBaseURL;
  if (!url || url.includes("<")) return;
  try {
    await checkEndpoint(url, allowedHosts(), own || provider === "ollama" ? undefined : async () => []);
  } catch (e) {
    throw new InvalidModel((e as Error).message);
  }
}

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const options = (i: Pick<ModelInput, "resource" | "api_version" | "managed_identity">): ModelOptions => ({
  ...(i.resource ? { resource: i.resource } : {}),
  ...(i.api_version ? { apiVersion: i.api_version } : {}),
  ...(i.managed_identity ? { managedIdentity: true } : {}),
});

export class Models {
  private readonly db: Db;
  private readonly seal: (text: string) => string;
  private readonly open: (sealed: string) => string;

  constructor(db: Db, secret: string) {
    this.db = db;
    const s = sealer(secret);
    this.seal = s.seal;
    this.open = s.open;
  }

  private config(r: Row): ModelConfig {
    return {
      provider: r.provider,
      model: r.model,
      apiKey: r.api_key ? this.open(r.api_key) : undefined,
      baseURL: r.base_url ?? undefined,
      headers: r.headers ? (JSON.parse(this.open(r.headers)) as Record<string, string>) : undefined,
      options: r.options ? (JSON.parse(r.options) as ModelOptions) : undefined,
    };
  }

  catalog() {
    return Object.entries(PROVIDERS).map(([id, p]) => ({ id, ...p }));
  }

  /** Configured models, without their keys nor their header values. With `user`: only the ones
  they may run, `your_default` marking the one the agent runs for them by default. */
  async list(user?: User) {
    const { rows } = await this.db.query<Row>("select * from models order by id");
    const mine = user ? await this.defaultFor(user).then((r) => r?.id) : undefined;
    return rows.filter((r) => usable(r, user)).map((r) => {
      const o: ModelOptions = r.options ? JSON.parse(r.options) : {};
      return {
        id: r.id,
        provider: r.provider,
        model: r.model,
        label: r.label,
        base_url: r.base_url,
        has_key: r.api_key !== null,
        headers: r.headers ? Object.keys(JSON.parse(this.open(r.headers))) : [],
        resource: o.resource ?? null,
        api_version: o.apiVersion ?? null,
        managed_identity: o.managedIdentity === true,
        is_default: r.is_default,
        teams: r.teams,
        ...(user ? { your_default: r.id === mine } : {}),
      };
    });
  }

  /** Each team's default model: {team: model id}. */
  async teamDefaults(): Promise<Record<string, string>> {
    const { rows } = await this.db.query<{ team: string; model_id: string }>("select team, model_id from model_team_defaults order by team");
    return Object.fromEntries(rows.map((r) => [r.team, r.model_id]));
  }

  /** Restrict model `id` to `teams` ([]: everyone). Team defaults on it for other teams are dropped. */
  async restrict(user: User, id: string, teams: string[]) {
    if (!isAdmin(user)) throw new Forbidden(`only ${ADMIN_TEAM} configure models`);
    if (!(await this.row(id))) throw new NotFound(`no model ${JSON.stringify(id)}`);
    const list = [...new Set(teams.map((t) => t.trim()).filter(Boolean))];
    await this.db.query("update models set teams = $2 where id = $1", [id, JSON.stringify(list)]);
    if (list.length) await this.db.query("delete from model_team_defaults where model_id = $1 and not (team = any($2::text[]))", [id, list]);
    await audit(this.db, user, "restrict", "model", id, { teams: list });
    return (await this.list()).find((m) => m.id === id);
  }

  /** Team `team`'s default model: `id` (one the team may use), or null to fall back to the workspace's. */
  async setTeamDefault(user: User, team: string, id: string | null) {
    if (!isAdmin(user)) throw new Forbidden(`only ${ADMIN_TEAM} configure models`);
    if (id === null) {
      await this.db.query("delete from model_team_defaults where team = $1", [team]);
    } else {
      const r = await this.row(id);
      if (!r) throw new NotFound(`no model ${JSON.stringify(id)}`);
      if (r.teams.length && !r.teams.includes(team)) throw new InvalidModel(`model ${id} is restricted to ${r.teams.join(", ")}: not ${team}`);
      await this.db.query(
        `insert into model_team_defaults (team, model_id, updated_by) values ($1, $2, $3)
         on conflict (team) do update set model_id = $2, updated_by = $3, updated_at = now()`,
        [team, id, user.id],
      );
    }
    await audit(this.db, user, "team_default", "model", id, { team });
    return { team, model_id: id };
  }

  /** The model the agent runs for `user` by default: their first team's default, else the workspace
  default, if they may run it. */
  private async defaultFor(user: User): Promise<Row | undefined> {
    if (user.teams.length) {
      const { rows } = await this.db.query<Row & { team: string }>(
        "select m.*, d.team from model_team_defaults d join models m on m.id = d.model_id where d.team = any($1::text[])",
        [user.teams],
      );
      const first = rows.filter((r) => usable(r, user)).sort((a, b) => user.teams.indexOf(a.team) - user.teams.indexOf(b.team))[0];
      if (first) return first;
    }
    const d = await this.defaultRow();
    return d && usable(d, user) ? d : undefined;
  }

  private async row(id: string): Promise<Row | undefined> {
    return (await this.db.query<Row>("select * from models where id = $1", [id])).rows[0];
  }

  /** A new configuration's id: `provider:model`, `@label` if labelled. Saving the same model on the
  same endpoint again edits it; on another endpoint it gets a free `@2`, `@3`… suffix. */
  private async newId(input: ModelInput): Promise<string> {
    const base = `${input.provider}:${input.model}${input.label && slug(input.label) ? `@${slug(input.label)}` : ""}`;
    const endpoint = (r: Row) => `${r.base_url ?? ""}|${(r.options && (JSON.parse(r.options) as ModelOptions).resource) ?? ""}`;
    const mine = `${input.base_url ?? ""}|${input.resource ?? ""}`;
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}${base.includes("@") ? "-" : "@"}${n}`;
      const r = await this.row(id);
      if (!r || (r.provider === input.provider && r.model === input.model && endpoint(r) === mine)) return id;
    }
  }

  /** Test the model, then save it. Editing without a new key (or new headers) keeps the stored ones. */
  async configure(user: User, input: ModelInput) {
    if (!isAdmin(user)) throw new Forbidden(`only ${ADMIN_TEAM} configure models`);
    if (!(input.provider in PROVIDERS)) throw new InvalidModel(`unknown provider ${JSON.stringify(input.provider)}`);
    await egress(input.provider, input.base_url, options(input));
    if (input.id) {
      const r = await this.row(input.id);
      if (!r) throw new NotFound(`no model ${JSON.stringify(input.id)}`);
      if (r.provider !== input.provider) throw new InvalidModel(`model ${input.id} is a ${r.provider} model`);
    }
    const id = input.id ?? (await this.newId(input));
    const prev = await this.row(id);
    // a restriction applies before the default: an admin choosing both gets the team check below
    const teams = input.teams ? [...new Set(input.teams.map((t) => t.trim()).filter(Boolean))] : (prev?.teams ?? []);
    const sealed = input.api_key ? this.seal(input.api_key) : (prev?.api_key ?? null);
    const headers = input.headers ? (Object.keys(input.headers).length ? this.seal(JSON.stringify(input.headers)) : null) : (prev?.headers ?? null);
    const opts = options(input);
    const label = input.label?.trim() || (input.id ? null : (prev?.label ?? null));
    const row = { provider: input.provider, model: input.model, base_url: input.base_url ?? null, api_key: sealed, headers, options: Object.keys(opts).length ? JSON.stringify(opts) : null };
    try {
      await testModel(this.config(row as Row));
    } catch (e) {
      throw new InvalidModel(`${PROVIDERS[input.provider].label} refused the configuration: ${(e as Error).message}`);
    }
    await this.save(id, { ...row, label, teams }, user.id);
    await audit(this.db, user, prev ? "update" : "add", "model", id, { provider: input.provider, model: input.model, base_url: input.base_url ?? null, new_key: !!input.api_key });
    if (input.default || !(await this.defaultRow())) await this.setDefault(user, id);
    return (await this.list()).find((m) => m.id === id);
  }

  private async save(id: string, r: Pick<Row, "provider" | "model" | "base_url" | "api_key" | "label" | "options" | "headers"> & { teams?: string[] }, by: string) {
    await this.db.query(
      `insert into models (id, provider, model, base_url, api_key, label, options, headers, updated_by, teams) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10, '[]'::jsonb))
       on conflict (id) do update set provider = $2, model = $3, base_url = $4, api_key = $5, label = $6, options = $7, headers = $8,
       updated_by = $9, updated_at = now(), teams = coalesce($10, models.teams)`,
      [id, r.provider, r.model, r.base_url, r.api_key, r.label, r.options, r.headers, by, r.teams ? JSON.stringify(r.teams) : null],
    );
    if (r.teams?.length) await this.db.query("delete from model_team_defaults where model_id = $1 and not (team = any($2::text[]))", [id, r.teams]);
  }

  private async defaultRow(): Promise<Row | undefined> {
    return (await this.db.query<Row>("select * from models where is_default")).rows[0];
  }

  async setDefault(user: User, id: string) {
    if (!isAdmin(user)) throw new Forbidden(`only ${ADMIN_TEAM} configure models`);
    const { rows } = await this.db.query<Row>("select id from models where id = $1", [id]);
    if (!rows[0]) throw new NotFound(`no model ${JSON.stringify(id)}`);
    await this.db.query("update models set is_default = false where is_default and id <> $1", [id]);
    await this.db.query("update models set is_default = true where id = $1", [id]);
    await audit(this.db, user, "default", "model", id);
  }

  async remove(user: User, id: string) {
    if (!isAdmin(user)) throw new Forbidden(`only ${ADMIN_TEAM} configure models`);
    const { rows } = await this.db.query<{ is_default: boolean }>("delete from models where id = $1 returning is_default", [id]);
    if (rows[0]) await audit(this.db, user, "remove", "model", id);
    // the default gone, the most recently configured model takes over: the agent keeps a model
    if (rows[0]?.is_default)
      await this.db.query("update models set is_default = true where id = (select id from models order by updated_at desc, id limit 1)");
  }

  /** The model to run for `user`: `id` if they may run it, else their default (defaultFor). Read on
  every call, so a new default needs no restart. Without `user`: `id`, else the workspace default. */
  async resolve(id?: string, user?: User): Promise<ModelConfig & { id: string }> {
    const r = id ? await this.row(id) : user ? await this.defaultFor(user) : await this.defaultRow();
    if (id && r && !usable(r, user)) throw new Forbidden(`model ${JSON.stringify(id)} is restricted to other teams`);
    if (!r) {
      const none = user && (await this.defaultRow()) ? "no AI model available to your teams: ask an admin (Settings > AI Models)" : "no AI model configured: add one in Settings > AI Models";
      throw new NotFound(id ? `no model ${JSON.stringify(id)}` : none);
    }
    await egress(r.provider, r.base_url, r.options ? (JSON.parse(r.options) as ModelOptions) : {});
    return { id: r.id, ...this.config(r) };
  }

  /** The gateway preconfigured by the deployment (CALQUE_LLM_*): saved as model `env`, default unless one is set. */
  async seedFromEnv(env = process.env) {
    if (!env.CALQUE_LLM_MODEL) return;
    const provider = (env.CALQUE_LLM_PROVIDER ?? "openai-compatible") as ProviderId;
    if (!(provider in PROVIDERS)) throw new InvalidModel(`CALQUE_LLM_PROVIDER: unknown provider ${provider}`);
    const key = env.CALQUE_LLM_API_KEY;
    const headers = env.CALQUE_LLM_HEADERS; // JSON object, e.g. {"Ocp-Apim-Subscription-Key": "…"}
    const opts = options({ resource: env.CALQUE_LLM_AZURE_RESOURCE, api_version: env.CALQUE_LLM_API_VERSION, managed_identity: env.CALQUE_LLM_MANAGED_IDENTITY === "1" });
    await this.save(
      "env",
      {
        provider,
        model: env.CALQUE_LLM_MODEL,
        base_url: env.CALQUE_LLM_BASE_URL ?? null,
        api_key: key ? this.seal(key) : null,
        label: null,
        options: Object.keys(opts).length ? JSON.stringify(opts) : null,
        headers: headers ? this.seal(JSON.stringify(JSON.parse(headers))) : null,
      },
      "env",
    );
    if (!(await this.defaultRow())) await this.db.query("update models set is_default = true where id = 'env'");
  }
}
