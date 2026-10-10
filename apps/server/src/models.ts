import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { PROVIDERS, testModel, type ModelConfig, type ModelOptions, type ProviderId } from "@calque/llm";
import type { Db } from "./db.ts";
import { Forbidden, NotFound, type User } from "./packs.ts";

export { Forbidden };

/** The web app's AI models (PipesHub pattern): several providers, keys encrypted at rest, one default.
Workspace-wide; only admins change them. Keys and custom header values never leave the server. */

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
}

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
}

const ADMIN_TEAM = process.env.CALQUE_ADMIN_TEAM ?? "calque-admins";
export const isAdmin = (u: User) => u.local === true || u.teams.includes(ADMIN_TEAM);

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
  private readonly key: Buffer;

  constructor(db: Db, secret: string) {
    this.db = db;
    this.key = createHash("sha256").update(secret).digest();
  }

  private seal(text: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
  }

  private open(sealed: string): string {
    const b = Buffer.from(sealed, "base64");
    const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
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

  /** Configured models, without their keys nor their header values. */
  async list() {
    const { rows } = await this.db.query<Row>("select * from models order by id");
    return rows.map((r) => {
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
      };
    });
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
    if (input.id) {
      const r = await this.row(input.id);
      if (!r) throw new NotFound(`no model ${JSON.stringify(input.id)}`);
      if (r.provider !== input.provider) throw new InvalidModel(`model ${input.id} is a ${r.provider} model`);
    }
    const id = input.id ?? (await this.newId(input));
    const prev = await this.row(id);
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
    await this.save(id, { ...row, label }, user.id);
    if (input.default || !(await this.defaultRow())) await this.setDefault(user, id);
    return (await this.list()).find((m) => m.id === id);
  }

  private async save(id: string, r: Pick<Row, "provider" | "model" | "base_url" | "api_key" | "label" | "options" | "headers">, by: string) {
    await this.db.query(
      `insert into models (id, provider, model, base_url, api_key, label, options, headers, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (id) do update set provider = $2, model = $3, base_url = $4, api_key = $5, label = $6, options = $7, headers = $8,
       updated_by = $9, updated_at = now()`,
      [id, r.provider, r.model, r.base_url, r.api_key, r.label, r.options, r.headers, by],
    );
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
  }

  async remove(user: User, id: string) {
    if (!isAdmin(user)) throw new Forbidden(`only ${ADMIN_TEAM} configure models`);
    const { rows } = await this.db.query<{ is_default: boolean }>("delete from models where id = $1 returning is_default", [id]);
    // the default gone, the most recently configured model takes over: the agent keeps a model
    if (rows[0]?.is_default)
      await this.db.query("update models set is_default = true where id = (select id from models order by updated_at desc, id limit 1)");
  }

  /** The model to run: `id`, else the default. Read on every call, so a new default needs no restart. */
  async resolve(id?: string): Promise<ModelConfig & { id: string }> {
    const r = id ? await this.row(id) : await this.defaultRow();
    if (!r) throw new NotFound(id ? `no model ${JSON.stringify(id)}` : "no AI model configured: add one in Settings > AI Models");
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
