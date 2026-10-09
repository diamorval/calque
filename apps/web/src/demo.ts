// The GitHub Pages demo (VITE_DEMO=1): no server. Reads replay the responses saved by
// demo/snapshot.ts; anything that would change a deck or call a model is refused.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const READ_ONLY = { message: "This is a read-only demo: run Calque locally to edit decks with an AI." };

export async function startDemo() {
  const saved = await fetch(`${BASE}/api.json`).then((r) => r.text());
  const api: Record<string, unknown> = JSON.parse(saved.replaceAll("https://calque.demo", location.origin + BASE));
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (!path.startsWith("/api/")) return real(input, init);
    const body = typeof init?.body === "string" ? ` ${init.body}` : "";
    const hit = api[`${init?.method ?? "GET"} ${path}${body}`];
    return Response.json(hit ?? READ_ONLY, { status: hit ? 200 : 403 });
  };
}
