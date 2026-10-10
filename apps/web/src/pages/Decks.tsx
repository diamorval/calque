import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { DialogFooter } from "diametral-ds/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "diametral-ds/empty";
import { Input } from "diametral-ds/input";
import { Cloud, Copy, FileUp, LayoutGrid, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api, fileArg, tool, type Pack } from "../api.ts";
import { M365Picker, useM365 } from "../components/M365.tsx";
import { t } from "../i18n.ts";
import { go, navigate } from "../nav.ts";
import { ago, Dialog, Field, FileDrop, PageHead, Spinner } from "../ui.tsx";

interface DeckRow {
  id: string;
  title: string;
  pack_id: string;
  head: number;
  updated_at: string;
  owner: string;
  role: "owner" | "editor" | "commenter" | "viewer";
}

const ROLE = { owner: "Owner", editor: "Editor", commenter: "Commenter", viewer: "Viewer" } as const;

interface CardActions {
  onRename?: (() => void) | undefined;
  onDuplicate: () => void;
  onDelete?: (() => void) | undefined;
}

function DeckCard({ d, onRename, onDuplicate, onDelete }: { d: DeckRow } & CardActions) {
  return (
    <li className="cq-deck-item">
      <a className="cq-deck-card" href={`/d/${d.id}`} onClick={(e) => go(e, `/d/${d.id}`)}>
        <span className="cq-deck-cover">
          <img src={`${import.meta.env.BASE_URL}decks/${d.id}/slides/1.png?v=${d.head}`} alt="" loading="lazy" />
        </span>
        <span className="cq-deck-info">
          <strong>{d.title}</strong>
          <span>
            {d.pack_id} · v{d.head} · {ago(d.updated_at)}
          </span>
          {d.role !== "owner" && (
            <span>
              {t(ROLE[d.role])} · {t("from {owner}", { owner: d.owner })}
            </span>
          )}
        </span>
      </a>
      <span className="cq-deck-actions">
        {onRename && (
          <Button size="icon" variant="outline" aria-label={t("Rename {title}", { title: d.title })} title={t("Rename")} onClick={onRename}>
            <Pencil />
          </Button>
        )}
        <Button size="icon" variant="outline" aria-label={t("Duplicate {title}", { title: d.title })} title={t("Duplicate")} onClick={onDuplicate}>
          <Copy />
        </Button>
        {onDelete && (
          <Button size="icon" variant="outline" aria-label={t("Delete {title}", { title: d.title })} title={t("Delete")} onClick={onDelete}>
            <Trash2 />
          </Button>
        )}
      </span>
    </li>
  );
}

