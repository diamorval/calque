// One page, two doors: the MCP App inside Claude (host bridge) and the web preview /decks/:id (REST).
import { App } from "@modelcontextprotocol/ext-apps";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DeckViewer } from "../src/DeckViewer.tsx";
import type { DeckView, NewComment } from "../src/types.ts";
import "../src/styles.css";

interface Backend {
  load(): Promise<DeckView | null>;
  comment(c: NewComment): Promise<void>;
  apply?: () => Promise<void>;
  /** Subscribe to "something new to show" (a tool result, a newer version). */
  watch(changed: () => void): void;
}

const POLL_MS = 4000;

function web(id: string): Backend {
  const base = `/decks/${id}`;
  let version = 0;
  return {
    async load() {
      const res = await fetch(`${base}/data`);
      if (!res.ok) throw new Error((await res.json()).message);
      const deck = (await res.json()) as DeckView;
      version = deck.head;
      return deck;
    },
    async comment(c) {
      const res = await fetch(`${base}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) });
      if (!res.ok) throw new Error((await res.json()).message);
    },
    watch(changed) {
      setInterval(async () => {
        const res = await fetch(`${base}/data`);
        if (res.ok && ((await res.json()) as DeckView).head !== version) changed();
      }, POLL_MS);
    },
  };
}

function mcp(): Backend {
  const app = new App({ name: "calque-deck", version: "0.1.0" }, {});
  let deckId: string | null = null;
  let deck: DeckView | null = null;
  let changed = () => {};
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await app.callServerTool({ name, arguments: args });
    if (r.isError) throw new Error(JSON.stringify(r.structuredContent));
    return r.structuredContent as Record<string, unknown>;
  };
  app.ontoolresult = ({ structuredContent }) => {
    const id = (structuredContent as { deck_id?: string } | undefined)?.deck_id;
    if (id) {
      deckId = id;
      changed();
    }
  };
  const ready = app.connect();
  return {
    async load() {
      await ready;
      if (!deckId) return null;
      deck = (await call("open_deck", { deck_id: deckId })) as unknown as DeckView;
      return deck;
    },
    async comment(c) {
      if (!deckId) return;
      await call("add_comment", { deck_id: deckId, ...c });
      const { comments } = (await call("list_comments", { deck_id: deckId })) as { comments: NewComment[] };
      // the host keeps only the last context update: always send every open comment
      await app.updateModelContext({
        content: [
          {
            type: "text",
            text: `Open comments on deck "${deck?.title}" (deck_id ${deckId}), anchored on slide id and shape_id:\n${JSON.stringify(comments)}`,
          },
        ],
      });
    },
    async apply() {
      await app.sendMessage({
        role: "user",
        content: [{ type: "text", text: `Apply the open comments on deck ${deckId} with patch_deck, resolving each one.` }],
      });
    },
    watch(cb) {
      changed = cb;
      setInterval(async () => {
        if (!deckId || !deck) return;
        const head = (await call("open_deck", { deck_id: deckId, render: false })).head;
        if (head !== deck.head) cb();
      }, POLL_MS);
    },
  };
}

function Root({ backend }: { backend: Backend }) {
  const [deck, setDeck] = useState<DeckView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const reload = () => backend.load().then(setDeck, (e: Error) => setError(e.message));
    backend.watch(reload);
    reload();
  }, [backend]);
  if (error) return <p role="alert">{error}</p>;
  if (!deck) return <p>Loading deck…</p>;
  return (
    <DeckViewer
      deck={deck}
      onComment={async (c) => {
        await backend.comment(c);
        setDeck(await backend.load());
      }}
      {...(backend.apply ? { onApply: backend.apply } : {})}
    />
  );
}

const id = location.pathname.match(/^\/decks\/([^/]+)/)?.[1];
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Root backend={id ? web(id) : mcp()} />
  </StrictMode>,
);
