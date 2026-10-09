import { DeckViewer, type DeckView } from "@calque/slide-ui";
import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "diametral-ds/table";
import { Tag } from "diametral-ds/tag";
import { CircleCheck, Download, History, ListChecks, ListPlus, Play, Sparkles, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { agent, tool } from "../api.ts";
import { Chat, type Ask } from "../components/Chat.tsx";
import { AddSlides, ReviewDeck } from "../components/DeckActions.tsx";
import { navigate } from "../nav.ts";
import { ago, Dialog, Spinner } from "../ui.tsx";

type Deck = DeckView & { versions: { version: number; note: string; author: string; created_at: string }[] };

const EDITS = ["Tighten every title to one line", "Add an agenda slide after the cover", "Review the deck against the brand pack"];

/** The editor: the deck workspace (slide-ui) with the agent chat in its side panel. */
export function Editor({ id }: { id: string }) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [errors, setErrors] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  // toolbar actions that go through the agent chat, and their dialogs
  const [ask, setAsk] = useState<Ask | null>(null);
  const [dialog, setDialog] = useState<"add" | "review" | null>(null);

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
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
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
                <Tag tone="danger">
                  <TriangleAlert /> {errors} lint error{errors > 1 ? "s" : ""}
                </Tag>
              ) : (
                <Tag tone="success">
                  <CircleCheck /> Lint clean
                </Tag>
              ))}
            <Button variant="ghost" onClick={() => setDialog("add")}>
              <ListPlus /> Add slides
            </Button>
            <Button variant="ghost" onClick={() => setDialog("review")}>
              <ListChecks /> Review
            </Button>
            <Button variant="ghost" onClick={() => setHistory(true)}>
              <History /> History
            </Button>
            <Button variant="outline" onClick={() => navigate(`/present/${id}`)}>
              <Play /> Present
            </Button>
            <Button
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
            ask={ask}
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
          <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => setError(null)}>
            <X />
          </Button>
        </div>
      )}
      {dialog === "add" && <AddSlides onClose={() => setDialog(null)} onAsk={setAsk} />}
      {dialog === "review" && (
        <ReviewDeck
          deck_id={id}
          onClose={() => setDialog(null)}
          onAsk={setAsk}
          onApplySafe={() => {
            setDialog(null);
            void run("Applying safe fixes", () => tool("review_deck", { deck_id: id, apply_safe_fixes: true }));
          }}
        />
      )}
      {history && (
        <Dialog title="Version history" wide onClose={() => setHistory(false)}>
          <div className="cq-dialog-body">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Change</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...deck.versions].reverse().map((v) => (
                  <TableRow key={v.version}>
                    <TableCell>
                      <span className="cq-mono">v{v.version}</span>
                    </TableCell>
                    <TableCell>
                      {v.note}
                      <div className="cq-hint">{ago(v.created_at)}</div>
                    </TableCell>
                    <TableCell>{v.author}</TableCell>
                    <TableCell>
                      {v.version === deck.head ? (
                        <Tag>Current</Tag>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Restore v${v.version}`}
                          onClick={() => {
                            setHistory(false);
                            void run("Restoring", () => tool("restore_version", { deck_id: id, version: v.version }));
                          }}
                        >
                          Restore
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Dialog>
      )}
    </>
  );
}
