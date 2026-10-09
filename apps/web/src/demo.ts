// The GitHub Pages demo (VITE_DEMO=1): no server. Reads replay the responses saved by
// demo/snapshot.ts; the settings and comments change in memory (gone on reload), and the agent
// answers from a script: no model runs here, so no deck changes.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const READ_ONLY = {
  message:
    "This is a read-only demo: run Calque locally to edit decks with an AI.",
};
const AGENT_DEMO =
  "This is the demo: no model runs here, so I can't change the deck. Run Calque locally with a model to co-edit it. Meanwhile, leave comments on the slides or look around.";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** An agent run as the server streams it: one line per step, then the result. */
function stream(lines: Json[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(c) {
      for (const l of lines) {
        await new Promise((r) => setTimeout(r, 500));
        c.enqueue(enc.encode(`${JSON.stringify(l)}\n`));
      }
      c.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "application/x-ndjson" },
  });
}

export async function startDemo() {
  const saved = await fetch(`${BASE}/api.json`).then((r) => r.text());
  const api: Json = JSON.parse(
    saved.replaceAll("https://calque.demo", location.origin + BASE),
  );
  const packs: Json[] = api["POST /api/tools/list_packs {}"].packs;
  const models: Json = api["GET /api/models"];
  const draft: Json = api["POST /api/packs/diametral/edit {}"];
  const decks: Json[] = api["GET /api/decks"].decks;
  const opened = (id: string): Json =>
    api[`POST /api/tools/open_deck ${JSON.stringify({ deck_id: id })}`];
  const fonts: string[] = [...draft.fonts];
  if (!models.models.length)
    models.models = [
      {
        id: "demo-anthropic",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        base_url: null,
        has_key: true,
        is_default: true,
      },
      {
        id: "demo-openai",
        provider: "openai",
        model: "gpt-5",
        base_url: null,
        has_key: true,
        is_default: false,
      },
    ];

  // method + path pattern -> answer; the request body is parsed JSON, or the FormData of an upload
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routes: [RegExp, (m: string[], b: any) => unknown][] = [
    [
      /^POST \/api\/models$/,
      (_, b) => {
        const m = {
          id: `demo-${Date.now()}`,
          provider: b.provider,
          model: b.model,
          base_url: b.base_url ?? null,
          has_key: !!b.api_key,
          is_default: false,
        };
        models.models.push(m);
        if (b.default || models.models.length === 1)
          for (const x of models.models) x.is_default = x === m;
        return m;
      },
    ],
    [
      /^POST \/api\/models\/([^/]+)\/default$/,
      ([, id]) => {
        for (const x of models.models)
          x.is_default = x.id === decodeURIComponent(String(id));
        return {};
      },
    ],
    [
      /^DELETE \/api\/models\/([^/]+)$/,
      ([, id]) => {
        models.models = models.models.filter(
          (x: Json) => x.id !== decodeURIComponent(String(id)),
        );
        return {};
      },
    ],
    [
      /^POST \/api\/packs\/([^/]+)\/visibility$/,
      ([, id], b) => {
        const p = packs.find((x) => x.id === id);
        Object.assign(p ?? {}, {
          visibility: b.visibility,
          teams: b.visibility === "team" ? b.teams : [],
        });
        return p;
      },
    ],
    // any pack, and any uploaded template, opens on the Diametral template's review screen
    [
      /^POST \/api\/packs\/([^/]+)\/edit$/,
      ([, id]) => {
        const name = packs.find((x) => x.id === id)?.name;
        return {
          ...draft,
          draft_id: id,
          manifest: { ...draft.manifest, id, name },
        };
      },
    ],
    [
      /^POST \/api\/packs\/drafts$/,
      (_, f: FormData) => {
        const id = String(f.get("id"));
        return {
          ...draft,
          draft_id: id,
          manifest: {
            ...draft.manifest,
            id,
            name: String(f.get("name") || id),
          },
          voice: undefined,
          fonts: [],
        };
      },
    ],
    [
      /^POST \/api\/packs\/drafts\/[^/]+\/fonts$/,
      (_, f: FormData) => {
        const font = f.get("font");
        if (font instanceof File && !fonts.includes(font.name))
          fonts.push(font.name);
        return { fonts };
      },
    ],
    [
      /^POST \/api\/packs\/drafts\/([^/]+)\/publish$/,
      ([, id], b) => {
        const p = packs.find((x) => x.id === id);
        const fields = {
          name: b.manifest.name,
          default_language: b.manifest.default_language,
        };
        if (p) Object.assign(p, fields);
        else
          packs.push({
            id,
            version: "0.1.0",
            languages: [b.manifest.default_language ?? "en"],
            visibility: b.visibility,
            teams: b.visibility === "team" ? b.teams : [],
            owner: "local",
            editable: true,
            ...fields,
          });
        return { status: "published" };
      },
    ],
    [
      /^POST \/api\/tools\/add_comment$/,
      (_, b) => {
        const deck = opened(b.deck_id);
        const comment = {
          id: Date.now(),
          deck_id: b.deck_id,
          version: deck.head,
          slide_id: b.slide_id,
          shape_id: b.shape_id ?? null,
          text: b.text,
          author: "Demo",
          status: "open",
          created_at: new Date().toISOString(),
        };
        deck.open_comments.push(comment);
        return { comment };
      },
    ],
  ];

  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.pathname
          : input.url;
    if (!path.startsWith("/api/")) return real(input, init);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? ` ${init.body}` : "";
    const hit = api[`${method} ${path}${body}`];
    if (hit) return Response.json(hit);

    const req = `${method} ${path}`;
    if (req === "POST /api/agent/chat") {
      const b = JSON.parse(String(init?.body));
      if (b.deck_id)
        return stream([
          { step: { tools: ["open_deck"] } },
          {
            done: {
              model: "demo",
              text: AGENT_DEMO,
              messages: [{ role: "assistant", content: AGENT_DEMO }],
            },
          },
        ]);
      // a new deck: open one the real engine built earlier on this pack
      const deck = decks.find((d) => d.pack_id === b.pack_id) ?? decks[0] ?? {};
      const text = `This is the demo: no model runs here, so here is a deck the engine built earlier on this pack, "${deck.title}". Run Calque locally to build one from your brief.`;
      const messages = [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolName: "create_deck" }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: "create_deck",
              output: { deck_id: deck.id },
            },
          ],
        },
        { role: "assistant", content: text },
      ];
      return stream([
        { step: { tools: ["list_packs"] } },
        { step: { tools: ["create_deck"] } },
        { done: { model: "demo", text, messages } },
      ]);
    }
    for (const [re, answer] of routes) {
      const m = req.match(re);
      if (m)
        return Response.json(
          answer(
            m,
            init?.body instanceof FormData
              ? init.body
              : JSON.parse((init?.body as string) || "{}"),
          ),
        );
    }
    return Response.json(READ_ONLY, { status: 403 });
  };
}
