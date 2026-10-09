// The editor's Share dialog (deck owner only): roles given to people, teams or the workspace
// (share_deck / unshare_deck), and guest links that open the deck without an account
// (create_link / revoke_link). People see a shared deck only if they see its brand pack.
import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { DialogFooter } from "diametral-ds/dialog";
import { Input } from "diametral-ds/input";
import { Table, TableBody, TableCell, TableRow } from "diametral-ds/table";
import { Tag } from "diametral-ds/tag";
import { Copy, Globe, Link2, Trash2, User, Users } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { tool } from "../api.ts";
import { ago, Dialog, Field, Spinner } from "../ui.tsx";

type Type = "user" | "team" | "workspace";
interface Share {
  principal_type: Type;
  principal: string;
  role: string;
}
interface Link {
  id: string;
  role: string;
  label: string;
  auto: boolean;
  created_by: string;
  expires_at: string;
  url: string;
}

const ROLES = [
  ["viewer", "Viewer"],
  ["commenter", "Commenter"],
  ["editor", "Editor"],
] as const;
const ICON = { user: User, team: Users, workspace: Globe };
const who = (s: Share) => (s.principal_type === "workspace" ? "Everyone in the workspace" : s.principal);

export function ShareDeck({ deck_id, onClose }: { deck_id: string; onClose: () => void }) {
  const [data, setData] = useState<{ shares: Share[]; links: Link[] } | null>(null);
  const [type, setType] = useState<Type>("user");
  const [principal, setPrincipal] = useState("");
  const [role, setRole] = useState("viewer");
  const [linkRole, setLinkRole] = useState("viewer");
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => setData(await tool<{ shares: Share[]; links: Link[] }>("list_shares", { deck_id })), [deck_id]);
  useEffect(() => {
    reload().catch((e: Error) => setError(e.message));
  }, [reload]);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const target = (s: Share) => ({ deck_id, principal_type: s.principal_type, ...(s.principal_type === "workspace" ? {} : { principal: s.principal }) });

  function add(e: FormEvent) {
    e.preventDefault();
    void act(async () => {
      await tool("share_deck", { deck_id, principal_type: type, ...(type === "workspace" ? {} : { principal: principal.trim() }), role });
      setPrincipal("");
    });
  }

  return (
    <Dialog title="Share" wide onClose={onClose}>
      <div className="cq-dialog-body cq-share">
        <form onSubmit={add} className="cq-share-add">
          <Field label="Share with" htmlFor="s-type">
            <select id="s-type" className="cq-select" value={type} onChange={(e) => setType(e.target.value as Type)}>
              <option value="user">A person</option>
              <option value="team">A team</option>
              <option value="workspace">Everyone in the workspace</option>
            </select>
          </Field>
          {type !== "workspace" && (
            <Field label={type === "user" ? "User id" : "Team"} htmlFor="s-principal">
              <Input id="s-principal" required value={principal} placeholder={type === "user" ? "jdoe" : "sales"} onChange={(e) => setPrincipal(e.target.value)} />
            </Field>
          )}
          <Field label="Role" htmlFor="s-role">
            <select id="s-role" className="cq-select" value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit">Share</Button>
        </form>
        <p className="cq-hint">Viewers read, export and present; commenters also comment; editors change the deck. Only people who see its brand pack see it.</p>

        {!data && !error && <Spinner label="Loading shares" />}
        {data && (
          <>
            <section aria-label="Shared with">
              <h3>Shared with</h3>
              {data.shares.length === 0 && <p className="cq-hint">Only you, so far.</p>}
              <Table>
                <TableBody>
                  {data.shares.map((s) => {
                    const Icon = ICON[s.principal_type];
                    return (
                      <TableRow key={`${s.principal_type}:${s.principal}`}>
                        <TableCell>
                          <Icon size={14} /> {who(s)}
                        </TableCell>
                        <TableCell>
                          <select
                            className="cq-select"
                            aria-label={`Role of ${who(s)}`}
                            value={s.role}
                            onChange={(e) => void act(() => tool("share_deck", { ...target(s), role: e.target.value }))}
                          >
                            {ROLES.map(([v, l]) => (
                              <option key={v} value={v}>
                                {l}
                              </option>
                            ))}
                          </select>
                        </TableCell>
                        <TableCell>
                          <Button size="sm" variant="ghost" aria-label={`Remove ${who(s)}`} onClick={() => void act(() => tool("unshare_deck", target(s)))}>
                            <Trash2 />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </section>

            <section aria-label="Guest links">
              <h3>Guest links</h3>
              <p className="cq-hint">Whoever holds a link opens this deck without an account, until it expires or you revoke it.</p>
              <Table>
                <TableBody>
                  {data.links.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>
                        <Link2 size={14} /> {l.label}
                        <div className="cq-hint">
                          {l.auto ? `${l.created_by}'s preview link · ` : ""}expires {ago(l.expires_at)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Tag>{l.role === "viewer" ? "Viewer" : "Commenter"}</Tag>
                      </TableCell>
                      <TableCell className="cq-row-actions">
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Copy ${l.label}`}
                          onClick={async () => {
                            await navigator.clipboard?.writeText(l.url).catch(() => {});
                            setCopied(l.id);
                          }}
                        >
                          <Copy /> {copied === l.id ? "Copied" : "Copy"}
                        </Button>
                        <Button size="sm" variant="ghost" aria-label={`Revoke ${l.label}`} onClick={() => void act(() => tool("revoke_link", { deck_id, link_id: l.id }))}>
                          <Trash2 /> Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="cq-share-add">
                <Field label="Link role" htmlFor="s-link-role">
                  <select id="s-link-role" className="cq-select" value={linkRole} onChange={(e) => setLinkRole(e.target.value)}>
                    <option value="viewer">Viewer</option>
                    <option value="commenter">Commenter</option>
                  </select>
                </Field>
                <Button variant="outline" onClick={() => void act(() => tool("create_link", { deck_id, role: linkRole }))}>
                  <Link2 /> Create link
                </Button>
              </div>
            </section>
          </>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
