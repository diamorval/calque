/** Entra ID group overage (S13): past 200 groups (6 in the implicit flow) Entra leaves `groups` out
of the token and points to Graph instead (`_claim_names.groups`, `hasgroups`). Calque then reads the
user's groups (transitive: nested groups count) from Microsoft Graph:

- **delegated**, with the sign-in access token, when it is a Graph token allowed to read memberships
  (`GroupMember.Read.All`, `Group.Read.All`, `Directory.Read.All`): the web sign-in, when
  CALQUE_OIDC_SCOPE asks for one of them;
- **app-only**, with client credentials (CALQUE_ENTRA_TENANT, CALQUE_ENTRA_CLIENT_ID,
  CALQUE_ENTRA_CLIENT_SECRET; application permission `GroupMember.Read.All`): any door, the MCP one
  included, whose bearer token is for Calque, not Graph.

Group ids are kept 10 minutes per user: every MCP request carries the token. */

export interface EntraConfig {
  authority: string; // CALQUE_ENTRA_AUTHORITY, default https://login.microsoftonline.com
  graph: string; // CALQUE_ENTRA_GRAPH, default https://graph.microsoft.com/v1.0
  /** app-only lookups: all three set */
  tenant?: string | undefined; // CALQUE_ENTRA_TENANT
  clientId?: string | undefined; // CALQUE_ENTRA_CLIENT_ID
  clientSecret?: string | undefined; // CALQUE_ENTRA_CLIENT_SECRET
}

export function entraConfig(env = process.env): EntraConfig {
  return {
    authority: (env.CALQUE_ENTRA_AUTHORITY ?? "https://login.microsoftonline.com").replace(/\/$/, ""),
    graph: (env.CALQUE_ENTRA_GRAPH ?? "https://graph.microsoft.com/v1.0").replace(/\/$/, ""),
    tenant: env.CALQUE_ENTRA_TENANT || undefined,
    clientId: env.CALQUE_ENTRA_CLIENT_ID || undefined,
    clientSecret: env.CALQUE_ENTRA_CLIENT_SECRET || undefined,
  };
}

/** Delegated scopes that let `/me/transitiveMemberOf` list the user's groups. */
const READS_GROUPS = ["GroupMember.Read.All", "Group.Read.All", "Directory.Read.All", "Directory.ReadWrite.All", "Directory.AccessAsUser.All"];
const TTL = 10 * 60_000;

/** The scopes of a Graph access token, read without verifying it (Graph does that). */
function scopesOf(token: string): string[] {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { scp?: unknown };
    return typeof p.scp === "string" ? p.scp.split(" ") : [];
  } catch {
    return [];
  }
}

export class EntraGroups {
  private readonly cfg: EntraConfig;
  private readonly cache = new Map<string, { ids: string[]; until: number }>();
  private app?: { token: string; until: number } | undefined;

  constructor(cfg: EntraConfig) {
    this.cfg = cfg;
  }

  get appOnly(): boolean {
    return !!(this.cfg.tenant && this.cfg.clientId && this.cfg.clientSecret);
  }

  /** The group ids of the user `claims` name, from Graph; undefined when no way to ask is set up. */
  async groups(claims: Record<string, unknown>, accessToken?: string): Promise<string[] | undefined> {
    const oid = String(claims.oid ?? claims.sub);
    const hit = this.cache.get(oid);
    if (hit && hit.until > Date.now()) return hit.ids;
    let ids: string[] | undefined;
    if (accessToken && scopesOf(accessToken).some((s) => READS_GROUPS.includes(s))) ids = await this.list("/me", accessToken);
    else if (this.appOnly && typeof claims.oid === "string") ids = await this.list(`/users/${encodeURIComponent(claims.oid)}`, await this.appToken());
    if (ids) this.cache.set(oid, { ids, until: Date.now() + TTL });
    return ids;
  }

  /** Every group `who` is a member of, directly or through nested groups, page by page. */
  private async list(who: string, token: string): Promise<string[]> {
    const ids: string[] = [];
    let url: string | undefined = `${this.cfg.graph}${who}/transitiveMemberOf/microsoft.graph.group?$select=id&$top=999`;
    while (url) {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      const body = (await res.json().catch(() => ({}))) as { value?: { id: string }[]; "@odata.nextLink"?: string; error?: { message?: string } };
      if (!res.ok) throw new Error(`Microsoft Graph: ${body.error?.message ?? `HTTP ${res.status}`}`);
      ids.push(...(body.value ?? []).map((g) => g.id));
      url = body["@odata.nextLink"];
    }
    return ids;
  }

  private async appToken(): Promise<string> {
    if (this.app && this.app.until > Date.now()) return this.app.token;
    const res = await fetch(`${this.cfg.authority}/${encodeURIComponent(this.cfg.tenant as string)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.cfg.clientId as string,
        client_secret: this.cfg.clientSecret as string,
        scope: `${new URL(this.cfg.graph).origin}/.default`,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!res.ok || !body.access_token) throw new Error(`Entra ID refused the app's token: ${body.error_description ?? body.error ?? res.status}`);
    this.app = { token: body.access_token, until: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 };
    return body.access_token;
  }
}
