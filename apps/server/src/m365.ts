import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { jwtVerify, SignJWT } from "jose";
import { audit } from "./audit.ts";
import type { Db } from "./db.ts";
import { MAX_UPLOAD, saveFile, TooLarge } from "./files.ts";
import { Forbidden, NotFound, type User } from "./packs.ts";
import { sealer } from "./seal.ts";

/** Microsoft 365 in and out (S4, S15): files picked in OneDrive or SharePoint come into Calque's
uploads (a file_id, as if uploaded), and exported decks go back to a OneDrive or SharePoint folder.

Each user connects their own account once ("Connect Microsoft 365"): an OAuth authorization code
+ PKCE flow against Entra ID, separate from Calque's sign-in (whose issuer may not be Entra, and
whose tokens are never kept). Calque keeps that user's refresh token, sealed like model keys, and
calls Microsoft Graph with plain fetch, as that user (delegated): it reaches only what they can. */

export interface M365Config {
  clientId: string; // CALQUE_M365_CLIENT_ID: the Entra app registration
  clientSecret?: string | undefined; // CALQUE_M365_CLIENT_SECRET; unset = public client
  tenant: string; // CALQUE_M365_TENANT: tenant id or domain, default "organizations"
  authority: string; // CALQUE_M365_AUTHORITY, default https://login.microsoftonline.com
  graph: string; // CALQUE_M365_GRAPH, default https://graph.microsoft.com/v1.0
}

export function m365Config(env = process.env): M365Config | undefined {
  if (!env.CALQUE_M365_CLIENT_ID) return undefined;
  return {
    clientId: env.CALQUE_M365_CLIENT_ID,
    clientSecret: env.CALQUE_M365_CLIENT_SECRET,
    tenant: env.CALQUE_M365_TENANT ?? "organizations",
    authority: (env.CALQUE_M365_AUTHORITY ?? "https://login.microsoftonline.com").replace(/\/$/, ""),
    graph: (env.CALQUE_M365_GRAPH ?? "https://graph.microsoft.com/v1.0").replace(/\/$/, ""),
  };
}

/** Read and write the files the user can reach (their OneDrive, SharePoint libraries), find sites.
None needs an admin's consent. */
export const SCOPES = "offline_access User.Read Files.ReadWrite.All Sites.Read.All";

/** What can come in: what import_pptx, chat attachments and DeckSpec images take. */
const ACCEPT = /\.(pptx|potx|docx|xlsx|pdf|csv|txt|md|png|jpe?g|gif|bmp|tiff?|webp|svg)$/i;
/** Upload session chunks: a multiple of 320 KiB, as Graph requires. */
const CHUNK = 320 * 1024 * 32;

export class M365NotConnected extends Forbidden {
  override name = "M365NotConnected";
  readonly connect_url: string;
  constructor(connectUrl: string) {
    super(`Microsoft 365 is not connected for this user: open ${connectUrl} in a browser signed in to Calque, then retry`);
    this.connect_url = connectUrl;
  }
}
export class M365Error extends Error {}

interface Item {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  folder?: unknown;
  file?: { mimeType?: string };
  parentReference?: { driveId?: string; id?: string };
  "@microsoft.graph.downloadUrl"?: string;
}

const item = (i: Item) => ({
  drive_id: i.parentReference?.driveId ?? null,
  item_id: i.id,
  name: i.name,
  folder: !!i.folder,
  size: i.size ?? null,
  type: i.file?.mimeType ?? null,
  web_url: i.webUrl ?? null,
  modified: i.lastModifiedDateTime ?? null,
});

const seg = encodeURIComponent;
/** A drive's Graph path: one by id, else the user's OneDrive. */
const drive = (id?: string) => (id ? `/drives/${seg(id)}` : "/me/drive");

export class M365 {
  readonly cfg: M365Config;
  private readonly db: Db;
  private readonly publicUrl: string;
  private readonly sealed: ReturnType<typeof sealer>;
  private readonly key: Buffer;
  /** Access tokens, by user: short-lived, never stored. */
  private readonly access = new Map<string, { token: string; until: number }>();

  constructor(db: Db, secret: string, publicUrl: string, cfg: M365Config) {
    this.db = db;
    this.publicUrl = publicUrl;
    this.cfg = cfg;
    this.sealed = sealer(secret, "m365");
    this.key = createHash("sha256").update(`m365-login:${secret}`).digest();
  }

  get redirectUri() {
    return `${this.publicUrl}/auth/m365/callback`;
  }
  private endpoint(what: "authorize" | "token") {
    return `${this.cfg.authority}/${seg(this.cfg.tenant)}/oauth2/v2.0/${what}`;
  }

  /** Where a user connects, in a browser signed in to Calque as themselves. No bearer link: one
  would let its holder bind their own Microsoft account, or someone else's, to the wrong user. */
  get connectUrl() {
    return `${this.publicUrl}/auth/m365/connect`;
  }

