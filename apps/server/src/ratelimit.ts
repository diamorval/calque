import type { Context, MiddlewareHandler } from "hono";

/** In-memory fixed-window rate limit: at most `max` requests per `windowMs` per key (the caller's
address, or what `key` derives). One server process; a shared store would be needed for several.
CALQUE_RATE_LIMIT=off disables every limit (load tests). */
export function rateLimit(opts: { max: number; windowMs?: number; key?: (c: Context) => string | Promise<string> }): MiddlewareHandler {
  const windowMs = opts.windowMs ?? 60_000;
  const hits = new Map<string, { n: number; reset: number }>();
  return async (c, next) => {
    if (process.env.CALQUE_RATE_LIMIT === "off") return next();
    const now = Date.now();
    const k = await (opts.key ?? clientAddress)(c);
    let h = hits.get(k);
    if (!h || h.reset <= now) {
      if (hits.size > 10_000) for (const [x, v] of hits) if (v.reset <= now) hits.delete(x);
      h = { n: 0, reset: now + windowMs };
      hits.set(k, h);
    }
    if (++h.n > opts.max) {
      const retry = Math.ceil((h.reset - now) / 1000);
      c.header("retry-after", String(retry));
      return c.json({ error: "TooManyRequests", message: `too many requests: retry in ${retry}s` }, 429);
    }
    return next();
  };
}

/** The caller's address: the first X-Forwarded-For hop behind a trusted proxy (CALQUE_TRUST_PROXY=1),
else the socket's. */
export function clientAddress(c: Context): string {
  if (process.env.CALQUE_TRUST_PROXY === "1") {
    const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (fwd) return fwd;
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "local";
}
