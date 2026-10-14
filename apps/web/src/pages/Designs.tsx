// Designs: social posts, stories, banners, ads, posters, web sections (DesignSpec, docs/adr/0002).
// The list, and one design: its artboards as rendered by the engine, their lint, the token mode,
// adapting an artboard to another format, undo, the exports, editing a text in place, comments on
// an artboard or one of its nodes, and sharing. Every change is a tool call.
import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { Card, CardContent, CardHeader } from "diametral-ds/card";
import { CodeBlock, CodeBlockBody, CodeBlockCopyButton, CodeBlockFilename, CodeBlockHead } from "diametral-ds/code-block";
import { DialogFooter } from "diametral-ds/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "diametral-ds/empty";
import { Tag } from "diametral-ds/tag";
import { ToggleGroup, ToggleGroupItem } from "diametral-ds/toggle-group";
import { Input } from "diametral-ds/input";
import { Textarea } from "diametral-ds/textarea";
import { ArrowLeft, Check, Code, Copy, Download, MessageSquare, Plus, Shapes, Share2, Trash2, Undo2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { tool } from "../api.ts";
import { t, tn } from "../i18n.ts";
import { go } from "../nav.ts";
import { ago, Dialog, Field, PageHead, Spinner } from "../ui.tsx";

const BASE = import.meta.env.BASE_URL;
/** The toggle's value for the pack's base values (no mode). */
const BASE_MODE = "__base";

export interface DesignRow {
  design_id: string;
  title: string;
  pack_id: string;
  version: number;
  cover: string | null;
  artboards: number;
  updated_at: string;
  owner?: string;
  role?: Role;
}

type Role = "viewer" | "commenter" | "editor" | "owner";
const RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };
const ROLE_LABEL = { viewer: "Viewer", commenter: "Commenter", editor: "Editor", owner: "Owner" } as const;
const can = (role: Role | undefined, need: Role) => RANK[role ?? "viewer"] >= RANK[need];

interface Comment {
  id: number;
  artboard: string;
  node: string | null;
  text: string;
  author: string;
  author_name: string | null;
  status: "open" | "resolved";
  created_at: string;
  replies?: Comment[];
}