export function Decks() {
  const [all, setAll] = useState<DeckRow[] | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [query, setQuery] = useState("");
  const [packId, setPackId] = useState("");
  const [importing, setImporting] = useState(false);
  const [renaming, setRenaming] = useState<DeckRow | null>(null);
  const [deleting, setDeleting] = useState<DeckRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filtered = !!query.trim() || !!packId;
  const load = () => {
    const q = new URLSearchParams();
    if (query.trim()) q.set("q", query.trim());
    if (packId) q.set("pack_id", packId);
    return api<{ decks: DeckRow[] }>(`/api/decks${q.size ? `?${q}` : ""}`).then((r) => setAll(r.decks));
  };
  useEffect(() => {
    // the search runs on the server (titles and slide text): wait for the typing to pause
    const t = setTimeout(() => void load(), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, packId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    tool<{ packs: Pack[] }>("list_packs").then((r) => setPacks(r.packs), () => setPacks([]));
  }, []);

  async function run(label: string, fn: () => Promise<unknown>) {
    setError(null);
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const remove = (d: DeckRow) => {
    setDeleting(null);
    return run(t("Deleting {title}", { title: d.title }), async () => {
      await api(`/api/decks/${encodeURIComponent(d.id)}`, undefined, "DELETE");
      await load();
    });
  };
  const rename = (d: DeckRow, title: string) => {
    setRenaming(null);
    return run(t("Renaming {title}", { title: d.title }), async () => {
      await tool("rename_deck", { deck_id: d.id, title });
      await load();
    });
  };
  // the copy opens in the editor, as a new deck of the caller's
  const duplicate = (d: DeckRow) =>
    run(t("Duplicating {title}", { title: d.title }), async () => navigate(`/d/${(await tool<{ deck_id: string }>("duplicate_deck", { deck_id: d.id })).deck_id}`));
  const actions = (d: DeckRow): CardActions => ({
    onRename: d.role === "owner" || d.role === "editor" ? () => setRenaming(d) : undefined,
    onDuplicate: () => void duplicate(d),
    onDelete: d.role === "owner" ? () => setDeleting(d) : undefined,
  });
  const decks = all && all.filter((d) => d.role === "owner");
  const shared = all?.filter((d) => d.role !== "owner") ?? [];

  return (
    <div className="cq-page">
      <PageHead title={t("Decks")} description={t("Every deck you co-edit with the agent, newest first.")}>
        <Button variant="outline" onClick={() => setImporting(true)}>
          <FileUp /> {t("Import PPTX")}
        </Button>
        <Button onClick={() => navigate("/new")}>
          <Plus /> {t("New deck")}
        </Button>
      </PageHead>
      {(filtered || !!all?.length) && (
        <div className="cq-deck-filters" role="search">
          <span className="cq-deck-search">
            <Search aria-hidden />
            <Input type="search" aria-label={t("Search decks")} placeholder={t("Search by title, client or slide text")} value={query} onChange={(e) => setQuery(e.target.value)} />
          </span>
          <select className="cq-select" aria-label={t("Brand pack filter")} value={packId} onChange={(e) => setPackId(e.target.value)}>
            <option value="">{t("All brand packs")}</option>
            {packs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {busy && <Spinner label={busy} />}
      {!decks && <Spinner label={t("Loading decks")} />}
      {filtered && all?.length === 0 && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search />
            </EmptyMedia>
            <EmptyTitle>{t("No deck matches")}</EmptyTitle>
            <EmptyDescription>{t("Try other words, or another brand pack.")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {!filtered && decks?.length === 0 && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutGrid />
            </EmptyMedia>
            <EmptyTitle>{t("No deck yet")}</EmptyTitle>
            <EmptyDescription>{t("Describe the deck you need; the agent builds it on your company's brand pack.")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => setImporting(true)}>
              <FileUp /> {t("Import PPTX")}
            </Button>
            <Button onClick={() => navigate("/new")}>
              <Plus /> {t("New deck")}
            </Button>
          </EmptyContent>
        </Empty>
      )}
      {!!decks?.length && (
        <ul className="cq-deck-grid">
          {!filtered && (
            <li>
              <a className="cq-deck-card cq-deck-new" href="/new" onClick={(e) => go(e, "/new")}>
                <Plus />
                <span>{t("Start from a brief")}</span>
              </a>
            </li>
          )}
          {decks.map((d) => (
            <DeckCard key={d.id} d={d} {...actions(d)} />
          ))}
        </ul>
      )}
      {shared.length > 0 && (
        <section className="cq-shared" aria-label={t("Shared with me")}>
          <h2>{t("Shared with me")}</h2>
          <ul className="cq-deck-grid">
            {shared.map((d) => (
              <DeckCard key={d.id} d={d} {...actions(d)} />
            ))}
          </ul>
        </section>
      )}
      {importing && <ImportPptx onClose={() => setImporting(false)} />}
      {renaming && <RenameDeck deck={renaming} onClose={() => setRenaming(null)} onRename={(title) => void rename(renaming, title)} />}
      {deleting && (
        <Dialog title={t("Delete {title}?", { title: deleting.title })} onClose={() => setDeleting(null)}>
          <div className="cq-dialog-body">
            <p>{t("Every version, comment and share goes with it, for everyone it is shared with. This cannot be undone.")}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t("Cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void remove(deleting)}>
              <Trash2 /> {t("Delete")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

/** Rename a deck (rename_deck): the name the lists show; empty goes back to its DeckSpec title. */
function RenameDeck({ deck, onClose, onRename }: { deck: DeckRow; onClose: () => void; onRename: (title: string) => void }) {
  const [title, setTitle] = useState(deck.title);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onRename(title);
  };
  return (
    <Dialog title={t("Rename deck")} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="cq-dialog-body">
          <Field label={t("Name")} htmlFor="r-title" hint={t("Shown in the deck lists; the slides do not change. Leave it empty to use the deck's own title.")}>
            <Input id="r-title" autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button type="submit">
            <Pencil /> {t("Rename")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Import an existing .pptx on a brand pack (import_pptx), then open it in the editor. */
function ImportPptx({ onClose }: { onClose: () => void }) {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [pack, setPack] = useState("");
  const [language, setLanguage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  // a file picked in OneDrive or SharePoint, already copied into Calque
  const [cloud, setCloud] = useState<{ file_id: string; name: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const m365 = useM365();
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
      else pick(r.packs.find((p) => p.default));
    });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!(file || cloud) || !pack) return;
    setBusy(true);
    setError(null);
    try {
      const r = await tool<{ deck_id: string }>("import_pptx", { file: cloud ? { file_id: cloud.file_id } : await fileArg(file as File), pack_id: pack, language });
      navigate(`/d/${r.deck_id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog title={t("Import a PPTX")} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="cq-dialog-body">
          <FileDrop
            label={t("PPTX file")}
            accept=".pptx"
            title={cloud ? cloud.name : file ? file.name : t("Drop the .pptx here")}
            hint={t("Calque edits its own copy: your file is never overwritten.")}
            onFiles={(f) => {
              setFile(f[0] ?? null);
              setCloud(null);
            }}
          />
          {m365 && (
            <Button type="button" variant="outline" onClick={() => setPicking(true)}>
              <Cloud /> {t("From Microsoft 365")}
            </Button>
          )}
          <Field label={t("Brand pack")} htmlFor="i-pack" hint={t("Lint and the agent check the deck against this pack.")}>
            <select id="i-pack" className="cq-select" required value={pack} onChange={(e) => pick(packs.find((p) => p.id === e.target.value))}>
              <option value="" disabled>
                {t("Choose a brand pack")}
              </option>
              {packs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("Language")} htmlFor="i-lang" hint={t("The deck's language, for spelling and lint.")}>
            <Input id="i-lang" required minLength={2} value={language} placeholder="en" onChange={(e) => setLanguage(e.target.value)} />
          </Field>
          {busy && <Spinner label={t("Importing: rendering every slide")} />}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button type="submit" disabled={!(file || cloud) || !pack || busy}>
            <FileUp /> {t("Import")}
          </Button>
        </DialogFooter>
      </form>
      {picking && m365 && <M365Picker status={m365} accept={/\.pptx$/i} title={t("Import from Microsoft 365")} onPick={setCloud} onClose={() => setPicking(false)} />}
    </Dialog>
  );
}
