// One page, two doors: the MCP App inside Claude (host bridge) and the web preview /decks/:id (REST).
import { App } from "@modelcontextprotocol/ext-apps";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DeckViewer } from "../src/DeckViewer.tsx";
import type { DeckView, NewComment, NewReply } from "../src/types.ts";
import "../src/styles.css";

interface Backend {
  load(): Promise<DeckView | null>;
  comment(c: NewComment | NewReply): Promise<void>;
  resolve(ids: number[], status: "open" | "resolved"): Promise<void>;
  /** Hand comments `ids` (default: every open one) to the agent. */
  apply?: (ids?: number[]) => Promise<void>;
  /** Subscribe to "something new to show" (a tool result, a newer version). */
  watch(changed: () => void): void;
}

const POLL_MS = 4000;

function web(id: string): Backend {
  const base = `/decks/${id}`;
  // the deck's share link (?k=) or a per-user token (?t=) authorizes every request, else the web
  // session; image URLs in the data carry it already
  const s = new URLSearchParams(location.search);
  const [k, t] = [s.get("k"), s.get("t")];
  const q = t ? `?t=${encodeURIComponent(t)}` : k ? `?k=${encodeURIComponent(k)}` : "";
  let version = 0;
  return {
    async load() {
      const res = await fetch(`${base}/data${q}`);
      if (!res.ok) throw new Error((await res.json()).message);
      const deck = (await res.json()) as DeckView;
      version = deck.head;
      return deck;
    },
    async comment(c) {
      const res = await fetch(`${base}/comments${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) });
      if (!res.ok) throw new Error((await res.json()).message);
    },
    async resolve(comment_ids, status) {
      const res = await fetch(`${base}/comments/resolve${q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ comment_ids, status }),
      });
      if (!res.ok) throw new Error((await res.json()).message);
    },
    watch(changed) {
      setInterval(async () => {
        const res = await fetch(`${base}/data${q}`);
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
  /** Tell the model the open comment threads; the host keeps only the last context update, so
  always send every one. */
  const share = async () => {
    if (!deckId) return;
    const { comments } = (await call("list_comments", { deck_id: deckId })) as { comments: unknown[] };
    await app.updateModelContext({
      content: [
        {
          type: "text",
          text: `Open comments on deck "${deck?.title}" (deck_id ${deckId}), anchored on slide id and shape_id, with their replies:\n${JSON.stringify(comments)}`,
        },
      ],
    });
  };
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
      await share();
    },
    async resolve(comment_ids, status) {
      if (!deckId) return;
      await call("resolve_comments", { deck_id: deckId, comment_ids, status });
      await share();
    },
    async apply(ids) {
      const which = ids?.length ? `the open comment${ids.length > 1 ? "s" : ""} ${ids.join(", ")} (only these)` : "the open comments";
      await app.sendMessage({
        role: "user",
        content: [{ type: "text", text: `Apply ${which} on deck ${deckId} with patch_deck, resolving each one.` }],
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
  if (error)
    return (
      <div className="cq-empty">
        <p role="alert" className="cq-alert" data-tone="danger">
          {error}
        </p>
      </div>
    );
  if (!deck)
    return (
      <div className="cq-empty">
        <span className="cq-spinner">Loading deck…</span>
      </div>
    );
  // a viewer reads only; applying comments edits the deck, resolving others' too
  const edits = !deck.role || deck.role === "editor" || deck.role === "owner";
  const then = (fn: () => Promise<void>) => async () => {
    await fn();
    setDeck(await backend.load());
  };
  return (
    <DeckViewer
      deck={deck}
      {...(deck.role !== "viewer"
        ? {
            onComment: (c: NewComment) => then(() => backend.comment(c))(),
            onReply: (r: NewReply) => then(() => backend.comment(r))(),
          }
        : {})}
      {...(edits ? { onResolve: (ids: number[], status: "open" | "resolved") => then(() => backend.resolve(ids, status))() } : {})}
      {...(backend.apply && edits ? { onApply: backend.apply } : {})}
    />
  );
}

const id = location.pathname.match(/^\/decks\/([^/]+)/)?.[1];
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Root backend={id ? web(id) : mcp()} />
  </StrictMode>,
);
