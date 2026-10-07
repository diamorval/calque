import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  PageHeader,
  PageHeaderActions,
  PageHeaderDescription,
  PageHeaderHeading,
  PageHeaderTitle,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@diametral/design-system/react";
import { DeckViewer, type DeckView } from "@calque/slide-ui";
import { useCallback, useEffect, useState } from "react";
import { agent, tool } from "../api.ts";
import { Chat } from "../components/Chat.tsx";
import { navigate } from "../nav.ts";

type Deck = DeckView & { versions: { version: number; note: string; author: string; created_at: string }[] };

/** The editor: rendered deck + inspector + comments (slide-ui) next to the agent chat. */
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

  if (!deck) return error ? <p role="alert">{error}</p> : <Spinner label="Loading deck" />;
  return (
    <>
      <PageHeader>
        <PageHeaderHeading>
          <PageHeaderTitle>{deck.title}</PageHeaderTitle>
          <PageHeaderDescription>
            {deck.pack_id} · v{deck.version}{" "}
            {errors !== null && <Badge variant={errors ? "destructive" : "outline"}>{errors ? `${errors} lint error${errors > 1 ? "s" : ""}` : "Lint clean"}</Badge>}
          </PageHeaderDescription>
        </PageHeaderHeading>
        <PageHeaderActions>
          <Button onClick={() => setHistory(true)}>History</Button>
          <Button onClick={() => navigate(`/present/${id}`)}>Present</Button>
          <Button
            variant="primary"
            onClick={async () => location.assign((await tool<{ download_url: string }>("export_pptx", { deck_id: id })).download_url)}
          >
            Export PPTX
          </Button>
        </PageHeaderActions>
      </PageHeader>
      {busy && <Spinner label={busy} />}
      {error && <p role="alert">{error}</p>}
      <div className="cq-editor">
        <DeckViewer
          deck={deck}
          onComment={async (c) => {
            await tool("add_comment", { deck_id: id, ...c });
            await reload();
          }}
          onApply={() => run("Applying comments", () => agent("/api/agent/apply-comments", { deck_id: id }, () => {}))}
        />
        <Chat storageKey={`chat:${id}`} deck_id={id} pack_id={deck.pack_id} placeholder="Ask for a change: reword, add a slide, review…" onDone={() => void reload()} />
      </div>
      <Dialog open={history} onOpenChange={setHistory}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Version history</DialogTitle>
          </DialogHeader>
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
                  <TableCell>v{v.version}</TableCell>
                  <TableCell>{v.note}</TableCell>
                  <TableCell>{v.author}</TableCell>
                  <TableCell>
                    {v.version === deck.head ? (
                      <Badge variant="outline">Current</Badge>
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>
    </>
  );
}
