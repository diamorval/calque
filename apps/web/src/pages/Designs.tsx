// A design (DesignSpec, docs/adr/0002): a document of the same store as decks, so it has what a
// deck has: versions and history, sharing and its link, comments (on an artboard or one node),
// type and approval, the export gate, Microsoft 365, the pack library and the agent. What is its
// own: the artboards as the engine laid them out with their lint, the token mode, adapting an
// artboard to another format, editing a text in place, and the file and code exports. The list is
// the Decks page with medium "design". Every change is a tool call. Opened with a share link (?k=)
// or a per-user token (?t=), the page talks to /designs/:id/tools instead of /api/tools.
import type { Approval } from "@calque/slide-ui";
import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { Card, CardContent, CardHeader } from "diametral-ds/card";
import { Checkbox } from "diametral-ds/checkbox";
import { CodeBlock, CodeBlockBody, CodeBlockCopyButton, CodeBlockFilename, CodeBlockHead } from "diametral-ds/code-block";
import { DialogFooter } from "diametral-ds/dialog";
import { Input } from "diametral-ds/input";
import { Tag } from "diametral-ds/tag";
import { Textarea } from "diametral-ds/textarea";
import { ToggleGroup, ToggleGroupItem } from "diametral-ds/toggle-group";
import { ArrowLeft, BookMarked, Check, Cloud, Code, Copy, Download, History, MessageSquare, MessageSquareShare, RefreshCw, Share2, Sparkles, Undo2, Wand2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { agent, api, tool, type Me, type Pack } from "../api.ts";
import { Chat } from "../components/Chat.tsx";
import { TypeAndApproval, VersionHistory, type Version } from "../components/Document.tsx";
import { ExportWithErrors } from "../components/ExportGate.tsx";
import { AddToLibrary, LibraryPanel } from "../components/Library.tsx";
import { SaveToM365, ShareToTeams, useM365 } from "../components/M365.tsx";
import { ShareDeck } from "../components/Share.tsx";
import { t, tn } from "../i18n.ts";
import type { Finding as LintFinding } from "../lint.ts";
import { go } from "../nav.ts";
import { ago, Dialog, Field, PageHead, Spinner } from "../ui.tsx";

const BASE = import.meta.env.BASE_URL;
/** The toggle's value for the pack's base values (no mode). */
const BASE_MODE = "__base";

type Role = "viewer" | "commenter" | "editor" | "owner";
const RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };
const can = (role: Role | undefined, need: Role) => RANK[role ?? "viewer"] >= RANK[need];

interface Finding {
  severity: "ERROR" | "WARN";
  artboard: string | null;
  node: string | null;
  check?: string;
  message: string;
}

/** A comment thread: on an artboard (slide_id) and optionally one node of it. */
interface Comment {
  id: number;
  slide_id: string;
  node: string | null;
  text: string;
  author: string;
  author_name: string | null;
  status: "open" | "resolved";
  type?: "suggestion" | "required";
  created_at: string;
  replies?: Comment[];
}

interface Artboard {
  id: string;
  format: string;
  width: number;
  height: number;
  mode: string | null;
  boxes?: Record<string, { x: number; y: number; w: number; h: number }>;
}

/** The parts of a DesignSpec the page reads (the engine owns the rest). */
interface SpecNode {
  id: string;
  type: string;
  text?: string;
  component?: string;
  variant?: string;
  props?: Record<string, string>;
  children?: SpecNode[];
}
interface Spec {
  mode?: string;
  artboards: { id: string; children: SpecNode[] }[];
  components?: Record<string, { props?: Record<string, string>; node: SpecNode; variants?: Record<string, SpecNode> }>;
}

interface DesignView {
  design_id: string;
  title: string;
  pack_id: string;
  pack_version?: number | null;
  pack_latest?: number;
  version: number;
  head: number;
  artboards: Artboard[];
  errors: Finding[];
  warnings: Finding[];
  spec: Spec;
  role: Role;
  /** the caller's user id: a commenter resolves their own threads */
  me: string | null;
  kind?: string | null;
  kinds?: string[];
  approval?: Approval;
  versions: Version[];
  open_comments: Comment[];
}

