import { Button } from "diametral-ds/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "diametral-ds/empty";
import { LayoutGrid, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { go, navigate } from "../nav.ts";
import { ago, PageHead, Spinner } from "../ui.tsx";

interface DeckRow {
  id: string;
  title: string;
  pack_id: string;
  head: number;
  updated_at: string;
}

export function Decks() {
  const [decks, setDecks] = useState<DeckRow[] | null>(null);
  useEffect(() => {
    api<{ decks: DeckRow[] }>("/api/decks").then((r) => setDecks(r.decks));
  }, []);

  return (
    <div className="cq-page">
      <PageHead title="Decks" description="Every deck you co-edit with the agent, newest first.">
        <Button onClick={() => navigate("/new")}>
          <Plus /> New deck
        </Button>
      </PageHead>
      {!decks && <Spinner label="Loading decks" />}
      {decks?.length === 0 && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutGrid />
            </EmptyMedia>
            <EmptyTitle>No deck yet</EmptyTitle>
            <EmptyDescription>Describe the deck you need; the agent builds it on your company's brand pack.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => navigate("/new")}>
              <Plus /> New deck
            </Button>
          </EmptyContent>
        </Empty>
      )}
      {!!decks?.length && (
        <ul className="cq-deck-grid">
          <li>
            <a className="cq-deck-card cq-deck-new" href="/new" onClick={(e) => go(e, "/new")}>
              <Plus />
              <span>Start from a brief</span>
            </a>
          </li>
          {decks.map((d) => (
            <li key={d.id}>
              <a className="cq-deck-card" href={`/d/${d.id}`} onClick={(e) => go(e, `/d/${d.id}`)}>
                <span className="cq-deck-cover">
                  <img src={`/decks/${d.id}/slides/1.png?v=${d.head}`} alt="" loading="lazy" />
                </span>
                <span className="cq-deck-info">
                  <strong>{d.title}</strong>
                  <span>
                    {d.pack_id} · v{d.head} · {ago(d.updated_at)}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
