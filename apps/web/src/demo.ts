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

  const shares = new Map<string, Json>();
  const link = (id: string) =>
    `${location.origin}${BASE}/decks/${id}?k=${Math.random().toString(36).slice(2)}`;
  const sharing = (id: string): Json => {
    if (!shares.has(id))
      shares.set(id, {
        owner: "local",
        people: [],
        general: { access: "private", role: "viewer" },
        url: link(id),
      });
    return shares.get(id) as Json;
  };

  // method + path pattern -> answer; the request body is parsed JSON, or the FormData of an upload
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routes: [RegExp, (m: string[], b: any) => unknown][] = [
    [
      /^POST \/api\/models$/,
      (_, b) => {
        const prev = models.models.find((x: Json) => x.id === b.id);
        const m = {
          id: b.id ?? `demo-${Date.now()}`,
          provider: b.provider,
          model: b.model,
          label: b.label ?? null,
          base_url: b.base_url ?? null,
          has_key: !!b.api_key || !!prev?.has_key,
          headers: b.headers ? Object.keys(b.headers) : (prev?.headers ?? []),
          resource: b.resource ?? null,
          api_version: b.api_version ?? null,
          managed_identity: !!b.managed_identity,
          is_default: !!prev?.is_default,
        };
        const saved = prev ? Object.assign(prev, m) : m;
        if (!prev) models.models.push(m);
        if (b.default || models.models.length === 1)
          for (const x of models.models) x.is_default = x === saved;
        return saved;
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
    [/^GET \/api\/packs$/, () => ({ packs })],
    [/^GET \/api\/branding$/, () => ({ name: "Calque", logo: null })],
    [
      // the Decks page's search: titles only here (the server also searches the slides)
      /^GET \/api\/decks\?(.*)$/,
      ([, qs]) => {
        const p = new URLSearchParams(qs);
        const words = (p.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        return {
          decks: decks.filter(
            (d) =>
              (!p.get("pack_id") || d.pack_id === p.get("pack_id")) &&
              words.every((w) => String(d.title).toLowerCase().includes(w)),
          ),
        };
      },
    ],
    [
      /^POST \/api\/packs\/([^/]+)\/archive$/,
      ([, id], b) => {
        const p = packs.find((x) => x.id === id);
        Object.assign(p ?? {}, { archived: b.archived });
        return { id, archived: b.archived };
      },
    ],
    [
      /^GET \/api\/packs\/([^/]+)\/versions$/,
      ([, id]) => ({
        id,
        current: 1,
        versions: [
          {
            version: 1,
            note: "initial version",
            author: null,
            created_at: new Date().toISOString(),
          },
        ],
      }),
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
      /^POST \/api\/files$/,
      (_, f: FormData) => {
        const file = f.get("file") as File;
        return { file_id: `demo-${Date.now()}`, name: file.name, size: file.size, type: file.type };
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
        const parent = b.parent_id !== undefined ? deck.open_comments.find((c: Json) => c.id === b.parent_id) : undefined;
        const comment = {
          id: Date.now(),
          deck_id: b.deck_id,
          version: deck.head,
          slide_id: parent?.slide_id ?? b.slide_id,
          shape_id: parent ? parent.shape_id : (b.shape_id ?? null),
          text: b.text,
          author: "demo",
          author_name: "Demo",
          status: "open",
          parent_id: parent?.id ?? null,
          replies: [],
          created_at: new Date().toISOString(),
        };
        if (parent) parent.replies = [...(parent.replies ?? []), comment];
        else deck.open_comments.push(comment);
        return { comment };
      },
    ],
    [
      /^POST \/api\/tools\/resolve_comments$/,
      (_, b) => {
        const deck = opened(b.deck_id);
        const all: Json[] = [...deck.open_comments, ...(deck.resolved_comments ?? [])];
        for (const c of all) if (b.comment_ids.includes(c.id)) c.status = b.status ?? "resolved";
        deck.open_comments = all.filter((c) => c.status === "open");
        deck.resolved_comments = all.filter((c) => c.status === "resolved");
        return { status: b.status ?? "resolved", comment_ids: b.comment_ids };
      },
    ],
    // sharing, in memory: people, general access and the share link of each deck
    [/^POST \/api\/tools\/list_shares$/, (_, b) => sharing(b.deck_id)],
    [
      /^POST \/api\/tools\/share_deck$/,
      (_, b) => {
        const s = sharing(b.deck_id);
        s.people = s.people.filter((p: Json) => p.principal !== b.principal);
        s.people.push({ principal_type: b.principal_type, principal: b.principal, role: b.role });
        return { principal_type: b.principal_type, principal: b.principal, role: b.role };
      },
    ],
    [
      /^POST \/api\/tools\/unshare_deck$/,
      (_, b) => {
        const s = sharing(b.deck_id);
        s.people = s.people.filter((p: Json) => p.principal !== b.principal);
        return { principal_type: b.principal_type, principal: b.principal };
      },
    ],
    [
      /^POST \/api\/tools\/set_general_access$/,
      (_, b) => {
        sharing(b.deck_id).general = { access: b.access, role: b.role ?? "viewer" };
        return sharing(b.deck_id).general;
      },
    ],
    [
      /^POST \/api\/tools\/reset_link$/,
      (_, b) => {
        const s = sharing(b.deck_id);
        s.url = link(b.deck_id);
        return { deck_id: b.deck_id, url: s.url };
      },
    ],
    // the agent's conversation lives in the chat only (no server here), and nobody has used a model
    [/^POST \/api\/tools\/get_chat$/, (_, b) => ({ deck_id: b.deck_id ?? null, messages: [], files: [], can_write: true })],
    [/^POST \/api\/tools\/clear_chat$/, (_, b) => ({ deck_id: b.deck_id ?? null, cleared: true })],
    [
      /^GET \/api\/admin\/usage/,
      () => ({ total: { runs: 0, input_tokens: 0, output_tokens: 0, duration_ms: 0 }, by_user: [], by_team: [], by_model: [] }),
    ],
    // the slide library starts empty (adding to it is read-only here)
    [/^POST \/api\/tools\/library_list$/, () => ({ entries: [] })],
    // an imported file opens a deck the engine built earlier on that pack
    [
      /^POST \/api\/tools\/import_pptx$/,
      (_, b) => ({
        deck_id: (decks.find((d) => d.pack_id === b.pack_id) ?? decks[0])?.id,
      }),
    ],
    // the review report, from the saved lint: a generated deck has no safe fixes to apply
    [
      /^POST \/api\/tools\/review_deck$/,
      (_, b) => {
        if (b.apply_safe_fixes)
          return Response.json(READ_ONLY, { status: 403 });
        const lint: Json =
          api[
            `POST /api/tools/lint_deck ${JSON.stringify({ deck_id: b.deck_id })}`
          ] ?? { version: 1, findings: [] };
        const of = (s: string) =>
          lint.findings.filter((f: Json) => f.severity === s);
        return {
          report: {
            version: lint.version,
            ERROR: of("ERROR"),
            WARN: of("WARN"),
            NOTE: of("NOTE"),
            safe_fixes: [],
            judgment_calls: lint.findings.filter(
              (f: Json) => f.severity !== "NOTE",
            ),
          },
          applied: [],
        };
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
          { step: { tools: [{ name: "open_deck" }] } },
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
        { step: { tools: [{ name: "list_packs" }] } },
        { step: { tools: [{ name: "create_deck" }] } },
        { done: { model: "demo", text, messages } },
      ]);
    }
    for (const [re, answer] of routes) {
      const m = req.match(re);
      if (!m) continue;
      const out = answer(
        m,
        init?.body instanceof FormData
          ? init.body
          : JSON.parse((init?.body as string) || "{}"),
      );
      return out instanceof Response ? out : Response.json(out);
    }
    return Response.json(READ_ONLY, { status: 403 });
  };
}
