// Microsoft 365 in and out: pick a OneDrive or SharePoint file into Calque (m365_import, a file_id
// like an upload), save a deck to a OneDrive or SharePoint folder (m365_save), post its link in a
// Teams channel or chat (m365_teams, m365_share_teams). Each user connects their own account once;
// the server keeps the connection.
import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button, buttonVariants } from "diametral-ds/button";
import { DialogFooter } from "diametral-ds/dialog";
import { Input } from "diametral-ds/input";
import { Textarea } from "diametral-ds/textarea";
import { ChevronRight, Cloud, ExternalLink, File as FileIcon, Folder, Globe, HardDrive, MessageSquareShare, Search } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api, tool } from "../api.ts";
import { t, tn } from "../i18n.ts";
import { Dialog, Field, Spinner } from "../ui.tsx";

export interface M365Status {
  configured: boolean;
  connected: boolean;
  account: string | null;
}

/** The viewer's Microsoft 365 connection; null while loading or when the server has none set up. */
export function useM365(): M365Status | null {
  const [status, setStatus] = useState<M365Status | null>(null);
  useEffect(() => {
    api<M365Status>("/api/m365").then(
      (s) => setStatus(s.configured ? s : null),
      () => setStatus(null),
    );
  }, []);
  return status;
}

/** Connect, then come back to this page. */
const connectHref = () => `/auth/m365/connect?return=${encodeURIComponent(location.pathname + location.search)}`;

function Connect() {
  return (
    <div className="cq-m365-connect">
      <p>{t("Connect your Microsoft 365 account to open files from OneDrive and SharePoint, and save decks there. Calque only reaches what you can open.")}</p>
      <a className={buttonVariants()} href={connectHref()}>
        <Cloud /> {t("Connect Microsoft 365")}
      </a>
    </div>
  );
}

interface Item {
  drive_id: string | null;
  item_id: string;
  name: string;
  folder: boolean;
  web_url: string | null;
}
/** Where the browser is: a drive's folder (the trail of folders to it), a site search, or a site's libraries. */
type Place =
  | { kind: "drive"; drive_id?: string | undefined; label: string; trail: { id: string; name: string }[]; search?: string | undefined }
  | { kind: "sites"; query: string }
  | { kind: "site"; site_id: string; name: string };
const ONEDRIVE: Place = { kind: "drive", label: "OneDrive", trail: [] };

type Row = { key: string; name: string; icon: "folder" | "file" | "site" | "drive"; open: () => void; item?: Item };