  /** Start the flow: the Entra authorize URL, and the sealed login state to keep in a cookie. */
  async start(user: User, back: string): Promise<{ url: string; state: string }> {
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(16).toString("base64url");
    const url = new URL(this.endpoint("authorize"));
    for (const [k, v] of Object.entries({
      client_id: this.cfg.clientId,
      response_type: "code",
      redirect_uri: this.redirectUri,
      response_mode: "query",
      scope: SCOPES,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      prompt: "select_account",
    }))
      url.searchParams.set(k, v);
    const login = await new SignJWT({ verifier, state, back, teams: user.teams }).setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setExpirationTime("10m").sign(this.key);
    return { url: url.href, state: login };
  }

  /** Finish the flow: trade the code for tokens, keep the refresh token. Returns where to go back to. */
  async finish(login: string | undefined, query: { code?: string | undefined; state?: string | undefined; error_description?: string | undefined }): Promise<string> {
    let p;
    try {
      p = (await jwtVerify(login ?? "", this.key, { algorithms: ["HS256"] })).payload;
    } catch {
      throw new M365Error("connection expired: start again from Calque");
    }
    if (query.error_description) throw new M365Error(query.error_description);
    if (!query.code || query.state !== p.state) throw new M365Error("invalid answer from Microsoft (state mismatch)");
    const user: User = { id: String(p.sub), teams: (p.teams as string[]) ?? [] };
    const t = await this.grant({ grant_type: "authorization_code", code: query.code, redirect_uri: this.redirectUri, code_verifier: String(p.verifier) });
    this.access.set(user.id, { token: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 });
    const me = (await (await this.graph(user, "/me?$select=userPrincipalName,mail")).json()) as { userPrincipalName?: string; mail?: string };
    await this.store(user, t.refresh_token, me.userPrincipalName ?? me.mail ?? null);
    await audit(this.db, user, "connect", "user", user.id, { service: "m365", account: me.userPrincipalName ?? me.mail ?? null });
    return String(p.back);
  }

