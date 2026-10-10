// The pack's slide library in the editor: approved slides (case studies, references, team bios,
// boilerplate) to browse and insert (library_list, library_insert), proposals for the pack's
// managers to approve (library_review), and "Add to library" on the slide shown (library_add).
// Below it, the pack's approved images (image_library_*): upload one, approve, place it through the
// agent (its `file:` ref in a picture slot).
import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { DialogFooter } from "diametral-ds/dialog";
import { Input } from "diametral-ds/input";
import { Tag } from "diametral-ds/tag";
import { BookMarked, Check, ImagePlus, Images, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { tool, upload } from "../api.ts";
import type { Ask } from "./Chat.tsx";
import { Dialog, Field, Spinner } from "../ui.tsx";

export interface LibraryEntry {
  entry_id: string;
  title: string;
  tags: string[];
  status: "pending" | "approved";
  added_by: string;
  thumbnail_url: string;
}

/** The thumbnail on this origin (the server gives absolute URLs; the dev server proxies paths). */
const local = (url: string) => {
  const u = new URL(url, location.href);
  return `${u.pathname}${u.search}`;
};

export function LibraryPanel(props: {
  pack_id: string;
  deck_id: string;
  canEdit: boolean;
  manages: boolean;
  me: string | null;
  onInserted: () => void;
  onAsk?: ((a: Ask) => void) | undefined;
}) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    (q = "") =>
      tool<{ entries: LibraryEntry[] }>("library_list", { pack_id: props.pack_id, status: "all", ...(q ? { query: q } : {}) }).then(
        (r) => setEntries(r.entries),
        (e: Error) => setError(e.message),
      ),
    [props.pack_id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (label: string, fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await load(query.trim());
      after?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const search = (e: FormEvent) => {
    e.preventDefault();
    void load(query.trim());
  };
  const pending = entries?.filter((e) => e.status === "pending") ?? [];
  const approved = entries?.filter((e) => e.status === "approved") ?? [];

  const card = (e: LibraryEntry) => (
    <li key={e.entry_id} className="cq-lib-item">
      <img src={local(e.thumbnail_url)} alt="" loading="lazy" />
      <div>
        <strong>{e.title}</strong>
        {e.tags.length > 0 && (
          <span className="cq-lib-tags">
            {e.tags.map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
          </span>
        )}
        <span className="cq-lib-actions">
          {e.status === "approved" && props.canEdit && (
            <Button size="sm" variant="outline" disabled={!!busy} aria-label={`Insert ${e.title}`} onClick={() => void act("Inserting", () => tool("library_insert", { entry_id: e.entry_id, deck_id: props.deck_id }), props.onInserted)}>
              <Plus /> Insert
            </Button>
          )}
          {e.status === "pending" && props.manages && (
            <Button size="sm" variant="outline" disabled={!!busy} aria-label={`Approve ${e.title}`} onClick={() => void act("Approving", () => tool("library_review", { entry_id: e.entry_id, action: "approve" }))}>
              <Check /> Approve
            </Button>
          )}
          {(props.manages || (e.status === "pending" && e.added_by === props.me)) && (
            <Button size="icon-sm" variant="ghost" disabled={!!busy} aria-label={`Remove ${e.title}`} onClick={() => void act("Removing", () => tool("library_review", { entry_id: e.entry_id, action: "remove" }))}>
              <Trash2 />
            </Button>
          )}
        </span>
      </div>
    </li>
  );

  return (
    <section className="cq-lib" aria-label="Slide library">
      <form className="cq-m365-search" onSubmit={search}>
        <Input aria-label="Search the library" value={query} placeholder="Case study, sector, team…" onChange={(e) => setQuery(e.target.value)} />
        <Button type="submit" size="icon" variant="outline" aria-label="Search the library">
          <Search />
        </Button>
      </form>
      {busy && <Spinner label={busy} />}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!entries && !error && <Spinner label="Loading the library" />}
      {entries && approved.length === 0 && (
        <div className="cq-empty">
          <BookMarked />
          <strong>{query ? "No approved slide matches" : "No approved slide yet"}</strong>
          <span>Add a slide that proves a point (a case study, a reference, a team bio) with “Add to library” above the slide.</span>
        </div>
      )}
      {approved.length > 0 && <ul className="cq-lib-list">{approved.map(card)}</ul>}
      {pending.length > 0 && (
        <>
          <h3 className="cq-lib-head">{props.manages ? "To approve" : "Waiting for approval"}</h3>
          <ul className="cq-lib-list">{pending.map(card)}</ul>
        </>
      )}
      <ImageLibrary pack_id={props.pack_id} manages={props.manages} me={props.me} onAsk={props.canEdit ? props.onAsk : undefined} />
    </section>
  );
}

export interface LibraryImage {
  image_id: string;
  title: string;
  tags: string[];
  status: "pending" | "approved";
  added_by: string;
  ref: string;
  image_url: string;
}

/** The pack's image library: search, upload (approved at once for managers), review, place. */
function ImageLibrary(props: { pack_id: string; manages: boolean; me: string | null; onAsk?: ((a: Ask) => void) | undefined }) {
  const [images, setImages] = useState<LibraryImage[] | null>(null);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    (q = "") =>
      tool<{ images: LibraryImage[] }>("image_library_list", { pack_id: props.pack_id, status: "all", ...(q ? { query: q } : {}) }).then(
        (r) => setImages(r.images),
        (e: Error) => setError(e.message),
      ),
    [props.pack_id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await load(query.trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const search = (e: FormEvent) => {
    e.preventDefault();
    void load(query.trim());
  };
  function add(e: FormEvent) {
    e.preventDefault();
    const f = file.current?.files?.[0];
    if (!f || !title.trim()) return;
    void act("Uploading", async () => {
      const form = new FormData();
      form.append("file", f);
      const { file_id } = await upload<{ file_id: string }>("/api/files", form);
      const list = tags.split(",").map((t) => t.trim()).filter(Boolean);
      await tool("image_library_add", { pack_id: props.pack_id, file_id, title: title.trim(), ...(list.length ? { tags: list } : {}) });
      setTitle("");
      setTags("");
      setAdding(false);
    });
  }
  const pending = images?.filter((i) => i.status === "pending") ?? [];
  const approved = images?.filter((i) => i.status === "approved") ?? [];

  const card = (i: LibraryImage) => (
    <li key={i.image_id} className="cq-lib-item">
      <img src={local(i.image_url)} alt={i.title} loading="lazy" />
      <div>
        <strong>{i.title}</strong>
        {i.tags.length > 0 && (
          <span className="cq-lib-tags">
            {i.tags.map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
          </span>
        )}
        <span className="cq-lib-actions">
          {i.status === "approved" && props.onAsk && (
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy}
              aria-label={`Place ${i.title}`}
              onClick={() => props.onAsk?.({ text: `Place the library image "${i.title}" (${i.ref}) in the picture slot where it fits best, on the slide shown or the one it suits.` })}
            >
              <Sparkles /> Place
            </Button>
          )}
          {i.status === "pending" && props.manages && (
            <Button size="sm" variant="outline" disabled={!!busy} aria-label={`Approve ${i.title}`} onClick={() => void act("Approving", () => tool("image_library_review", { image_id: i.image_id, action: "approve" }))}>
              <Check /> Approve
            </Button>
          )}
          {(props.manages || (i.status === "pending" && i.added_by === props.me)) && (
            <Button size="icon-sm" variant="ghost" disabled={!!busy} aria-label={`Remove ${i.title}`} onClick={() => void act("Removing", () => tool("image_library_review", { image_id: i.image_id, action: "remove" }))}>
              <Trash2 />
            </Button>
          )}
        </span>
      </div>
    </li>
  );

  return (
    <section aria-label="Image library">
      <h3 className="cq-lib-head">Images</h3>
      <form className="cq-m365-search" onSubmit={search}>
        <Input aria-label="Search the images" value={query} placeholder="Office, team, client logo…" onChange={(e) => setQuery(e.target.value)} />
        <Button type="submit" size="icon" variant="outline" aria-label="Search the images">
          <Search />
        </Button>
      </form>
      {busy && <Spinner label={busy} />}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!images && !error && <Spinner label="Loading the images" />}
      {images && approved.length === 0 && (
        <div className="cq-empty">
          <Images />
          <strong>{query ? "No approved image matches" : "No approved image yet"}</strong>
          <span>Add the photos and logos people may use on this brand pack.</span>
        </div>
      )}
      {approved.length > 0 && <ul className="cq-lib-list">{approved.map(card)}</ul>}
      {pending.length > 0 && (
        <>
          <h3 className="cq-lib-head">{props.manages ? "Images to approve" : "Images waiting for approval"}</h3>
          <ul className="cq-lib-list">{pending.map(card)}</ul>
        </>
      )}
      {adding ? (
        <form onSubmit={add}>
          <Field label="Image" htmlFor="li-file">
            <input id="li-file" ref={file} type="file" required accept="image/png,image/jpeg,image/gif,image/bmp,image/tiff,image/webp,image/svg+xml" />
          </Field>
          <Field label="Title" htmlFor="li-title">
            <Input id="li-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Paris office, lobby" />
          </Field>
          <Field label="Tags" htmlFor="li-tags" hint="Comma-separated: what it shows, the sector, the offer.">
            <Input id="li-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="photo, office, team" />
          </Field>
          <p className="cq-hint">{props.manages ? "You manage this brand pack: the image is approved at once." : "The brand pack's owner or an admin approves it before others can use it."} Only add images you have the rights to.</p>
          <span className="cq-lib-actions">
            <Button type="submit" size="sm" disabled={!!busy || !title.trim()}>
              <ImagePlus /> Add image
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </span>
        </form>
      ) : (
        props.me && (
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
            <ImagePlus /> Add an image
          </Button>
        )
      )}
    </section>
  );
}

/** Propose the slide shown for the pack's library (approved at once for its managers). */
export function AddToLibrary(props: { deck_id: string; slide_id: string; number: number; manages: boolean; onClose: () => void; onAdded: () => void }) {
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<LibraryEntry | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const list = tags.split(",").map((t) => t.trim()).filter(Boolean);
      setDone(await tool<LibraryEntry>("library_add", { deck_id: props.deck_id, slide_id: props.slide_id, title: title.trim(), ...(list.length ? { tags: list } : {}) }));
      props.onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={`Add slide ${props.number} to the library`} onClose={props.onClose}>
      {done ? (
        <>
          <div className="cq-dialog-body">
            <p>{done.status === "approved" ? "Added: everyone on this brand pack can now insert it." : "Sent for approval: the brand pack's owner or an admin reviews it."}</p>
          </div>
          <DialogFooter>
            <Button onClick={props.onClose}>Close</Button>
          </DialogFooter>
        </>
      ) : (
        <form onSubmit={submit}>
          <div className="cq-dialog-body">
            <p className="cq-hint">
              {props.manages ? "You manage this brand pack: the slide is approved at once." : "The brand pack's owner or an admin approves it before others can use it."} The library keeps a copy: later edits to
              this deck do not change it.
            </p>
            <Field label="Title" htmlFor="l-title">
              <Input id="l-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Retail case study: stock-outs down 30%" />
            </Field>
            <Field label="Tags" htmlFor="l-tags" hint="Comma-separated: what it is, the sector, the offer.">
              <Input id="l-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="case-study, retail, supply chain" />
            </Field>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !title.trim()}>
              <BookMarked /> Add to library
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}
