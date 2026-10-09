import { DeckViewer, type DeckView } from "@calque/slide-ui";
import { CircleCheck, Download, History, Play, Sparkles, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { agent, tool } from "../api.ts";
import { Chat } from "../components/Chat.tsx";
import { navigate } from "../nav.ts";
import { ago, Badge, Button, Dialog, Spinner } from "../ui.tsx";

type Deck = DeckView & { versions: { version: number; note: string; author: string; created_at: string }[] };

const EDITS = ["Tighten every title to one line", "Add an agenda slide after the cover", "Review the deck against the brand pack"];

/** The editor: the deck workspace (slide-ui) with the agent chat in its side panel. */
export function Editor({ id }: { id: string }) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [errors, setErrors] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [history, setHistory] = useState(false);

  const reload = useCallback(async () => {
    try {
      setDeck(await tool<Deck>("open_deck", { deck_id: id }));
      setErrors((await tool<{ errors: number }>("lint_deck", { deck_id: id })).errors);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!deck)
    return (
      <div className="cq-center">
        {error ? (
          <p className="cq-alert" data-tone="danger" role="alert">
            {error}
          </p>
        ) : (
          <Spinner label="Loading deck" />
        )}
      </div>
    );
  return (
    <>
      <DeckViewer
        deck={deck}
        working={busy}
        actions={
          <>
            {errors !== null &&
              (errors ? (
                <Badge tone="danger">
                  <TriangleAlert /> {errors} lint error{errors > 1 ? "s" : ""}
                </Badge>
              ) : (
                <Badge tone="ok">
                  <CircleCheck /> Lint clean
                </Badge>
              ))}
            <Button variant="ghost" onClick={() => setHistory(true)}>
              <History /> History
            </Button>
            <Button onClick={() => navigate(`/present/${id}`)}>
              <Play /> Present
            </Button>
            <Button
              variant="primary"
              onClick={async () => location.assign((await tool<{ download_url: string }>("export_pptx", { deck_id: id })).download_url)}
            >
              <Download /> Export PPTX
            </Button>
          </>
        }
        agent={
          <Chat
            storageKey={`chat:${id}`}
            deck_id={id}
            pack_id={deck.pack_id}
            placeholder="Ask for a change: reword, add a slide, review…"
            suggestions={EDITS}
            empty={
              <div className="cq-empty">
                <Sparkles />
                <strong>Edit with the agent</strong>
                <span>Ask for a change in your words. Comments on the slides go through the agent too.</span>
              </div>
            }
            onDone={() => void reload()}
          />
        }
        onComment={async (c) => {
          await tool("add_comment", { deck_id: id, ...c });
          await reload();
        }}
        onApply={() => run("Applying comments", () => agent("/api/agent/apply-comments", { deck_id: id }, () => {}))}
      />
      {error && (
        <div className="cq-toast" role="alert">
          <TriangleAlert /> <span>{error}</span>
          <Button variant="ghost" size="sm" icon aria-label="Dismiss" onClick={() => setError(null)}>
            <X />
          </Button>
        </div>
      )}
      {history && (
        <Dialog title="Version history" wide onClose={() => setHistory(false)}>
          <div className="cq-dialog-body">
            <table className="cq-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Change</th>
                  <th>By</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...deck.versions].reverse().map((v) => (
                  <tr key={v.version}>
                    <td>
                      <span className="cq-mono">v{v.version}</span>
                    </td>
                    <td>
                      {v.note}
                      <div className="cq-hint">{ago(v.created_at)}</div>
                    </td>
                    <td>{v.author}</td>
                    <td>
                      {v.version === deck.head ? (
                        <Badge tone="accent">Current</Badge>
                      ) : (
                        <Button
                          size="sm"
                          aria-label={`Restore v${v.version}`}
                          onClick={() => {
                            setHistory(false);
                            void run("Restoring", () => tool("restore_version", { deck_id: id, version: v.version }));
                          }}
                        >
                          Restore
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Dialog>
      )}
    </>
  );
}