  private async grant(params: Record<string, string>) {
    const res = await fetch(this.endpoint("token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.cfg.clientId, scope: SCOPES, ...(this.cfg.clientSecret ? { client_secret: this.cfg.clientSecret } : {}), ...params }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) throw Object.assign(new M365Error(`Microsoft sign-in refused: ${body.error_description ?? body.error ?? res.status}`), { code: body.error });
    return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in ?? 3600 };
  }

  private async store(user: User, refresh: string | undefined, account?: string | null) {
    if (!refresh) throw new M365Error("Microsoft returned no refresh token: is offline_access granted?");
    await this.db.query(
      `insert into m365_tokens (user_id, refresh_token, account) values ($1, $2, $3)
       on conflict (user_id) do update set refresh_token = $2, account = coalesce($3, m365_tokens.account), updated_at = now()`,
      [user.id, this.sealed.seal(refresh), account ?? null],
    );
  }

  async status(user: User) {
    const { rows } = await this.db.query<{ account: string | null }>("select account from m365_tokens where user_id = $1", [user.id]);
    return { configured: true, connected: !!rows[0], account: rows[0]?.account ?? null };
  }

  async disconnect(user: User) {
    this.access.delete(user.id);
    const { rows } = await this.db.query("delete from m365_tokens where user_id = $1 returning user_id", [user.id]);
    if (rows.length) await audit(this.db, user, "disconnect", "user", user.id, { service: "m365" });
    return { configured: true, connected: false, account: null };
  }

  /** A Graph access token for `user`: cached, else from their refresh token (rotated as Entra does). */
  private async token(user: User): Promise<string> {
    const hit = this.access.get(user.id);
    if (hit && hit.until > Date.now()) return hit.token;
    const { rows } = await this.db.query<{ refresh_token: string }>("select refresh_token from m365_tokens where user_id = $1", [user.id]);
    if (!rows[0] || user.anonymous) throw new M365NotConnected(this.connectUrl);
    let t;
    try {
      t = await this.grant({ grant_type: "refresh_token", refresh_token: this.sealed.open(rows[0].refresh_token) });
    } catch (e) {
      // revoked, expired or consent withdrawn: connect again
      if ((e as { code?: string }).code === "invalid_grant") {
        await this.db.query("delete from m365_tokens where user_id = $1", [user.id]);
        throw new M365NotConnected(this.connectUrl);
      }
      throw e;
    }
    if (t.refresh_token) await this.store(user, t.refresh_token);
    this.access.set(user.id, { token: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 });
    return t.access_token;
  }

  /** A Graph call as `user`; Graph's errors as ours (404 = NotFound). */
  private async graph(user: User, path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.cfg.graph}${path}`, { ...init, headers: { authorization: `Bearer ${await this.token(user)}`, ...init.headers } });
    if (res.ok) return res;
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const msg = `Microsoft Graph: ${body.error?.message ?? `HTTP ${res.status}`}`;
    if (res.status === 404) throw new NotFound(msg);
    if (res.status === 401) this.access.delete(user.id);
    if (res.status === 403) throw new Forbidden(msg);
    throw new M365Error(msg);
  }

  private async json<T>(user: User, path: string): Promise<T> {
    return (await (await this.graph(user, path)).json()) as T;
  }

  /** Browse: SharePoint sites matching `sites`, a site's document libraries, a folder's content
  (default: the user's OneDrive root) or a search in a drive. */
  async list(user: User, a: { sites?: string | undefined; site_id?: string | undefined; drive_id?: string | undefined; folder_id?: string | undefined; search?: string | undefined }) {
    if (a.sites !== undefined) {
      const r = await this.json<{ value: { id: string; displayName?: string; name?: string; webUrl?: string }[] }>(user, `/sites?search=${seg(a.sites || "*")}`);
      return { sites: r.value.map((s) => ({ site_id: s.id, name: s.displayName ?? s.name ?? s.id, web_url: s.webUrl ?? null })) };
    }
    if (a.site_id) {
      const r = await this.json<{ value: { id: string; name: string; webUrl?: string }[] }>(user, `/sites/${seg(a.site_id)}/drives`);
      return { drives: r.value.map((d) => ({ drive_id: d.id, name: d.name, web_url: d.webUrl ?? null })) };
    }
    const base = drive(a.drive_id);
    const path = a.search
      ? `${base}/root/search(q='${seg(a.search.replace(/'/g, "''"))}')`
      : `${base}${a.folder_id ? `/items/${seg(a.folder_id)}` : "/root"}/children?$top=200`;
    const r = await this.json<{ value: Item[] }>(user, path);
    return { items: r.value.map(item) };
  }

  /** Copy a OneDrive or SharePoint file into the user's uploads: its file_id, as POST /api/files gives. */
  async import(user: User, data: string, a: { drive_id?: string | undefined; item_id: string }) {
    const i = await this.json<Item>(user, `${drive(a.drive_id)}/items/${seg(a.item_id)}`);
    if (i.folder) throw new M365Error(`${i.name} is a folder: list it with m365_list`);
    if (!ACCEPT.test(i.name)) throw new M365Error(`${i.name}: Calque takes PowerPoint, Word, Excel, PDF, CSV, text, Markdown and images`);
    if ((i.size ?? 0) > MAX_UPLOAD) throw new TooLarge(`${i.name} is over ${MAX_UPLOAD / 1024 / 1024} MB`);
    // the pre-authenticated download URL: no bearer token goes to the storage host
    const url = i["@microsoft.graph.downloadUrl"];
    const res = url ? await fetch(url) : await this.graph(user, `${drive(a.drive_id)}/items/${seg(a.item_id)}/content`);
    if (!res.ok) throw new M365Error(`download of ${i.name} failed: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const f = await saveFile(this.db, data, user, i.name, i.file?.mimeType ?? "application/octet-stream", bytes);
    return { ...f, source: { drive_id: i.parentReference?.driveId ?? a.drive_id ?? null, item_id: i.id, web_url: i.webUrl ?? null } };
  }

  /** Upload local file `path` as `name` into a folder (default: the OneDrive root), through an
  upload session (any size); a name taken gets a new one, nothing is overwritten. */
  async save(user: User, path: string, name: string, a: { drive_id?: string | undefined; folder_id?: string | undefined }) {
    const bytes = await readFile(path);
    const folder = a.folder_id ? `/items/${seg(a.folder_id)}` : "/root";
    const res = await this.graph(user, `${drive(a.drive_id)}${folder}:/${seg(name)}:/createUploadSession`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename" } }),
    });
    const { uploadUrl } = (await res.json()) as { uploadUrl: string };
    let done: Item | undefined;
    for (let at = 0; at < bytes.length; at += CHUNK) {
      const part = bytes.subarray(at, at + CHUNK);
      // the upload URL is pre-authenticated: no bearer token goes with it
      const put = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "content-length": String(part.length), "content-range": `bytes ${at}-${at + part.length - 1}/${bytes.length}` },
        body: part,
      });
      if (!put.ok) throw new M365Error(`upload of ${name} failed: HTTP ${put.status}`);
      if (put.status === 200 || put.status === 201) done = (await put.json()) as Item;
    }
    if (!done) throw new M365Error(`upload of ${name} did not complete`);
    return { name: done.name, drive_id: done.parentReference?.driveId ?? a.drive_id ?? null, item_id: done.id, web_url: done.webUrl ?? null };
  }
}

/** A file name OneDrive and SharePoint accept, from a deck title: reserved characters dropped. */
export function fileName(title: string, ext: string): string {
  const stem = title.replace(/["*:<>?/\\|#%]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "") || "deck";
  return `${stem}${ext}`;
}
