import { DeckViewer, type DeckView, type NewComment, type NewReply } from "@calque/slide-ui";
import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "diametral-ds/table";
import { Tag } from "diametral-ds/tag";
import { BadgeCheck, BookMarked, CircleCheck, Cloud, Download, FileText, History, ListChecks, ListPlus, Play, Send, Share2, Sparkles, TriangleAlert, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { agent, api, tool, type Me, type Pack } from "../api.ts";
import { Chat, type Ask } from "../components/Chat.tsx";
import { AddSlides, ReviewDeck } from "../components/DeckActions.tsx";
import { ExportWithErrors } from "../components/ExportGate.tsx";
import { AddToLibrary, LibraryPanel } from "../components/Library.tsx";
import { SaveToM365, useM365 } from "../components/M365.tsx";
import { ShareDeck } from "../components/Share.tsx";
import { slideUiStrings, t } from "../i18n.ts";
import { bySeverity, type Finding, lintSummary } from "../lint.ts";
import { navigate } from "../nav.ts";
import { ago, Dialog, Spinner } from "../ui.tsx";

type Deck = DeckView & { versions: { version: number; note: string; author: string; author_name: string | null; created_at: string }[] };
const APPROVAL = { draft: "Draft", in_review: "In review", approved: "Approved" } as const;

const EDITS = ["Tighten every title to one line", "Add an agenda slide after the cover", "Review the deck against the brand pack"] as const;

/** The editor: the deck workspace (slide-ui) with the agent chat in its side panel. */
export function Editor({ id }: { id: string }) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [report, setReport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  // toolbar actions that go through the agent chat, and their dialogs
  const [ask, setAsk] = useState<Ask | null>(null);
  const [dialog, setDialog] = useState<"add" | "review" | "share" | "export" | "m365" | null>(null);
  // the slide library: the slide being added, who the viewer is and whether they manage the pack
  const [adding, setAdding] = useState<{ id: string; number: number } | null>(null);
  const [library, setLibrary] = useState(0);
  const [me, setMe] = useState<Me | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const m365 = useM365();
  useEffect(() => {
    api<Me>("/api/me").then(setMe, () => setMe(null));
    tool<{ packs: Pack[] }>("list_packs").then((r) => setPacks(r.packs), () => setPacks([]));
  }, []);

  const reload = useCallback(async () => {
    try {
      setDeck(await tool<Deck>("open_deck", { deck_id: id }));
      setFindings((await tool<{ findings: Finding[] }>("lint_deck", { deck_id: id })).findings);
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
          <Spinner label={t("Loading deck")} />
        )}
      </div>
    );
  const summary = findings && lintSummary(findings);
  // a deck shared with the user: viewers read, commenters also comment, editors change it
  const role = deck.role ?? "owner";
  const edits = role === "editor" || role === "owner";
  const errors = findings?.filter((f) => f.severity === "ERROR") ?? [];
  const exportPptx = async (reason?: string) =>
    location.assign((await tool<{ download_url: string }>("export_pptx", { deck_id: id, ...(reason ? { reason } : {}) })).download_url);
  const approval = deck.approval?.enabled ? deck.approval : null;
  const setApproval = (status: "draft" | "in_review" | "approved", label: string) =>
    void run(label, () => tool("set_approval", { deck_id: id, status }));
  const manages = packs.find((p) => p.id === deck.pack_id)?.editable ?? false;
  return (
    <>
      <DeckViewer
        deck={deck}
        strings={slideUiStrings()}
        working={busy}
        actions={
          <>
            {summary &&
              (findings?.length ? (
                <Button variant="ghost" aria-label={t("Lint: {summary}", { summary: summary.label })} onClick={() => setReport(true)}>
                  <Tag tone={summary.tone}>
                    <TriangleAlert /> {summary.label}
                  </Tag>
                </Button>
              ) : (
                <Tag tone="success">
                  <CircleCheck /> {summary.label}
                </Tag>
              ))}
            {edits ? (
              <>
                <Button variant="ghost" onClick={() => setDialog("add")}>
                  <ListPlus /> {t("Add slides")}
                </Button>
                <Button variant="ghost" onClick={() => setDialog("review")}>
                  <ListChecks /> {t("Review")}
                </Button>
              </>
            ) : (
              <Tag>{role === "viewer" ? t("Viewer") : t("Commenter")}</Tag>
            )}
            <Button variant="ghost" onClick={() => setHistory(true)}>
              <History /> {t("History")}
            </Button>
            <Button variant="outline" onClick={() => navigate(`/present/${id}`)}>
              <Play /> {t("Present")}
            </Button>
            {approval && (
              <>
                <Tag tone={approval.status === "approved" ? "success" : approval.status === "in_review" ? "warning" : "neutral"}>{t(APPROVAL[approval.status])}</Tag>
                {approval.can_request && (
                  <Button variant="ghost" onClick={() => setApproval("in_review", t("Requesting review"))}>
                    <Send /> {t("Request review")}
                  </Button>
                )}
                {approval.can_approve && (
                  <>
                    <Button variant="ghost" onClick={() => setApproval("approved", t("Approving"))}>
                      <BadgeCheck /> {t("Approve")}
                    </Button>
                    <Button variant="ghost" onClick={() => setApproval("draft", t("Requesting changes"))}>
                      <Undo2 /> {t("Request changes")}
                    </Button>
                  </>
                )}
                {approval.can_withdraw && !approval.can_approve && (
                  <Button variant="ghost" onClick={() => setApproval("draft", t("Back to draft"))}>
                    <Undo2 /> {t("Back to draft")}
                  </Button>
                )}
              </>
            )}
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={async () => {
                setBusy(t("Exporting PDF"));
                setError(null);
                try {
                  location.assign((await tool<{ download_url: string }>("export_pdf", { deck_id: id })).download_url);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(null);
                }
              }}
            >
              <FileText /> {t("Export PDF")}
            </Button>
            {/* the soft gate: lint ERRORs ask for a reason, recorded with the export, never a block */}
            <Button onClick={() => (errors.length ? setDialog("export") : void exportPptx().catch((e: Error) => setError(e.message)))}>
              <Download /> {t("Export PPTX")}
            </Button>
            {m365 && (
              <Button variant="outline" onClick={() => setDialog("m365")}>
                <Cloud /> {t("Save to SharePoint")}
              </Button>
            )}
            {role === "owner" && (
              <Button variant="outline" onClick={() => setDialog("share")}>
                <Share2 /> {t("Share")}
              </Button>
            )}
          </>
        }
        agent={
          edits && (
            <Chat
              storageKey={`chat:${id}`}
              deck_id={id}
              pack_id={deck.pack_id}
              placeholder={t("Ask for a change: reword, add a slide, review…")}
              suggestions={EDITS.map((e) => t(e))}
              ask={ask}
              empty={
                <div className="cq-empty">
                  <Sparkles />
                  <strong>{t("Edit with the agent")}</strong>
                  <span>{t("Ask for a change in your words. Comments on the slides go through the agent too.")}</span>
                </div>
              }
              onDone={() => void reload()}
            />
          )
        }
        tabs={[
          {
            id: "library",
            label: t("Library"),
            icon: <BookMarked />,
            content: <LibraryPanel key={library} pack_id={deck.pack_id} deck_id={id} canEdit={edits} manages={manages} me={me?.id ?? null} onInserted={() => void reload()} />,
          },
        ]}
        {...(edits
          ? {
              slideActions: (s: { id: string; number: number }) => (
                <Button variant="ghost" size="sm" onClick={() => setAdding({ id: s.id, number: s.number })}>
                  <BookMarked /> {t("Add to library")}
                </Button>
              ),
            }
          : {})}
        {...(role !== "viewer"
          ? {
              onComment: async (c: NewComment) => {
                await tool("add_comment", { deck_id: id, ...c });
                await reload();
              },
              onReply: async (r: NewReply) => {
                await tool("add_comment", { deck_id: id, ...r });
                await reload();
              },
            }
          : {})}
        {...(edits
          ? {
              onApply: (ids?: number[]) =>
                run(t("Applying comments"), () => agent("/api/agent/apply-comments", { deck_id: id, ...(ids ? { comment_ids: ids } : {}) }, () => {})),
              onResolve: (ids: number[], status: "open" | "resolved") => run("", () => tool("resolve_comments", { deck_id: id, comment_ids: ids, status })),
            }
          : {})}
      />
      {error && (
        <div className="cq-toast" role="alert">
          <TriangleAlert /> <span>{error}</span>
          <Button variant="ghost" size="icon-sm" aria-label={t("Dismiss")} onClick={() => setError(null)}>
            <X />
          </Button>
        </div>
      )}
      {dialog === "share" && <ShareDeck deck_id={id} onClose={() => setDialog(null)} />}
      {dialog === "export" && <ExportWithErrors errors={errors} onClose={() => setDialog(null)} onExport={exportPptx} />}
      {dialog === "m365" && m365 && <SaveToM365 status={m365} deck_id={id} errors={errors.length} onClose={() => setDialog(null)} />}
      {adding && (
        <AddToLibrary deck_id={id} slide_id={adding.id} number={adding.number} manages={manages} onClose={() => setAdding(null)} onAdded={() => setLibrary((n) => n + 1)} />
      )}
      {dialog === "add" && <AddSlides onClose={() => setDialog(null)} onAsk={setAsk} />}
      {dialog === "review" && (
        <ReviewDeck
          deck_id={id}
          onClose={() => setDialog(null)}
          onAsk={setAsk}
          onApplySafe={() => {
            setDialog(null);
            void run(t("Applying safe fixes"), () => tool("review_deck", { deck_id: id, apply_safe_fixes: true }));
          }}
        />
      )}
      {history && (
        <Dialog title={t("Version history")} wide onClose={() => setHistory(false)}>
          <div className="cq-dialog-body">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Version")}</TableHead>
                  <TableHead>{t("Change")}</TableHead>
                  <TableHead>{t("By")}</TableHead>
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
                    <TableCell>{v.author_name || v.author}</TableCell>
                    <TableCell>
                      {v.version === deck.head ? (
                        <Tag>{t("Current")}</Tag>
                      ) : (
                        edits && (
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={t("Restore v{version}", { version: v.version })}
                            onClick={() => {
                              setHistory(false);
                              void run(t("Restoring"), () => tool("restore_version", { deck_id: id, version: v.version }));
                            }}
                          >
                            {t("Restore")}
                          </Button>
                        )
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Dialog>
      )}
      {report && findings && (
        <Dialog title={t("Lint: {summary}", { summary: summary?.label ?? "" })} wide onClose={() => setReport(false)}>
          <div className="cq-dialog-body">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Severity")}</TableHead>
                  <TableHead>{t("Slide")}</TableHead>
                  <TableHead>{t("Finding")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bySeverity(findings).map((f, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Tag tone={f.severity === "ERROR" ? "danger" : f.severity === "WARN" ? "warning" : "neutral"}>{f.severity}</Tag>
                    </TableCell>
                    <TableCell>{f.slide ? t("Slide {n}", { n: f.slide }) : t("Deck")}</TableCell>
                    <TableCell>
                      {f.message}
                      <div className="cq-hint">
                        <span className="cq-mono">{f.check}</span>
                        {f.shape_id !== null && ` · ${t("shape {id}", { id: f.shape_id })}`}
                      </div>
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
