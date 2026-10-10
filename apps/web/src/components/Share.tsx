// The editor's Share dialog (deck owner only), artifact style: the people and teams with access
// (share_deck / unshare_deck), and the deck's one share link with its general access, who else it
// opens for (set_general_access), copied as is or reset (reset_link). People and the workspace
// see a shared deck only if they see its brand pack.
import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { DialogFooter } from "diametral-ds/dialog";
import { Input } from "diametral-ds/input";
import { Table, TableBody, TableCell, TableRow } from "diametral-ds/table";
import { Tag } from "diametral-ds/tag";
import { Building2, Copy, Globe, Lock, RotateCcw, Trash2, User, UserPlus, Users } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { tool } from "../api.ts";
import { t } from "../i18n.ts";
import { Dialog, Field, Spinner } from "../ui.tsx";

type Type = "user" | "team";
type Access = "private" | "workspace" | "anyone";
type GeneralRole = "viewer" | "commenter";
interface Person {
  principal_type: Type;
  principal: string;
  role: string;
}
interface Sharing {
  owner: string;
  people: Person[];
  general: { access: Access; role: GeneralRole };
  url: string;
}

const ROLES = [
  ["viewer", "Viewer"],
  ["commenter", "Commenter"],
  ["editor", "Editor"],
] as const;
const ACCESS = { private: [Lock, "Private"], workspace: [Building2, "Workspace"], anyone: [Globe, "Anyone with the link"] } as const;

/** Who the link opens for, in one line. */
function hint({ access, role }: Sharing["general"]): string {
  if (access === "private") return t("Only you and the people with access can open the link.");
  if (access === "workspace")
    return role === "viewer"
      ? t("Anyone signed in to the workspace who has the link and sees the deck's brand pack can view.")
      : t("Anyone signed in to the workspace who has the link and sees the deck's brand pack can comment.");
  return role === "viewer" ? t("Anyone who has the link can view, no sign-in needed.") : t("Anyone who has the link can comment, no sign-in needed.");
}

export function ShareDeck({ deck_id, onClose }: { deck_id: string; onClose: () => void }) {
  const [data, setData] = useState<Sharing | null>(null);
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<Type>("user");
  const [principal, setPrincipal] = useState("");
  const [role, setRole] = useState("viewer");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => setData(await tool<Sharing>("list_shares", { deck_id })), [deck_id]);
  useEffect(() => {
    reload().catch((e: Error) => setError(e.message));
  }, [reload]);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    setNote(null);
    try {
      await fn();
      await reload();
      if (done) setNote(done);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const target = (p: Person) => ({ deck_id, principal_type: p.principal_type, principal: p.principal });
  const general = (g: Partial<Sharing["general"]>) => data && act(() => tool("set_general_access", { deck_id, ...data.general, ...g }));

  function add(e: FormEvent) {
    e.preventDefault();
    void act(async () => {
      await tool("share_deck", { deck_id, principal_type: type, principal: principal.trim(), role });
      setPrincipal("");
      setAdding(false);
    });
  }

  const AccessIcon = ACCESS[data?.general.access ?? "private"][0];
  return (
    <Dialog title={t("Share")} wide onClose={onClose}>
      <div className="cq-dialog-body cq-share">
        {!data && !error && <Spinner label={t("Loading access")} />}
        {data && (
          <>
            <section aria-label={t("People with access")}>
              <h3>{t("People with access")}</h3>
              <Table>
                <TableBody>
                  <TableRow>
                    <TableCell>
                      <User size={14} /> {data.owner} {t("(you)")}
                    </TableCell>
                    <TableCell>
                      <Tag>{t("Owner")}</Tag>
                    </TableCell>
                    <TableCell />
                  </TableRow>
                  {data.people.map((p) => {
                    const Icon = p.principal_type === "team" ? Users : User;
                    return (
                      <TableRow key={`${p.principal_type}:${p.principal}`}>
                        <TableCell>
                          <Icon size={14} /> {p.principal}
                          {p.principal_type === "team" && <span className="cq-hint"> · {t("team")}</span>}
                        </TableCell>
                        <TableCell>
                          <select
                            className="cq-select"
                            aria-label={t("Role of {name}", { name: p.principal })}
                            value={p.role}
                            onChange={(e) => void act(() => tool("share_deck", { ...target(p), role: e.target.value }))}
                          >
                            {ROLES.map(([v, l]) => (
                              <option key={v} value={v}>
                                {t(l)}
                              </option>
                            ))}
                          </select>
                        </TableCell>
                        <TableCell className="cq-row-actions">
                          <Button size="sm" variant="ghost" aria-label={t("Remove {name}", { name: p.principal })} onClick={() => void act(() => tool("unshare_deck", target(p)))}>
                            <Trash2 />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {adding ? (
                <form onSubmit={add} className="cq-share-add">
                  <Field label={t("Add")} htmlFor="s-type">
                    <select id="s-type" className="cq-select" value={type} onChange={(e) => setType(e.target.value as Type)}>
                      <option value="user">{t("A person")}</option>
                      <option value="team">{t("A team")}</option>
                    </select>
                  </Field>
                  <Field label={type === "user" ? t("User id") : t("Team")} htmlFor="s-principal">
                    <Input id="s-principal" required autoFocus value={principal} placeholder={type === "user" ? "jdoe" : "sales"} onChange={(e) => setPrincipal(e.target.value)} />
                  </Field>
                  <Field label={t("Role")} htmlFor="s-role">
                    <select id="s-role" className="cq-select" value={role} onChange={(e) => setRole(e.target.value)}>
                      {ROLES.map(([v, l]) => (
                        <option key={v} value={v}>
                          {t(l)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Button type="submit">{t("Add")}</Button>
                  <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                    {t("Cancel")}
                  </Button>
                </form>
              ) : (
                <Button variant="ghost" onClick={() => setAdding(true)}>
                  <UserPlus /> {t("Add people or teams")}
                </Button>
              )}
            </section>

            <section aria-label={t("General access")}>
              <h3>{t("General access")}</h3>
              <div className="cq-share-add">
                <select
                  className="cq-select"
                  aria-label={t("General access")}
                  value={data.general.access}
                  onChange={(e) => void general({ access: e.target.value as Access })}
                >
                  {Object.entries(ACCESS).map(([v, [, l]]) => (
                    <option key={v} value={v}>
                      {t(l)}
                    </option>
                  ))}
                </select>
                {data.general.access !== "private" && (
                  <select
                    className="cq-select"
                    aria-label={t("Link role")}
                    value={data.general.role}
                    onChange={(e) => void general({ role: e.target.value as GeneralRole })}
                  >
                    <option value="viewer">{t("Can view")}</option>
                    <option value="commenter">{t("Can comment")}</option>
                  </select>
                )}
              </div>
              <p className="cq-hint">
                <AccessIcon size={14} /> {hint(data.general)}
              </p>
              <div className="cq-row-actions">
                <Button
                  variant="outline"
                  onClick={async () => {
                    await navigator.clipboard?.writeText(data.url).catch(() => {});
                    setNote(t("Link copied."));
                  }}
                >
                  <Copy /> {t("Copy link")}
                </Button>
                <Button variant="ghost" onClick={() => void act(() => tool("reset_link", { deck_id }), t("Link reset: copies of the old link no longer open the deck."))}>
                  <RotateCcw /> {t("Reset link")}
                </Button>
              </div>
            </section>
          </>
        )}
        {note && (
          <p className="cq-hint" role="status">
            {note}
          </p>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t("Done")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
