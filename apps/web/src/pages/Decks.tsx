import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { DialogFooter } from "diametral-ds/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "diametral-ds/empty";
import { Input } from "diametral-ds/input";
import { FileUp, LayoutGrid, Plus } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api, fileArg, tool, type Pack } from "../api.ts";
import { go, navigate } from "../nav.ts";
import { ago, Dialog, Field, FileDrop, PageHead, Spinner } from "../ui.tsx";

interface DeckRow {
  id: string;
  title: string;
  pack_id: string;
  head: number;
  updated_at: string;
}

export function Decks() {
  const [decks, setDecks] = useState<DeckRow[] | null>(null);
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    api<{ decks: DeckRow[] }>("/api/decks").then((r) => setDecks(r.decks));
  }, []);

  return (
    <div className="cq-page">
      <PageHead title="Decks" description="Every deck you co-edit with the agent, newest first.">
        <Button variant="outline" onClick={() => setImporting(true)}>
          <FileUp /> Import PPTX
        </Button>
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
            <Button variant="outline" onClick={() => setImporting(true)}>
              <FileUp /> Import PPTX
            </Button>
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
                  <img src={`${import.meta.env.BASE_URL}decks/${d.id}/slides/1.png?v=${d.head}`} alt="" loading="lazy" />
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
      {importing && <ImportPptx onClose={() => setImporting(false)} />}
    </div>
  );
}

/** Import an existing .pptx on a brand pack (import_pptx), then open it in the editor. */
function ImportPptx({ onClose }: { onClose: () => void }) {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [pack, setPack] = useState("");
  const [language, setLanguage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = (p?: Pack) => {
    setPack(p?.id ?? "");
    setLanguage(p?.default_language ?? p?.languages[0] ?? "");
  };
  useEffect(() => {
    tool<{ packs: Pack[] }>("list_packs").then((r) => {
      setPacks(r.packs);
      if (r.packs.length === 1) pick(r.packs[0]);
    });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file || !pack) return;
    setBusy(true);
    setError(null);
    try {
      const r = await tool<{ deck_id: string }>("import_pptx", { file: await fileArg(file), pack_id: pack, language });
      navigate(`/d/${r.deck_id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog title="Import a PPTX" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="cq-dialog-body">
          <FileDrop
            label="PPTX file"
            accept=".pptx"
            title={file ? file.name : "Drop the .pptx here"}
            hint="Calque edits its own copy: your file is never overwritten."
            onFiles={(f) => setFile(f[0] ?? null)}
          />
          <Field label="Brand pack" htmlFor="i-pack" hint="Lint and the agent check the deck against this pack.">
            <select id="i-pack" className="cq-select" required value={pack} onChange={(e) => pick(packs.find((p) => p.id === e.target.value))}>
              <option value="" disabled>
                Choose a brand pack
              </option>
              {packs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Language" htmlFor="i-lang" hint="The deck's language, for spelling and lint.">
            <Input id="i-lang" required minLength={2} value={language} placeholder="en" onChange={(e) => setLanguage(e.target.value)} />
          </Field>
          {busy && <Spinner label="Importing: rendering every slide" />}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!file || !pack || busy}>
            <FileUp /> Import
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
