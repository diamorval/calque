// DTCG tokens: flatten, resolve `{group.token}` aliases. Mirrors engine/src/calque_engine/tokens.py.

export type TokenTree = { [key: string]: unknown };
export interface Token {
  $value: unknown;
  $type?: string;
  $description?: string;
}

const ALIAS = /^\{([^{}]+)\}$/;

export function flatten(tree: TokenTree): Map<string, Token> {
  const out = new Map<string, Token>();
  const walk = (node: TokenTree, path: string, inherited?: string) => {
    const type = (node.$type as string | undefined) ?? inherited;
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("$") || typeof child !== "object" || child === null) continue;
      const p = path ? `${path}.${key}` : key;
      const c = child as TokenTree;
      if ("$value" in c) {
        const t = (c.$type as string | undefined) ?? type;
        out.set(p, { ...(c as unknown as Token), ...(t ? { $type: t } : {}) });
      } else walk(c, p, type);
    }
  };
  walk(tree, "");
  return out;
}

export function resolve(tree: TokenTree): Map<string, unknown> {
  const flat = flatten(tree);
  const done = new Map<string, unknown>();
  const valueOf = (path: string, seen: string[]): unknown => {
    if (done.has(path)) return done.get(path);
    if (seen.includes(path)) throw new Error(`circular alias: ${[...seen, path].join(" -> ")}`);
    const tok = flat.get(path);
    if (!tok) throw new Error(`unknown token: ${path}${seen.length ? ` (from ${seen.at(-1)})` : ""}`);
    const m = typeof tok.$value === "string" ? ALIAS.exec(tok.$value) : null;
    const v = m?.[1] ? valueOf(m[1], [...seen, path]) : tok.$value;
    done.set(path, v);
    return v;
  };
  for (const p of flat.keys()) valueOf(p, []);
  return done;
}

export function hex6(v: unknown): string {
  const s = String(v).replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(s)) throw new Error(`not a 6-digit hex colour: ${String(v)}`);
  return s.toUpperCase();
}

export function family(v: unknown): string {
  return Array.isArray(v) ? String(v[0]) : String(v);
}

/** Set `a.b.c` in a nested object, creating groups on the way. */
export function setPath(tree: TokenTree, path: string, token: Token): void {
  const keys = path.split(".");
  const last = keys.pop() ?? path;
  let node = tree;
  for (const k of keys) node = (node[k] ??= {}) as TokenTree;
  node[last] = token;
}

/**
 * Import a token file whose aliases point at a token's `name` (`{ds-noir}`) instead of its path,
 * keeping only the listed groups. Returns a DTCG tree under `prefix` with path aliases.
 */
export function importNamed(source: TokenTree, groups: string[], prefix: string): TokenTree {
  const flat = flatten(source);
  const byName = new Map<string, string>();
  for (const [p, t] of flat) {
    const name = (t as Token & { name?: string }).name;
    if (name) byName.set(name, p);
  }
  const keep = (p: string) => groups.some((g) => p === g || p.startsWith(`${g}.`));
  const rename = (p: string) => `${prefix}.${p.split(".").at(-1)}`;
  const out: TokenTree = {};
  for (const [p, t] of flat) {
    if (!keep(p)) continue;
    let value = t.$value;
    const m = typeof value === "string" ? ALIAS.exec(value) : null;
    if (m?.[1]) {
      const target = byName.get(m[1]);
      if (!target || !keep(target)) throw new Error(`${p}: alias ${value} leaves the imported groups`);
      value = `{${rename(target)}}`;
    }
    setPath(out, rename(p), { $value: value, ...(t.$type ? { $type: t.$type } : {}) });
  }
  return out;
}
