import { readFileSync } from "node:fs";
import { ADMIN_TEAM } from "./packs.ts";

/** How a token's group claim becomes the user's teams (pack visibility, model admin).
Keycloak sends group paths ("/sales"); Entra ID sends group object ids (GUIDs), which
CALQUE_TEAMS_MAP names: `{"<group GUID>": "sales", …}`, inline JSON or a JSON file path. */
export interface TeamsConfig {
  claim: string; // CALQUE_TEAMS_CLAIM, default "groups"
  map?: Record<string, string> | undefined; // CALQUE_TEAMS_MAP
  /** drop the groups the map does not name (CALQUE_TEAMS_MAP_ONLY=1): GUIDs never show as teams */
  mappedOnly?: boolean | undefined;
  /** keep only the teams starting with it, and the admin team (CALQUE_TEAMS_PREFIX): directory groups never show as teams */
  prefix?: string | undefined;
}

export function teamsConfig(env = process.env): TeamsConfig {
  const raw = env.CALQUE_TEAMS_MAP?.trim();
  let map: Record<string, string> | undefined;
  if (raw) {
    const text = raw.startsWith("{") ? raw : readFileSync(raw.replace(/^file:/, ""), "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((v) => typeof v !== "string"))
      throw new Error("CALQUE_TEAMS_MAP: a JSON object of group id -> team name");
    map = parsed as Record<string, string>;
  } else if (env.CALQUE_TEAMS_MAP_ONLY === "1") {
    throw new Error("CALQUE_TEAMS_MAP_ONLY=1 needs CALQUE_TEAMS_MAP");
  }
  return { claim: env.CALQUE_TEAMS_CLAIM ?? "groups", map, mappedOnly: env.CALQUE_TEAMS_MAP_ONLY === "1", prefix: env.CALQUE_TEAMS_PREFIX || undefined };
}

/** Entra ID leaves the groups out of a token past 200 groups (`_claim_names.groups` points to
Graph) or, in the implicit flow, past 6 (`hasgroups: true`). Calque makes no Graph call. */
function overage(claims: Record<string, unknown>, claim: string): boolean {
  const names = claims._claim_names;
  return claims.hasgroups === true || claims.hasgroups === "true" || (!!names && typeof names === "object" && claim in names);
}

const warned = new Set<string>();

/** The user's teams from token claims: the claim's values, a leading "/" stripped, mapped, filtered by prefix, deduped. */
export function teamsOf(claims: Record<string, unknown>, cfg: TeamsConfig, warn: (m: string) => void = console.warn): string[] {
  const raw = claims[cfg.claim];
  if (!Array.isArray(raw)) {
    // once per user: every MCP request carries the token
    if (overage(claims, cfg.claim) && !warned.has(String(claims.sub)) && warned.add(String(claims.sub)))
      warn(
        `user ${String(claims.sub)}: the token has no "${cfg.claim}" (Entra ID group overage: over 200 groups). ` +
          `They get no teams. In the Entra app registration, emit only the groups assigned to the application ` +
          `(Token configuration > groups claim > "Groups assigned to the application").`,
      );
    return [];
  }
  const out = new Set<string>();
  for (const g of raw.map((t) => String(t).replace(/^\//, ""))) {
    const named = cfg.map?.[g];
    if (named) out.add(named);
    else if (!cfg.mappedOnly) out.add(g);
  }
  return [...out].filter((t) => !cfg.prefix || t.startsWith(cfg.prefix) || t === ADMIN_TEAM);
}
