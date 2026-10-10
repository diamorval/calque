import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { PROVIDERS, testModel, type ModelConfig, type ProviderId, type ProviderInfo } from "@calque/llm";
import type { Db } from "./db.ts";
import { checkEndpoint } from "./egress.ts";
import { Forbidden, NotFound, type User } from "./packs.ts";

export { Forbidden };

/** The web app's AI models (PipesHub pattern): several providers, keys encrypted at rest, one default.
Workspace-wide; only admins change them. Keys never leave the server. */

export class InvalidModel extends Error {}

interface Row {
  id: string;
  provider: ProviderId;
  model: string;
  base_url: string | null;
  api_key: string | null;
  is_default: boolean;
  updated_by: string;
}

export interface ModelInput {
  provider: ProviderId;
  model: string;
  api_key?: string | undefined;
  base_url?: string | undefined;
  default?: boolean | undefined;
}

/** The egress policy (egress.ts) on the endpoint the server will call; a provider's own SDK default is not checked. */
async function egress(provider: ProviderId, baseUrl: string | null | undefined) {
  const url = baseUrl ?? (PROVIDERS[provider] as ProviderInfo).defaultBaseURL;
  if (!url) return;
  try {
    await checkEndpoint(url);
  } catch (e) {
    throw new InvalidModel((e as Error).message);
  }
}

export const ADMIN_TEAM = process.env.CALQUE_ADMIN_TEAM ?? "calque-admins";
export const isAdmin = (u: User) => u.local === true || u.teams.includes(ADMIN_TEAM);

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
    return { provider: r.provider, model: r.model, apiKey: r.api_key ? this.open(r.api_key) : undefined, baseURL: r.base_url ?? undefined };
  }

  catalog() {
    return Object.entries(PROVIDERS).map(([id, p]) => ({ id, ...p }));
  }

  /** Configured models, without their keys. */
  async list() {
    const { rows } = await this.db.query<Row>("select * from models order by id");
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      model: r.model,
      base_url: r.base_url,
      has_key: r.api_key !== null,
      is_default: r.is_default,
    }));
  }

  /** Test the model, then save it. Editing without a new key keeps the stored one. */
  async configure(user: User, input: ModelInput, id = `${input.provider}:${input.model}`) {
    if (!isAdmin(user)) throw new Forbidden(`only ${ADMIN_TEAM} configure models`);
    if (!(input.provider in PROVIDERS)) throw new InvalidModel(`unknown provider ${JSON.stringify(input.provider)}`);
    await egress(input.provider, input.base_url);
    const { rows } = await this.db.query<Row>("select * from models where id = $1", [id]);
    const sealed = input.api_key ? this.seal(input.api_key) : (rows[0]?.api_key ?? null);
    const cfg: ModelConfig = {
      provider: input.provider,
      model: input.model,
      apiKey: sealed ? this.open(sealed) : undefined,
      baseURL: input.base_url,
    };
    try {
      await testModel(cfg);
    } catch (e) {
      throw new InvalidModel(`${PROVIDERS[input.provider].label} refused the configuration: ${(e as Error).message}`);
    }
    await this.save(id, cfg.provider, cfg.model, input.base_url ?? null, sealed, user.id);
    if (input.default || !(await this.defaultRow())) await this.setDefault(user, id);
    return (await this.list()).find((m) => m.id === id);
  }

  private async save(id: string, provider: string, model: string, baseUrl: string | null, sealed: string | null, by: string) {
    await this.db.query(
      `insert into models (id, provider, model, base_url, api_key, updated_by) values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do update set provider = $2, model = $3, base_url = $4, api_key = $5, updated_by = $6, updated_at = now()`,
      [id, provider, model, baseUrl, sealed, by],
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
    await this.db.query("delete from models where id = $1", [id]);
  }

  /** The model to run: `id`, else the default. Read on every call, so a new default needs no restart. */
  async resolve(id?: string): Promise<ModelConfig & { id: string }> {
    const r = id
      ? (await this.db.query<Row>("select * from models where id = $1", [id])).rows[0]
      : await this.defaultRow();
    if (!r) throw new NotFound(id ? `no model ${JSON.stringify(id)}` : "no AI model configured: add one in Settings > AI Models");
    await egress(r.provider, r.base_url);
    return { id: r.id, ...this.config(r) };
  }

  /** The gateway preconfigured by the deployment (CALQUE_LLM_*): saved as model `env`, default unless one is set. */
  async seedFromEnv(env = process.env) {
    if (!env.CALQUE_LLM_MODEL) return;
    const provider = (env.CALQUE_LLM_PROVIDER ?? "openai-compatible") as ProviderId;
    if (!(provider in PROVIDERS)) throw new InvalidModel(`CALQUE_LLM_PROVIDER: unknown provider ${provider}`);
    const key = env.CALQUE_LLM_API_KEY;
    await this.save("env", provider, env.CALQUE_LLM_MODEL, env.CALQUE_LLM_BASE_URL ?? null, key ? this.seal(key) : null, "env");
    if (!(await this.defaultRow())) await this.db.query("update models set is_default = true where id = 'env'");
  }
}
