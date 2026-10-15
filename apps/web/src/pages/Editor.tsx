import { DeckViewer, type DeckView, type NewComment, type NewReply } from "@calque/slide-ui";
import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { Tag } from "diametral-ds/tag";
import { BookMarked, ChevronLeft, CircleCheck, Cloud, Download, FileText, History, ListChecks, ListPlus, MessageSquareShare, Play, RefreshCw, Share2, Sparkles, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { agent, api, tool, type Me, type Pack } from "../api.ts";
import { DeckDiff } from "../components/ai/DeckDiff.tsx";
import { FindingCard, fixAsk } from "../components/ai/FindingCard.tsx";
import { Chat, type Ask } from "../components/Chat.tsx";
import { AddSlides, ReviewDeck } from "../components/DeckActions.tsx";
import { TypeAndApproval, VersionHistory } from "../components/Document.tsx";
import { ExportWithErrors } from "../components/ExportGate.tsx";
import { AddToLibrary, LibraryPanel } from "../components/Library.tsx";
import { SaveToM365, ShareToTeams, useM365 } from "../components/M365.tsx";
import { ShareDeck } from "../components/Share.tsx";
import { slideUiStrings, t } from "../i18n.ts";
import { bySeverity, type Finding, lintSummary } from "../lint.ts";
import { go, navigate } from "../nav.ts";
import { Dialog, Spinner } from "../ui.tsx";

type Deck = DeckView & {
  versions: { version: number; note: string; author: string; author_name: string | null; created_at: string; pack_version: number | null }[];
  /** The pack release the deck is built on, and the pack's latest one (update_pack_release). */
  pack_version?: number | null;
  pack_latest?: number;
  /** the deck's type, and the types its pack offers (approval may apply to some only) */
  kind?: string | null;
  kinds?: string[];
};

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
  const [dialog, setDialog] = useState<"add" | "review" | "share" | "export" | "m365" | "teams" | null>(null);
  // the saved file a Teams post links to, after Save to SharePoint
  const [teamsFile, setTeamsFile] = useState<string | undefined>(undefined);
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
      // a design's id (an old link): its own page
      if (/is a design, not a deck/.test((e as Error).message)) return navigate(`/designs/${id}`);
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
  const setApproval = (status: "draft" | "in_review" | "approved", label: string) =>
    void run(label, () => tool("set_approval", { deck_id: id, status }));
  const manages = packs.find((p) => p.id === deck.pack_id)?.editable ?? false;
  // the deck stays on its pack release until its author moves it to the latest one
  const newRelease = edits && deck.pack_version != null && deck.pack_latest !== undefined && deck.pack_latest > deck.pack_version ? deck.pack_latest : null;
  return (
    <>
      <DeckViewer
        deck={deck}
        strings={slideUiStrings()}
        working={busy}
        {...(edits
          ? {
              onAskShape: ({ slide, shape_id, label, instruction }: { slide: number; shape_id: number; label: string; instruction: string }) =>
                setAsk({ text: t('On slide {n}, shape "{label}" (#{id}): {instruction}', { n: slide, label, id: shape_id, instruction }), workflow: "edit-slides" }),
            }
          : {})}
        back={
          <a className="cq-btn cq-bar-back" data-variant="ghost" data-icon href="/" aria-label={t("Decks")} onClick={(e) => go(e, "/")}>
            <ChevronLeft />
          </a>
        }
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
            {newRelease !== null && (
              <Button
                variant="outline"
                title={t("The {pack} pack has a new release: rebuild this deck on it, as a new version (Restore goes back)", { pack: deck.pack_id })}
                onClick={() => void run(t("Updating to the latest pack release"), () => tool("update_pack_release", { deck_id: id }))}
              >
                <RefreshCw /> {t("Update to pack release {n}", { n: newRelease })}
              </Button>
            )}
            <Button variant="outline" onClick={() => navigate(`/present/${id}`)}>
              <Play /> {t("Present")}
            </Button>
            <TypeAndApproval
              kind={deck.kind}
              kinds={deck.kinds}
              approval={deck.approval}
              edits={edits}
              busy={busy !== null}
              onKind={(kind) => void run(t("Setting the deck type"), () => tool("set_deck_kind", { deck_id: id, kind }))}
              onApproval={setApproval}
            />
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
            {m365 && (
              <Button
                variant="outline"
                onClick={() => {
                  setTeamsFile(undefined);
                  setDialog("teams");
                }}
              >
                <MessageSquareShare /> {t("Share to Teams")}
              </Button>
            )}
            {role === "owner" && (
              <Button variant="outline" onClick={() => setDialog("share")}>
                <Share2 /> {t("Share")}
              </Button>
            )}
          </>
        }
        // the deck's conversation: everyone with access reads it, editors continue it
        agent={
          <Chat
            deck_id={id}
            slides={deck.slides.length}
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
        }
        tabs={[
          {
            id: "library",
            label: t("Library"),
            icon: <BookMarked />,
            content: (
              <LibraryPanel key={library} pack_id={deck.pack_id} deck_id={id} canEdit={edits} manages={manages} me={me?.id ?? null} onInserted={() => void reload()} onAsk={setAsk} />
            ),
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
      {dialog === "m365" && m365 && (
        <SaveToM365
          status={m365}
          deck_id={id}
          errors={errors.length}
          onClose={() => setDialog(null)}
          onShareTeams={(url) => {
            setTeamsFile(url);
            setDialog("teams");
          }}
        />
      )}
      {dialog === "teams" && m365 && <ShareToTeams status={m365} deck_id={id} file_url={teamsFile} onClose={() => setDialog(null)} />}
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
        <VersionHistory
          versions={deck.versions}
          head={deck.head}
          canRestore={edits}
          onClose={() => setHistory(false)}
          onRestore={(version) => {
            setHistory(false);
            void run(t("Restoring"), () => tool("restore_version", { deck_id: id, version }));
          }}
          changes={(version) => <DeckDiff deck_id={id} version={version} />}
        />
      )}
      {report && findings && (
        <Dialog title={t("Lint: {summary}", { summary: summary?.label ?? "" })} wide onClose={() => setReport(false)}>
          <div className="cq-dialog-body grid gap-3" role="list">
            {bySeverity(findings).map((f, i) => (
              <FindingCard
                key={i}
                finding={f}
                {...(edits
                  ? {
                      onFix: () => {
                        setReport(false);
                        setAsk({ text: fixAsk(f), workflow: "edit-slides" });
                      },
                    }
                  : {})}
              />
            ))}
          </div>
        </Dialog>
      )}
    </>
  );
}