/** Browse OneDrive and SharePoint. `pick`: files to pick (by name), or folders only (to save into). */
function Browser(props: { files?: RegExp; onPlace?: (p: Place) => void; onFile?: (i: Item) => void; busy?: boolean }) {
  const [place, setPlace] = useState<Place>(ONEDRIVE);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const go = (p: Place) => {
    setPlace(p);
    props.onPlace?.(p);
  };

  useEffect(() => {
    setRows(null);
    setError(null);
    const args: Record<string, unknown> =
      place.kind === "sites"
        ? { sites: place.query }
        : place.kind === "site"
          ? { site_id: place.site_id }
          : { ...(place.drive_id ? { drive_id: place.drive_id } : {}), ...(place.search ? { search: place.search } : place.trail.length ? { folder_id: place.trail.at(-1)?.id } : {}) };
    tool<{ items?: Item[]; sites?: { site_id: string; name: string }[]; drives?: { drive_id: string; name: string }[] }>("m365_list", args).then(
      (r) => {
        if (r.sites) return setRows(r.sites.map((s) => ({ key: s.site_id, name: s.name, icon: "site", open: () => go({ kind: "site", site_id: s.site_id, name: s.name }) })));
        if (r.drives && place.kind === "site")
          return setRows(r.drives.map((d) => ({ key: d.drive_id, name: d.name, icon: "drive", open: () => go({ kind: "drive", drive_id: d.drive_id, label: `${place.name} › ${d.name}`, trail: [] }) })));
        const items = (r.items ?? []).filter((i) => i.folder || props.files?.test(i.name));
        setRows(
          items.map((i) => ({
            key: i.item_id,
            name: i.name,
            icon: i.folder ? "folder" : "file",
            item: i,
            open: () =>
              i.folder && place.kind === "drive"
                ? go({ ...place, drive_id: i.drive_id ?? place.drive_id, trail: [...(place.search ? [] : place.trail), { id: i.item_id, name: i.name }], search: undefined })
                : props.onFile?.(i),
          })),
        );
      },
      (e: Error) => setError(e.message),
    );
  }, [place]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = (e: FormEvent) => {
    e.preventDefault();
    go(place.kind === "drive" ? { ...place, trail: [], search: query.trim() || undefined } : { kind: "sites", query: query.trim() });
  };
  const ICON = { folder: <Folder />, file: <FileIcon />, site: <Globe />, drive: <HardDrive /> };
  return (
    <div className="cq-m365">
      <div className="cq-m365-places">
        <Button size="sm" variant={place.kind === "drive" && !place.drive_id ? "default" : "outline"} onClick={() => go(ONEDRIVE)}>
          <HardDrive /> OneDrive
        </Button>
        <Button size="sm" variant={place.kind !== "drive" || place.drive_id ? "default" : "outline"} onClick={() => go({ kind: "sites", query: "" })}>
          <Globe /> {t("SharePoint sites")}
        </Button>
      </div>
      <form className="cq-m365-search" onSubmit={search}>
        <Input aria-label={t("Search")} value={query} placeholder={place.kind === "drive" ? t("Search this drive") : t("Find a site by name")} onChange={(e) => setQuery(e.target.value)} />
        <Button type="submit" size="icon" variant="outline" aria-label={t("Search")}>
          <Search />
        </Button>
      </form>
      {place.kind === "drive" && (
        <nav className="cq-m365-trail" aria-label={t("Folder")}>
          <button type="button" onClick={() => go({ ...place, trail: [], search: undefined })}>
            {place.label}
          </button>
          {place.search && (
            <span>
              <ChevronRight /> “{place.search}”
            </span>
          )}
          {place.trail.map((f, i) => (
            <span key={f.id}>
              <ChevronRight />
              <button type="button" onClick={() => go({ ...place, trail: place.trail.slice(0, i + 1) })}>
                {f.name}
              </button>
            </span>
          ))}
        </nav>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!rows && !error && <Spinner label={t("Loading")} />}
      {rows && (
        <ul className="cq-m365-list">
          {rows.length === 0 && <li className="cq-muted">{place.kind === "sites" ? t("No site found.") : t("Nothing here.")}</li>}
          {rows.map((r) => (
            <li key={r.key}>
              <button type="button" disabled={props.busy || (r.icon === "file" && !props.onFile)} onClick={r.open}>
                {ICON[r.icon]} <span>{r.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Pick a OneDrive or SharePoint file (names matching `accept`); it comes in as a file_id. */
export function M365Picker(props: { status: M365Status; accept: RegExp; title?: string; onPick: (f: { file_id: string; name: string }) => void; onClose: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function pick(i: Item) {
    setBusy(i.name);
    setError(null);
    try {
      const f = await tool<{ file_id: string; name: string }>("m365_import", { item_id: i.item_id, ...(i.drive_id ? { drive_id: i.drive_id } : {}) });
      props.onPick(f);
      props.onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }
  return (
    <Dialog title={props.title ?? t("From Microsoft 365")} wide onClose={props.onClose}>
      <div className="cq-dialog-body">
        {props.status.connected ? (
          <>
            <Browser files={props.accept} onFile={(i) => void pick(i)} busy={!!busy} />
            {busy && <Spinner label={t("Copying {name}", { name: busy })} />}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {props.status.account && <p className="cq-hint">{t("Signed in as {name}", { name: props.status.account })}</p>}
          </>
        ) : (
          <Connect />
        )}
      </div>
    </Dialog>
  );
}

/** Save the deck as PPTX or PDF into a OneDrive or SharePoint folder; lint ERRORs ask why, as Export does. */
export function SaveToM365(props: { status: M365Status; deck_id: string; errors: number; onClose: () => void; onShareTeams?: (file_url: string) => void }) {
  const [place, setPlace] = useState<Place>(ONEDRIVE);
  const [format, setFormat] = useState<"pptx" | "pdf">("pptx");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ name: string; web_url: string | null } | null>(null);
  const gate = format === "pptx" && props.errors > 0;
  const folder = place.kind === "drive" ? place : null;
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!folder || (gate && !reason.trim())) return;
    setBusy(true);
    setError(null);
    try {
      const at = folder.trail.at(-1);
      setSaved(
        await tool<{ name: string; web_url: string | null }>("m365_save", {
          deck_id: props.deck_id,
          format,
          ...(folder.drive_id ? { drive_id: folder.drive_id } : {}),
          ...(at ? { folder_id: at.id } : {}),
          ...(gate ? { reason: reason.trim() } : {}),
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!props.status.connected)
    return (
      <Dialog title={t("Save to SharePoint")} onClose={props.onClose}>
        <div className="cq-dialog-body">
          <Connect />
        </div>
      </Dialog>
    );
  return (
    <Dialog title={t("Save to SharePoint")} wide onClose={props.onClose}>
      {saved ? (
        <>
          <div className="cq-dialog-body">
            <p>
              {t("Saved as")} <strong>{saved.name}</strong>.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={props.onClose}>
              {t("Close")}
            </Button>
            {saved.web_url && props.onShareTeams && (
              <Button variant="outline" onClick={() => props.onShareTeams?.(saved.web_url as string)}>
                <MessageSquareShare /> Share to Teams
              </Button>
            )}
            {saved.web_url && (
              <a className={buttonVariants()} href={saved.web_url} target="_blank" rel="noreferrer">
                <ExternalLink /> {t("Open")}
              </a>
            )}
          </DialogFooter>
        </>
      ) : (
        <form onSubmit={save}>
          <div className="cq-dialog-body">
            <Browser onPlace={setPlace} />
            <p className="cq-hint">
              {t("Saves into {place}.", { place: folder ? [folder.label, ...folder.trail.map((f) => f.name)].join(" › ") : t("a document library: open one") })}{" "}
              {t("A name already taken gets a new one: nothing is overwritten.")}
            </p>
            <Field label={t("Format")} htmlFor="m-format">
              <select id="m-format" className="cq-select" value={format} onChange={(e) => setFormat(e.target.value as "pptx" | "pdf")}>
                <option value="pptx">PowerPoint (.pptx)</option>
                <option value="pdf">PDF</option>
              </select>
            </Field>
            {gate && (
              <Field label={tn(props.errors, "This version has {n} lint error: why does it go out anyway?", "This version has {n} lint errors: why does it go out anyway?")} htmlFor="m-reason">
                <Textarea id="m-reason" rows={2} required value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
            )}
            {busy && <Spinner label={t("Saving")} />}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={props.onClose}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={busy || !folder || (gate && !reason.trim())}>
              <Cloud /> {t("Save here")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}

type Option = { id: string; name: string };

/** Post the deck's link (and the saved file's, `file_url`) in a Teams channel or chat, as the user. */
export function ShareToTeams(props: { status: M365Status; deck_id: string; file_url?: string | undefined; onClose: () => void }) {
  const [kind, setKind] = useState<"channel" | "chat">("channel");
  const [teams, setTeams] = useState<Option[] | null>(null);
  const [team, setTeam] = useState("");
  const [channels, setChannels] = useState<Option[] | null>(null);
  const [channel, setChannel] = useState("");
  const [chats, setChats] = useState<Option[] | null>(null);
  const [chat, setChat] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState<{ web_url: string | null; note?: string } | null>(null);
  const fail = (e: Error) => setError(e.message);

  useEffect(() => {
    if (!props.status.connected) return;
    if (kind === "channel" && !teams)
      tool<{ teams: { team_id: string; name: string }[] }>("m365_teams").then((r) => setTeams(r.teams.map((t) => ({ id: t.team_id, name: t.name }))), fail);
    if (kind === "chat" && !chats)
      tool<{ chats: { chat_id: string; name: string }[] }>("m365_teams", { chats: true }).then((r) => setChats(r.chats.map((c) => ({ id: c.chat_id, name: c.name }))), fail);
  }, [kind, props.status.connected]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setChannels(null);
    setChannel("");
    if (team)
      tool<{ channels: { channel_id: string; name: string }[] }>("m365_teams", { team_id: team }).then((r) => setChannels(r.channels.map((c) => ({ id: c.channel_id, name: c.name }))), fail);
  }, [team]);

  const ready = kind === "chat" ? !!chat : !!team && !!channel;
  async function post(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      setPosted(
        await tool<{ web_url: string | null; note?: string }>("m365_share_teams", {
          deck_id: props.deck_id,
          ...(kind === "chat" ? { chat_id: chat } : { team_id: team, channel_id: channel }),
          ...(message.trim() ? { message: message.trim() } : {}),
          ...(props.file_url ? { file_url: props.file_url } : {}),
        }),
      );
    } catch (err) {
      fail(err as Error);
    } finally {
      setBusy(false);
    }
  }
  const pick = (id: string, label: string, options: Option[] | null, value: string, set: (v: string) => void) => (
    <Field label={label} htmlFor={id}>
      {options ? (
        <select id={id} className="cq-select" value={value} onChange={(e) => set(e.target.value)}>
          <option value="" disabled>
            {options.length ? "Choose…" : "None found"}
          </option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      ) : (
        <Spinner label="Loading" />
      )}
    </Field>
  );

  if (!props.status.connected)
    return (
      <Dialog title="Share to Teams" onClose={props.onClose}>
        <div className="cq-dialog-body">
          <Connect />
        </div>
      </Dialog>
    );
  return (
    <Dialog title="Share to Teams" onClose={props.onClose}>
      {posted ? (
        <>
          <div className="cq-dialog-body">
            <p>Posted.</p>
            {posted.note && <p className="cq-hint">Only the people with access to the deck can open its link: share it with them first.</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={props.onClose}>
              Close
            </Button>
            {posted.web_url && (
              <a className={buttonVariants()} href={posted.web_url} target="_blank" rel="noreferrer">
                <ExternalLink /> Open in Teams
              </a>
            )}
          </DialogFooter>
        </>
      ) : (
        <form onSubmit={post}>
          <div className="cq-dialog-body">
            <div className="cq-m365-places">
              <Button type="button" size="sm" variant={kind === "channel" ? "default" : "outline"} onClick={() => setKind("channel")}>
                Channel
              </Button>
              <Button type="button" size="sm" variant={kind === "chat" ? "default" : "outline"} onClick={() => setKind("chat")}>
                Chat
              </Button>
            </div>
            {kind === "channel" ? (
              <>
                {pick("t-team", "Team", teams, team, setTeam)}
                {team && pick("t-channel", "Channel", channels, channel, setChannel)}
              </>
            ) : (
              pick("t-chat", "Chat", chats, chat, setChat)
            )}
            <Field label="Message" htmlFor="t-message">
              <Textarea id="t-message" rows={3} maxLength={4000} value={message} placeholder="Here is the deck for Thursday's review." onChange={(e) => setMessage(e.target.value)} />
            </Field>
            <p className="cq-hint">The message carries the deck's link{props.file_url ? " and the saved file's" : ""}, posted as you.</p>
            {busy && <Spinner label="Posting" />}
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
            <Button type="submit" disabled={busy || !ready}>
              <MessageSquareShare /> Post
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}