interface Formats {
  formats: { id: string; label: string; width: number; height: number }[];
  modes: string[];
}

const find = (nodes: SpecNode[], id: string): SpecNode | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n;
    const inner = find(n.children ?? [], id);
    if (inner) return inner;
  }
  return undefined;
};

/** How to change the text of node `id` (as the node boxes name it): a text node's `text`, or for a
text inside a component instance (`<instance>__<node>`) whose text is one `{prop}`, that prop of
the instance. Null: not a text the page can edit (ask the agent). */
export function textTarget(spec: Spec, artboard: string, id: string): { text: string; ops: (text: string) => unknown[] } | null {
  const board = spec.artboards.find((b) => b.id === artboard);
  if (!board) return null;
  const own = find(board.children, id);
  if (own?.type === "text") return { text: own.text ?? "", ops: (text) => [{ op: "set_node", artboard, node_id: id, props: { text } }] };
  const [inst, child, ...deeper] = id.split("__");
  const instance = inst && child && !deeper.length ? find(board.children, inst) : undefined;
  const comp = instance?.type === "instance" && instance.component ? spec.components?.[instance.component] : undefined;
  if (!instance || !comp || !child) return null;
  const src = (instance.variant && comp.variants?.[instance.variant]) || comp.node;
  const prop = /^\{(\w+)\}$/.exec(find([src], child)?.text ?? "")?.[1];
  if (!prop) return null;
  const props = instance.props ?? {};
  return {
    text: props[prop] ?? comp.props?.[prop] ?? "",
    ops: (text) => [{ op: "set_node", artboard, node_id: inst, props: { props: { ...props, [prop]: text } } }],
  };
}

const TONE = { ERROR: "danger", WARN: "warning" } as const;

