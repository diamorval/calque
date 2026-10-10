import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { Conflict, type Access, type UserRow } from "./access.ts";
import { NotFound } from "./packs.ts";

/** A minimal SCIM 2.0 server (RFC 7643/7644), Users only, for deprovisioning from the IdP (Entra ID,
Okta, Keycloak): `active: false` or DELETE revokes the user's sessions and blocks sign-in.
Authenticated by one bearer token, CALQUE_SCIM_TOKEN. */

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";

const UserBody = z.object({
  userName: z.string().min(1),
  externalId: z.string().optional(),
  displayName: z.string().optional(),
  active: z.boolean().optional(),
});
const PatchBody = z.object({
  Operations: z.array(z.object({ op: z.string(), path: z.string().optional(), value: z.unknown() })).min(1),
});

/** Entra sends booleans as "True"/"False". */
const bool = (v: unknown) => (typeof v === "string" ? v.toLowerCase() === "true" : Boolean(v));
const FIELDS = ["userName", "externalId", "displayName"] as const;

/** PATCH operations on the attributes kept here; others (emails, name…) are accepted and ignored. */
function patched(ops: z.infer<typeof PatchBody>["Operations"]) {
  const out: { userName?: string; externalId?: string; displayName?: string; active?: boolean } = {};
  for (const o of ops) {
    if (!["add", "replace"].includes(o.op.toLowerCase())) continue;
    const values: Record<string, unknown> = o.path ? { [o.path]: o.value } : ((o.value as Record<string, unknown>) ?? {});
    for (const [k, v] of Object.entries(values)) {
      if (k === "active") out.active = bool(v);
      const f = FIELDS.find((x) => x.toLowerCase() === k.toLowerCase());
      if (f && typeof v === "string") out[f] = v;
    }
  }
  return out;
}

const FILTER = /^\s*(userName|externalId|id)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;

export function scimRoutes(http: Hono, access: Access, token: string, publicUrl: string) {
  const expected = createHash("sha256").update(token).digest();
  const authorized = (c: Context) => {
    const got = createHash("sha256").update(c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "").digest();
    return timingSafeEqual(got, expected);
  };
  const scim = (c: Context, body: unknown, status: 200 | 201 | 400 | 401 | 404 | 409 = 200) =>
    c.body(JSON.stringify(body), status, { "content-type": "application/scim+json" });
  const error = (c: Context, status: 400 | 401 | 404 | 409, detail: string, scimType?: string) =>
    scim(c, { schemas: [ERROR], status: String(status), detail, ...(scimType ? { scimType } : {}) }, status);
  const resource = (r: UserRow) => ({
    schemas: [USER],
    id: r.id,
    userName: r.user_name,
    ...(r.external_id ? { externalId: r.external_id } : {}),
    ...(r.display_name ? { displayName: r.display_name } : {}),
    active: r.active,
    meta: {
      resourceType: "User",
      created: new Date(r.created_at).toISOString(),
      lastModified: new Date(r.updated_at).toISOString(),
      location: `${publicUrl}/scim/v2/Users/${r.id}`,
    },
  });
  const handle = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
    if (!authorized(c)) return error(c, 401, "invalid SCIM token");
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof NotFound) return error(c, 404, e.message);
      if (e instanceof Conflict) return error(c, 409, e.message, "uniqueness");
      if (e instanceof z.ZodError) return error(c, 400, e.message, "invalidValue");
      return error(c, 400, (e as Error).message);
    }
  };
  const id = (c: Context) => c.req.param("id") as string;

  http.get(
    "/scim/v2/Users",
    handle(async (c) => {
      const q = c.req.query("filter");
      const m = q ? FILTER.exec(q) : undefined;
      if (q && !m) return error(c, 400, "only `userName eq`, `externalId eq` and `id eq` filters are supported", "invalidFilter");
      const attr = m?.[1]?.toLowerCase();
      const rows = await access.list(
        m ? { attr: attr === "username" ? "userName" : attr === "externalid" ? "externalId" : "id", value: JSON.parse(`"${m[2]}"`) as string } : undefined,
      );
      const start = Math.max(1, Number(c.req.query("startIndex") ?? 1) || 1);
      const count = Math.max(0, Number(c.req.query("count") ?? rows.length) || 0);
      const page = rows.slice(start - 1, start - 1 + count);
      return scim(c, { schemas: [LIST], totalResults: rows.length, startIndex: start, itemsPerPage: page.length, Resources: page.map(resource) });
    }),
  );
  http.get("/scim/v2/Users/:id", handle(async (c) => scim(c, resource(await access.get(id(c))))));
  http.post("/scim/v2/Users", handle(async (c) => scim(c, resource(await access.create(UserBody.parse(await c.req.json()))), 201)));
  http.put("/scim/v2/Users/:id", handle(async (c) => scim(c, resource(await access.update(id(c), UserBody.parse(await c.req.json()))))));
  http.patch(
    "/scim/v2/Users/:id",
    handle(async (c) => scim(c, resource(await access.update(id(c), patched(PatchBody.parse(await c.req.json()).Operations))))),
  );
  http.delete(
    "/scim/v2/Users/:id",
    handle(async (c) => {
      await access.remove(id(c));
      return c.body(null, 204);
    }),
  );
}