interface Finding {
  severity: "ERROR" | "WARN";
  artboard: string | null;
  node: string | null;
  check?: string;
  message: string;
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
  version: number;
  head: number;
  artboards: Artboard[];
  errors: Finding[];
  warnings: Finding[];
  spec: Spec;
  role: Role;
  /** the caller's user id: a commenter resolves their own threads */
  me: string;
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

/** A rendered artboard, read with the session like the deck previews. */
const png = (id: string, artboard: string, version: number) => `${BASE}designs/${id}/${artboard}.png?v=${version}`;

export function Designs() {
  const [rows, setRows] = useState<DesignRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    tool<{ designs: DesignRow[] }>("list_designs").then(
      (r) => setRows(r.designs),
      (e) => setError((e as Error).message),
    );
  }, []);
  return (
    <div className="cq-page">
      <PageHead title={t("Designs")} description={t("Social posts, stories, banners, ads, posters and web sections on your brand packs.")}>
        <Button onClick={(e) => go(e, "/designs/new")}>
          <Plus /> {t("New design")}
        </Button>
      </PageHead>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!rows && !error && <Spinner label={t("Loading designs")} />}
      {rows?.length === 0 && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Shapes />
            </EmptyMedia>
            <EmptyTitle>{t("No design yet")}</EmptyTitle>
            <EmptyDescription>{t("Brief the agent with New design: it lays the design out on your brand pack, checks it and saves it here.")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {!!rows?.length && (
        <ul className="cq-deck-grid">
          {rows.map((d) => (
            <li key={d.design_id} className="cq-deck-item">
              <a className="cq-deck-card" href={`/designs/${d.design_id}`} onClick={(e) => go(e, `/designs/${d.design_id}`)}>
                <span className="cq-deck-cover cq-design-cover">{d.cover && <img src={png(d.design_id, d.cover, d.version)} alt="" loading="lazy" />}</span>
                <span className="cq-deck-info">
                  <strong>{d.title}</strong>
                  <span>
                    {d.pack_id} · {tn(d.artboards, "{n} artboard", "{n} artboards")} · v{d.version} · {ago(d.updated_at)}
                  </span>
                  {d.role && d.role !== "owner" && (
                    <span>
                      {t(ROLE_LABEL[d.role])} · {t("from {owner}", { owner: d.owner ?? "" })}
                    </span>
                  )}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const TONE = { ERROR: "danger", WARN: "warning" } as const;

function FindingCard({ f }: { f: Finding }) {
  return (
    <Card size="sm" role="listitem">
      <CardHeader className="flex flex-wrap items-center gap-2">
        <Tag tone={TONE[f.severity]}>{f.severity}</Tag>
        {f.node && <span className="cq-mono text-sm">{f.node}</span>}
        {f.check && <span className="cq-mono ml-auto text-xs text-muted-foreground">{f.check}</span>}
      </CardHeader>
      <CardContent className="text-sm">{f.message}</CardContent>
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

export function DesignEditor({ id }: { id: string }) {
  const [d, setD] = useState<DesignView | null>(null);
  const [formats, setFormats] = useState<Formats | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<{ filename: string; code: string } | null>(null);
  const [adapt, setAdapt] = useState<{ artboard: string; format: string } | null>(null);
  // the node clicked on an artboard: edit its text, comment on it
  const [picked, setPicked] = useState<{ artboard: string; node: string } | null>(null);
  const [sharing, setSharing] = useState(false);

  const open = () => tool<DesignView>("open_design", { design_id: id }).then(setD);
  useEffect(() => {
    open().catch((e) => setError((e as Error).message));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (d?.pack_id) tool<Formats>("list_formats", { pack_id: d.pack_id }).then(setFormats, () => setFormats(null));
  }, [d?.pack_id]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setError(null);
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  // a change returns the new version's renders and lint; open_design adds the spec and history
  const patch = (label: string, ops: unknown[]) => run(label, async () => (await tool("patch_design", { design_id: id, ops, note: label }), await open()));
  const undo = () => run(t("Undoing"), async () => (await tool("restore_design", { design_id: id }), await open()));
  const exportAll = (e: (typeof EXPORTS)[number]) =>
    run(t("Exporting {format}", { format: e.label }), async () => {
      const r = await tool<{ files: { url: string }[] }>("export_design", { design_id: id, ...e.args });
      download(r.files.map((f) => f.url));
    });
  const comment = (artboard: string, node: string | null, text: string) =>
    run(t("Commenting"), async () => (await tool("add_design_comment", { design_id: id, artboard, ...(node ? { node } : {}), text }), await open()));
  const reply = (parent_id: number, text: string) =>
    run(t("Commenting"), async () => (await tool("add_design_comment", { design_id: id, parent_id, text }), await open()));
  const resolve = (c: Comment) => run(t("Resolving"), async () => (await tool("resolve_design_comments", { design_id: id, ids: [c.id] }), await open()));
  const exportCode = (artboard: string, format: "react" | "tailwind") =>
    run(t("Exporting {format}", { format }), async () => setCode(await tool<{ filename: string; code: string }>("export_design", { design_id: id, format, artboard })));

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

  const label = (format: string) => formats?.formats.find((f) => f.id === format)?.label ?? format;
  const findings = (artboard: string) => [...d.errors, ...d.warnings].filter((f) => f.artboard === artboard);
  const deckWide = [...d.errors, ...d.warnings].filter((f) => !f.artboard);
  const mode = d.spec.mode ?? "";
  const editor = can(d.role, "editor");
  const commenter = can(d.role, "commenter");
  const threads = (artboard: string, node?: string) =>
    d.open_comments.filter((c) => c.artboard === artboard && (node === undefined || c.node === node));
  const mayResolve = (c: Comment) => editor || (commenter && c.author === d.me);

  return (
    <div className="cq-page cq-design">
      <PageHead
        title={d.title}
        description={`${d.pack_id} · v${d.version} · ${tn(d.errors.length, "{n} error", "{n} errors")} · ${tn(d.warnings.length, "{n} warning", "{n} warnings")}`}
      >
        <Button variant="ghost" onClick={(e) => go(e, "/designs")}>
          <ArrowLeft /> {t("Designs")}
        </Button>
        {d.role === "owner" && (
          <Button variant="outline" onClick={() => setSharing(true)}>
            <Share2 /> {t("Share")}
          </Button>
        )}
        {editor && (
          <Button variant="outline" disabled={!!busy || d.head < 2} onClick={() => void undo()}>
            <Undo2 /> {t("Undo")}
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
        <span className="cq-design-exports">
          <Download aria-hidden />
          {EXPORTS.map((e) => (
            <Button key={e.id} size="sm" variant="outline" disabled={!!busy} onClick={() => void exportAll(e)}>
              {e.label}
            </Button>
          ))}
        </span>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {busy && <Spinner label={busy} />}
      {deckWide.length > 0 && (
        <div role="list" className="cq-findings">
          {deckWide.map((f, i) => (
            <FindingCard key={i} f={f} />
          ))}
        </div>
      )}

      {d.artboards.map((a) => {
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
                {editor && (
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setAdapt({ artboard: a.id, format: formats?.formats.find((f) => f.id !== a.format)?.id ?? "" })}>
                    <Copy /> {t("Adapt to…")}
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
                  <img src={png(d.design_id, a.id, d.version)} alt={t("Artboard {id}", { id: a.id })} width={a.width} height={a.height} />
                  <Hits board={a} commented={new Set(threads(a.id).map((c) => c.node ?? ""))} onPick={(node) => setPicked({ artboard: a.id, node })} />
                </span>
              </div>
              <div className="cq-board-side">
                <div role="list" className="cq-findings" aria-label={t("Checks for {id}", { id: a.id })}>
                  {fs.length === 0 ? <p className="cq-hint">{t("No issue found.")}</p> : fs.map((f, i) => <FindingCard key={i} f={f} />)}
                </div>
                <Threads
                  label={t("Comments on {id}", { id: a.id })}
                  threads={threads(a.id)}
                  onNode={(node) => setPicked({ artboard: a.id, node })}
                  onReply={commenter ? (c, text) => void reply(c.id, text) : undefined}
                  onResolve={(c) => (mayResolve(c) ? () => void resolve(c) : undefined)}
                />
                {commenter && <Composer label={t("Comment on {id}", { id: a.id })} onSend={(text) => void comment(a.id, null, text)} />}
              </div>
            </div>
          </section>
        );
      })}

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
      {sharing && <ShareDesign id={id} onClose={() => setSharing(false)} />}
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
                for (let i = 2; taken.has(nid); i++) nid = `${adapt.artboard}_${adapt.format}_${i}`;
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

/** A one-field form: a comment or a reply. */
function Composer({ label, onSend, compact }: { label: string; onSend: (text: string) => void; compact?: boolean }) {
  const [text, setText] = useState("");
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onSend(text.trim());
    setText("");
  };
  return (
    <form className="cq-composer-line" onSubmit={send}>
      <Input aria-label={label} placeholder={compact ? t("Reply") : t("Add a comment")} value={text} onChange={(e) => setText(e.target.value)} />
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

interface ShareRow {
  principal_type: "user" | "team";
  principal: string;
  role: Exclude<Role, "owner">;
}

/** Who has access to a design (owner only): people and teams, each with a role. */
function ShareDesign({ id, onClose }: { id: string; onClose: () => void }) {
  const [rows, setRows] = useState<ShareRow[] | null>(null);
  const [type, setType] = useState<ShareRow["principal_type"]>("user");
  const [who, setWho] = useState("");
  const [role, setRole] = useState<ShareRow["role"]>("commenter");
  const [error, setError] = useState<string | null>(null);
  const load = () => tool<{ shares: ShareRow[] }>("list_design_shares", { design_id: id }).then((r) => setRows(r.shares));
  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    fn()
      .then(load)
      .catch((e) => setError((e as Error).message));
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    act(async () => {
      await tool("share_design", { design_id: id, principal_type: type, principal: who.trim(), role });
      setWho("");
    });
  };
  return (
    <Dialog title={t("Share design")} onClose={onClose}>
      <div className="cq-dialog-body">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <form className="cq-share-add" onSubmit={add}>
          <select className="cq-select" aria-label={t("Share with")} value={type} onChange={(e) => setType(e.target.value as ShareRow["principal_type"])}>
            <option value="user">{t("Person")}</option>
            <option value="team">{t("Team")}</option>
          </select>
          <Input aria-label={type === "user" ? t("User id") : t("Team id")} placeholder={type === "user" ? t("User id") : t("Team id")} value={who} onChange={(e) => setWho(e.target.value)} />
          <select className="cq-select" aria-label={t("Role")} value={role} onChange={(e) => setRole(e.target.value as ShareRow["role"])}>
            {(["viewer", "commenter", "editor"] as const).map((r) => (
              <option key={r} value={r}>
                {t(ROLE_LABEL[r])}
              </option>
            ))}
          </select>
          <Button type="submit" disabled={!who.trim()}>
            <Plus /> {t("Add")}
          </Button>
        </form>
        {!rows && !error && <Spinner label={t("Loading")} />}
        {rows?.length === 0 && <p className="cq-hint">{t("Only you have access.")}</p>}
        {!!rows?.length && (
          <ul className="cq-share-list">
            {rows.map((r) => (
              <li key={`${r.principal_type}:${r.principal}`}>
                <span>
                  {r.principal_type === "team" ? t("Team") : t("Person")} <strong>{r.principal}</strong>
                </span>
                <span>{t(ROLE_LABEL[r.role])}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("Remove {name}", { name: r.principal })}
                  onClick={() => act(() => tool("unshare_design", { design_id: id, principal_type: r.principal_type, principal: r.principal }))}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