function FindingCard({ f, onFix }: { f: Finding; onFix?: (() => void) | undefined }) {
  return (
    <Card size="sm" role="listitem">
      <CardHeader className="flex flex-wrap items-center gap-2">
        <Tag tone={TONE[f.severity]}>{f.severity}</Tag>
        {f.node && <span className="cq-mono text-sm">{f.node}</span>}
        {f.check && <span className="cq-mono ml-auto text-xs text-muted-foreground">{f.check}</span>}
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        {f.message}
        {onFix && (
          <Button size="sm" variant="outline" className="justify-self-end" onClick={onFix}>
            <Sparkles /> {t("Fix with the agent")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

type Export = "png" | "png2" | "pdf" | "svg" | "html";
const EXPORTS: { id: Export; label: string; args: { format: string; scale?: number } }[] = [
  { id: "png", label: "PNG", args: { format: "png" } },
  { id: "png2", label: "PNG @2x", args: { format: "png", scale: 2 } },
  { id: "pdf", label: "PDF", args: { format: "pdf" } },
  { id: "svg", label: "SVG", args: { format: "svg" } },
  { id: "html", label: "HTML", args: { format: "html" } },
];

/** Start one download per file (the server sends them as attachments, PNG inline: `download` names it). */
function download(urls: string[]) {
  for (const url of urls) {
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
  }
}

const SUGGESTIONS = ["Make the headline shorter and punchier", "Adapt the post to a story", "Switch the banner to the dark mode"] as const;

/** One design. `link`: the share link key (`k=…`) or per-user token (`t=…`) it was opened with. */
export function DesignEditor({ id, link }: { id: string; link?: string | undefined }) {
  const [d, setD] = useState<DesignView | null>(null);
  const [formats, setFormats] = useState<Formats | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<{ filename: string; code: string } | null>(null);
  const [adapt, setAdapt] = useState<{ artboard: string; format: string } | null>(null);
  // the node clicked on an artboard: edit its text, comment on it
  const [picked, setPicked] = useState<{ artboard: string; node: string } | null>(null);
  const [dialog, setDialog] = useState<"share" | "history" | "m365" | "teams" | "export" | null>(null);
  const [pending, setPending] = useState<(typeof EXPORTS)[number] | null>(null);
  const [teamsFile, setTeamsFile] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState<{ id: string; number: number } | null>(null);
  const [panel, setPanel] = useState<"agent" | "library">("agent");
  const [ask, setAsk] = useState<{ text: string } | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const m365 = useM365();

  // signed in: the REST API; with a link: this design's own tools (viewer, comments, exports)
  const call = useCallback(
    <T,>(name: string, args: Record<string, unknown> = {}) => (link ? api<T>(`/designs/${id}/tools/${name}?${link}`, args) : tool<T>(name, args)),
    [id, link],
  );
  const open = useCallback(() => call<DesignView>("open_design", { design_id: id }).then(setD), [call, id]);
  useEffect(() => {
    open().catch((e) => setError((e as Error).message));
  }, [open]);
  useEffect(() => {
    if (link) return;
    api<Me>("/api/me").then(setMe, () => setMe(null));
    tool<{ packs: Pack[] }>("list_packs").then((r) => setPacks(r.packs), () => setPacks([]));
  }, [link]);
  useEffect(() => {
    if (d?.pack_id && !link) tool<Formats>("list_formats", { pack_id: d.pack_id }).then(setFormats, () => setFormats(null));
  }, [d?.pack_id, link]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setError(null);
    setBusy(label);
    try {
      await fn();
      await open();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const patch = (label: string, ops: unknown[]) => run(label, () => call("patch_design", { design_id: id, ops, note: label }));
  const comment = (slide_id: string, node: string | null, text: string, required = false) =>
    run(t("Commenting"), () => call("add_comment", { deck_id: id, slide_id, ...(node ? { node } : {}), text, ...(required ? { type: "required" } : {}) }));
  const reply = (parent_id: number, text: string) => run(t("Commenting"), () => call("add_comment", { deck_id: id, parent_id, text }));
  const resolve = (c: Comment) => run(t("Resolving"), () => call("resolve_comments", { deck_id: id, comment_ids: [c.id] }));
  const exportAll = (e: (typeof EXPORTS)[number], reason?: string) =>
    run(t("Exporting {format}", { format: e.label }), async () => {
      const r = await call<{ files: { url: string }[]; pdf_url?: string }>("export_design", { design_id: id, ...e.args, ...(reason ? { reason } : {}) });
      download(r.pdf_url ? [r.pdf_url] : r.files.map((f) => f.url));
    });
  const exportCode = (artboard: string, format: "react" | "tailwind") =>
    run(t("Exporting {format}", { format }), async () => setCode(await call<{ filename: string; code: string }>("export_design", { design_id: id, format, artboard })));

  if (!d)
    return (
      <div className="cq-page">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <Spinner label={t("Loading the design")} />
        )}
      </div>
    );

  const png = (artboard: string) => `${BASE}designs/${id}/${artboard}.png?v=${d.version}${link ? `&${link}` : ""}`;
  const label = (format: string) => formats?.formats.find((f) => f.id === format)?.label ?? format;
  const findings = (artboard: string) => [...d.errors, ...d.warnings].filter((f) => f.artboard === artboard);
  const designWide = [...d.errors, ...d.warnings].filter((f) => !f.artboard);
  const mode = d.spec.mode ?? "";
  const editor = can(d.role, "editor");
  const commenter = can(d.role, "commenter");
  const threads = (artboard: string, node?: string) => d.open_comments.filter((c) => c.slide_id === artboard && (node === undefined || c.node === node));
  const mayResolve = (c: Comment) => editor || (commenter && c.author === d.me);
  const manages = packs.find((p) => p.id === d.pack_id)?.editable ?? false;
  const newRelease = editor && d.pack_version != null && d.pack_latest !== undefined && d.pack_latest > d.pack_version ? d.pack_latest : null;
  const lintErrors: LintFinding[] = d.errors.map((f) => ({ severity: "ERROR", slide: null, slide_id: f.artboard, shape_id: null, check: f.check ?? "", message: f.message }));
  const fixAsk = (f: Finding) =>
    setAsk({ text: t("Fix this lint finding on artboard {id}{node} ({check}): {message}", { id: f.artboard ?? "", node: f.node ? `, ${f.node}` : "", check: f.check ?? "", message: f.message }) });

  return (
    <div className="cq-design-layout" data-link={link ? true : undefined}>
      <div className="cq-page cq-design">
        <PageHead
          title={d.title}
          description={`${d.pack_id} · v${d.version} · ${tn(d.errors.length, "{n} error", "{n} errors")} · ${tn(d.warnings.length, "{n} warning", "{n} warnings")}`}
        >
          {!link && (
            <Button variant="ghost" onClick={(e) => go(e, "/designs")}>
              <ArrowLeft /> {t("Designs")}
            </Button>
          )}
          {!link && (
            <Button variant="outline" onClick={() => setDialog("history")}>
              <History /> {t("History")}
            </Button>
          )}
          {editor && (
            <Button variant="outline" disabled={!!busy || d.head < 2} onClick={() => void run(t("Undoing"), () => call("restore_version", { deck_id: id }))}>
              <Undo2 /> {t("Undo")}
            </Button>
          )}
          {d.role === "owner" && !link && (
            <Button variant="outline" onClick={() => setDialog("share")}>
              <Share2 /> {t("Share")}
            </Button>
          )}
        </PageHead>

        <div className="cq-design-bar" role="toolbar" aria-label={t("Design tools")}>
          {editor && !!formats?.modes.length && (
            <ToggleGroup
              variant="outline"
              spacing={0}
              aria-label={t("Colour mode")}
              value={[mode || BASE_MODE]}
              onValueChange={(v: string[]) => {
                const next = v[0] === BASE_MODE ? "" : v[0];
                if (next !== undefined && next !== mode) void patch(t("Colour mode"), [{ op: "set_field", field: "mode", value: next || null }]);
              }}
            >
              {[BASE_MODE, ...formats.modes].map((m) => (
                <ToggleGroupItem key={m} value={m} className="aria-pressed:bg-foreground aria-pressed:text-background">
                  {m === BASE_MODE ? t("Base") : m}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
          {!link && (
            <TypeAndApproval
              kind={d.kind}
              kinds={d.kinds}
              approval={d.approval}
              edits={editor}
              busy={!!busy}
              onKind={(kind) => void run(t("Setting the deck type"), () => tool("set_deck_kind", { deck_id: id, kind }))}
              onApproval={(status, l) => void run(l, () => tool("set_approval", { deck_id: id, status }))}
            />
          )}
          {newRelease !== null && (
            <Button variant="outline" onClick={() => void run(t("Updating to the latest pack release"), () => tool("update_pack_release", { deck_id: id }))}>
              <RefreshCw /> {t("Update to pack release {n}", { n: newRelease })}
            </Button>
          )}
          <span className="cq-design-exports">
            <Download aria-hidden />
            {EXPORTS.map((e) => (
              <Button
                key={e.id}
                size="sm"
                variant="outline"
                disabled={!!busy}
                // the soft gate, as Export PPTX: lint ERRORs ask for a reason, recorded with the export
                onClick={() => {
                  if (d.errors.length && !link) {
                    setPending(e);
                    setDialog("export");
                  } else void exportAll(e);
                }}
              >
                {e.label}
              </Button>
            ))}
          </span>
          {m365 && !link && (
            <>
              <Button size="sm" variant="outline" onClick={() => setDialog("m365")}>
                <Cloud /> {t("Save to SharePoint")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setTeamsFile(undefined);
                  setDialog("teams");
                }}
              >
                <MessageSquareShare /> {t("Share to Teams")}
              </Button>
            </>
          )}
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {busy && <Spinner label={busy} />}
        {editor && !link && d.open_comments.length > 0 && (
          <div className="cq-design-apply">
            <Button variant="outline" disabled={!!busy} onClick={() => void run(t("Applying comments"), () => agent("/api/agent/apply-comments", { deck_id: id }, () => {}))}>
              <Wand2 /> {tn(d.open_comments.length, "Apply {n} comment", "Apply {n} comments")}
            </Button>
          </div>
        )}
        {designWide.length > 0 && (
          <div role="list" className="cq-findings">
            {designWide.map((f, i) => (
              <FindingCard key={i} f={f} />
            ))}
          </div>
        )}

        {d.artboards.map((a, i) => {
          const fs = findings(a.id);
          return (
            <section key={a.id} className="cq-board" aria-label={t("Artboard {id}", { id: a.id })}>
              <header className="cq-board-head">
                <h2>{a.id}</h2>
                <span>
                  {label(a.format)} · {a.width}×{a.height}
                  {a.mode && ` · ${a.mode}`}
                </span>
                <span className="cq-board-actions">
                  {editor && !link && (
                    <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setAdapt({ artboard: a.id, format: formats?.formats.find((f) => f.id !== a.format)?.id ?? "" })}>
                      <Copy /> {t("Adapt to…")}
                    </Button>
                  )}
                  {editor && !link && (
                    <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setAdding({ id: a.id, number: i + 1 })}>
                      <BookMarked /> {t("Add to library")}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void exportCode(a.id, "react")}>
                    <Code /> React
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void exportCode(a.id, "tailwind")}>
                    <Code /> Tailwind
                  </Button>
                </span>
              </header>
              <div className="cq-board-body">
                <div className="cq-board-canvas">
                  <span className="cq-board-frame">
                    <img src={png(a.id)} alt={t("Artboard {id}", { id: a.id })} width={a.width} height={a.height} />
                    <Hits board={a} commented={new Set(threads(a.id).map((c) => c.node ?? ""))} onPick={(node) => setPicked({ artboard: a.id, node })} />
                  </span>
                </div>
                <div className="cq-board-side">
                  <div role="list" className="cq-findings" aria-label={t("Checks for {id}", { id: a.id })}>
                    {fs.length === 0 ? (
                      <p className="cq-hint">{t("No issue found.")}</p>
                    ) : (
                      fs.map((f, k) => <FindingCard key={k} f={f} onFix={editor && !link ? () => fixAsk(f) : undefined} />)
                    )}
                  </div>
                  <Threads
                    label={t("Comments on {id}", { id: a.id })}
                    threads={threads(a.id)}
                    onNode={(node) => setPicked({ artboard: a.id, node })}
                    onReply={commenter ? (c, text) => void reply(c.id, text) : undefined}
                    onResolve={(c) => (mayResolve(c) ? () => void resolve(c) : undefined)}
                  />
                  {commenter && <Composer label={t("Comment on {id}", { id: a.id })} required onSend={(text, required) => void comment(a.id, null, text, required)} />}
                </div>
              </div>
            </section>
          );
        })}
      </div>

      {!link && (
        <aside className="cq-design-aside" aria-label={t("Agent and library")}>
          <ToggleGroup variant="outline" spacing={0} aria-label={t("Side panel")} value={[panel]} onValueChange={(v: string[]) => v[0] && setPanel(v[0] as "agent" | "library")}>
            <ToggleGroupItem value="agent" className="aria-pressed:bg-foreground aria-pressed:text-background">
              <Sparkles /> {t("Agent")}
            </ToggleGroupItem>
            <ToggleGroupItem value="library" className="aria-pressed:bg-foreground aria-pressed:text-background">
              <BookMarked /> {t("Library")}
            </ToggleGroupItem>
          </ToggleGroup>
          {panel === "agent" ? (
            <Chat
              deck_id={id}
              pack_id={d.pack_id}
              workflow="create-design"
              placeholder={t("Ask for a change: reword, adapt to a format, switch the mode…")}
              suggestions={SUGGESTIONS.map((s) => t(s))}
              ask={ask}
              empty={
                <div className="cq-empty">
                  <Sparkles />
                  <strong>{t("Edit with the agent")}</strong>
                  <span>{t("Ask for a change in your words. Comments on the artboards go through the agent too.")}</span>
                </div>
              }
              onDone={() => void open()}
            />
          ) : (
            <LibraryPanel pack_id={d.pack_id} deck_id={id} medium="design" canEdit={editor} manages={manages} me={me?.id ?? null} onInserted={() => void open()} />
          )}
        </aside>
      )}

      {picked && (
        <NodeDialog
          node={picked.node}
          target={editor ? textTarget(d.spec, picked.artboard, picked.node) : null}
          threads={threads(picked.artboard, picked.node)}
          onClose={() => setPicked(null)}
          onSave={(ops) => {
            setPicked(null);
            void patch(t("Edit {id}", { id: picked.node }), ops);
          }}
          onComment={
            commenter
              ? (text) => {
                  setPicked(null);
                  void comment(picked.artboard, picked.node, text);
                }
              : undefined
          }
        />
      )}
      {dialog === "share" && <ShareDeck deck_id={id} onClose={() => setDialog(null)} />}
      {dialog === "history" && (
        <VersionHistory
          versions={d.versions}
          head={d.head}
          canRestore={editor}
          onClose={() => setDialog(null)}
          onRestore={(version) => {
            setDialog(null);
            void run(t("Restoring"), () => tool("restore_version", { deck_id: id, version }));
          }}
        />
      )}
      {dialog === "export" && pending && (
        <ExportWithErrors
          errors={lintErrors}
          onClose={() => setDialog(null)}
          onExport={async (reason) => {
            setDialog(null);
            await exportAll(pending, reason);
          }}
        />
      )}
      {dialog === "m365" && m365 && (
        <SaveToM365
          status={m365}
          deck_id={id}
          errors={d.errors.length}
          pdfOnly
          onClose={() => setDialog(null)}
          onShareTeams={(url) => {
            setTeamsFile(url);
            setDialog("teams");
          }}
        />
      )}
      {dialog === "teams" && m365 && <ShareToTeams status={m365} deck_id={id} file_url={teamsFile} onClose={() => setDialog(null)} />}
      {adding && <AddToLibrary deck_id={id} slide_id={adding.id} number={adding.number} manages={manages} onClose={() => setAdding(null)} onAdded={() => setPanel("library")} />}
      {code && (
        <Dialog title={code.filename} wide onClose={() => setCode(null)}>
          <CodeBlock className="min-w-0">
            <CodeBlockHead>
              <CodeBlockFilename>{code.filename}</CodeBlockFilename>
              <CodeBlockCopyButton value={code.code} />
            </CodeBlockHead>
            <CodeBlockBody className="max-h-[60vh] text-xs leading-relaxed whitespace-pre">{code.code}</CodeBlockBody>
          </CodeBlock>
        </Dialog>
      )}
      {adapt && formats && (
        <Dialog title={t("Adapt {id} to another format", { id: adapt.artboard })} onClose={() => setAdapt(null)}>
          <div className="cq-dialog-body">
            <select className="cq-select" aria-label={t("Format")} value={adapt.format} onChange={(e) => setAdapt({ ...adapt, format: e.target.value })}>
              {formats.formats.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label} · {f.width}×{f.height}
                </option>
              ))}
            </select>
            <p className="cq-hint">{t("A copy on the new canvas: auto layout reflows, type follows the format. Check its lint after.")}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdapt(null)}>
              {t("Cancel")}
            </Button>
            <Button
              disabled={!adapt.format}
              onClick={() => {
                const taken = new Set(d.artboards.map((b) => b.id));
                let nid = `${adapt.artboard}_${adapt.format}`;
                for (let k = 2; taken.has(nid); k++) nid = `${adapt.artboard}_${adapt.format}_${k}`;
                setAdapt(null);
                void patch(t("Adapt to {format}", { format: label(adapt.format) }), [{ op: "adapt_artboard", artboard: adapt.artboard, id: nid, format: adapt.format }]);
              }}
            >
              <Copy /> {t("Adapt")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

/** The artboard's nodes as click targets over its image, in its own pixel space: the smaller boxes
on top, so a text inside a frame is the one picked. */
function Hits({ board, commented, onPick }: { board: Artboard; commented: Set<string>; onPick: (node: string) => void }) {
  const boxes = Object.entries(board.boxes ?? {})
    .filter(([node, b]) => node !== board.id && b.w > 0 && b.h > 0)
    .sort(([, a], [, b]) => b.w * b.h - a.w * a.h);
  return (
    <svg className="cq-board-hits" viewBox={`0 0 ${board.width} ${board.height}`} preserveAspectRatio="none" aria-label={t("Elements of {id}", { id: board.id })}>
      {boxes.map(([node, b]) => (
        <rect
          key={node}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          role="button"
          tabIndex={0}
          aria-label={t("Open {id}", { id: node })}
          data-commented={commented.has(node) || undefined}
          onClick={() => onPick(node)}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onPick(node))}
        >
          <title>{node}</title>
        </rect>
      ))}
    </svg>
  );
}

/** A one-field form: a comment (optionally required: it blocks approval) or a reply. */
function Composer({ label, onSend, compact, required }: { label: string; onSend: (text: string, required: boolean) => void; compact?: boolean; required?: boolean }) {
  const [text, setText] = useState("");
  const [blocks, setBlocks] = useState(false);
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onSend(text.trim(), blocks);
    setText("");
    setBlocks(false);
  };
  return (
    <form className="cq-composer-line" onSubmit={send}>
      <Input aria-label={label} placeholder={compact ? t("Reply") : t("Add a comment")} value={text} onChange={(e) => setText(e.target.value)} />
      {required && (
        <label className="cq-hint cq-required">
          <Checkbox checked={blocks} onCheckedChange={(v: boolean) => setBlocks(v === true)} aria-label={t("Required: blocks approval until resolved")} /> {t("Required")}
        </label>
      )}
      <Button type="submit" size="sm" variant="outline" disabled={!text.trim()}>
        <MessageSquare /> {compact ? t("Reply") : t("Comment")}
      </Button>
    </form>
  );
}

function Threads(props: {
  label: string;
  threads: Comment[];
  onNode: (node: string) => void;
  onReply: ((c: Comment, text: string) => void) | undefined;
  onResolve: (c: Comment) => (() => void) | undefined;
}) {
  if (!props.threads.length) return null;
  const who = (c: Comment) => c.author_name ?? c.author;
  return (
    <ul className="cq-threads" aria-label={props.label}>
      {props.threads.map((c) => {
        const resolve = props.onResolve(c);
        return (
          <li key={c.id}>
            <p className="cq-thread-head">
              <strong>{who(c)}</strong> · {ago(c.created_at)}
              {c.type === "required" && <Tag tone="danger">{t("Required")}</Tag>}
              {c.node && (
                <button type="button" className="cq-mono" onClick={() => props.onNode(c.node as string)}>
                  {c.node}
                </button>
              )}
              {resolve && (
                <Button size="sm" variant="ghost" onClick={resolve}>
                  <Check /> {t("Resolve")}
                </Button>
              )}
            </p>
            <p>{c.text}</p>
            {(c.replies ?? []).map((r) => (
              <p key={r.id} className="cq-thread-reply">
                <strong>{who(r)}</strong> {r.text}
              </p>
            ))}
            {props.onReply && <Composer compact label={t("Reply to {name}", { name: who(c) })} onSend={(text) => props.onReply?.(c, text)} />}
          </li>
        );
      })}
    </ul>
  );
}

/** A node picked on an artboard: change its text (editors, for a text the page can edit), comment on it. */
function NodeDialog(props: {
  node: string;
  target: ReturnType<typeof textTarget>;
  threads: Comment[];
  onClose: () => void;
  onSave: (ops: unknown[]) => void;
  onComment: ((text: string) => void) | undefined;
}) {
  const [text, setText] = useState(props.target?.text ?? "");
  const [note, setNote] = useState("");
  const target = props.target;
  return (
    <Dialog title={props.node} onClose={props.onClose}>
      <div className="cq-dialog-body">
        {target ? (
          <Field label={t("Text")} htmlFor="n-text" hint={t("Saved as a new version; the design is laid out and checked again.")}>
            <Textarea id="n-text" autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        ) : (
          <p className="cq-hint">{t("Not a text you can edit here: ask the agent, or comment so an editor sees it.")}</p>
        )}
        {props.threads.map((c) => (
          <p key={c.id} className="cq-thread-reply">
            <strong>{c.author_name ?? c.author}</strong> {c.text}
          </p>
        ))}
        {props.onComment && (
          <Field label={t("Comment")} htmlFor="n-note">
            <Textarea id="n-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={props.onClose}>
          {t("Cancel")}
        </Button>
        {props.onComment && (
          <Button variant="outline" disabled={!note.trim()} onClick={() => props.onComment?.(note.trim())}>
            <MessageSquare /> {t("Comment")}
          </Button>
        )}
        {target && (
          <Button disabled={!text.trim() || text === target.text} onClick={() => props.onSave(target.ops(text))}>
            <Check /> {t("Save")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
