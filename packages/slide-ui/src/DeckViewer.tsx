import { Check, ChevronLeft, ChevronRight, MessageSquare, MessageSquarePlus, Reply, RotateCcw, Sparkles, SquareDashed, X } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { shapeLabel, SlideCanvas } from "./SlideCanvas.tsx";
import { Thumbnails } from "./Thumbnails.tsx";
import type { Comment, DeckView, NewComment, NewReply, SlideView } from "./types.ts";

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;
const APPROVAL = { draft: "Draft", in_review: "In review", approved: "Approved" } as const;
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** The deck workspace: top bar, slide rail, stage (preview + inspector + comment box) and a side panel
with the open comments, plus the host's agent when it has one. Comments anchor on the slide id and,
if one is picked, a shape_id. */
export function DeckViewer(props: {
  deck: DeckView;
  /** Post a comment; without it (a viewer) there is no comment box. */
  onComment?: (c: NewComment) => Promise<void>;
  /** Hand the open comments to the agent (MCP Apps: a message to the model): the ids picked, or
  every open comment (no ids). */
  onApply?: (ids?: number[]) => Promise<void>;
  /** Reply in a comment's thread; without it there is no Reply button. */
  onReply?: (r: NewReply) => Promise<void>;
  /** Resolve or reopen comment threads one by one, without the agent. */
  onResolve?: (ids: number[], status: "open" | "resolved") => Promise<void>;
  /** The host's own actions, right of the title (web: lint, history, present, export). */
  actions?: ReactNode;
  /** The host's agent chat, shown in a tab next to Comments (web app only). */
  agent?: ReactNode;
  /** The host's other side-panel tabs, after Comments (web: the slide library). */
  tabs?: { id: string; label: string; icon?: ReactNode; content: ReactNode }[];
  /** The host's actions on the slide shown, in the bar above it (web: add it to the library). */
  slideActions?: (slide: SlideView) => ReactNode;
  /** What the agent is doing to the deck right now, shown over the slide. */
  working?: string | null;
}) {
  const { deck } = props;
  const [current, setCurrent] = useState(0);
  const [shape, setShape] = useState<number | null>(null);
  const [text, setText] = useState("");
  // a required comment blocks the deck's approval until resolved
  const [required, setRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outline, setOutline] = useState(false);
  // open comments win the first look: after a reload, Apply and the threads are where they were
  const [tab, setTab] = useState<string>(props.agent && !deck.open_comments.length ? "agent" : "comments");
  const last = deck.slides.length - 1;
  const index = Math.min(current, last);
  const slide = deck.slides[index];

  const go = (i: number) => {
    setCurrent(Math.max(0, Math.min(i, last)));
    setShape(null);
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector("dialog[open]")) return;
      if (e.key === "Escape") return setShape(null); // no preventDefault: Esc keeps its other jobs
      if (e.key === "ArrowDown" || e.key === "ArrowRight") setCurrent((n) => Math.min(n + 1, last));
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") setCurrent((n) => Math.max(n - 1, 0));
      else return;
      setShape(null);
      e.preventDefault();
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [last]);

  if (!slide) return <div className="cq-empty">Empty deck.</div>;
  const here = deck.open_comments.filter((c) => c.slide_id === slide.id);
  const picked = shape !== null ? slide.shapes.find((s) => s.shape_id === shape) : undefined;
  const open = deck.open_comments.length;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!text.trim() || !slide || !props.onComment) return;
    setBusy(true);
    try {
      await props.onComment({ slide_id: slide.id, ...(shape !== null ? { shape_id: shape } : {}), text: text.trim(), ...(required ? { type: "required" as const } : {}) });
      setText("");
      setRequired(false);
      setTab("comments");
    } finally {
      setBusy(false);
    }
  }

  const comments = (
    <Comments
      deck={deck}
      current={slide.id}
      selected={shape}
      onPick={(slideId, shapeId) => {
        setCurrent(deck.slides.findIndex((s) => s.id === slideId));
        setShape(shapeId);
      }}
      {...(props.onApply ? { onApply: props.onApply } : {})}
      {...(props.onReply ? { onReply: props.onReply } : {})}
      {...(props.onResolve ? { onResolve: props.onResolve } : {})}
    />
  );

  return (
    <div className="cq-workspace">
      <header className="cq-bar">
        <div className="cq-bar-title">
          <h1>{deck.title}</h1>
          <span>
            {deck.pack_id} · v{deck.version}
            {deck.approval?.enabled && (
              <>
                {" · "}
                <span className="cq-approval" data-status={deck.approval.status}>
                  {APPROVAL[deck.approval.status]}
                </span>
              </>
            )}
          </span>
        </div>
        <div className="cq-bar-actions">{props.actions}</div>
      </header>

      <Thumbnails slides={deck.slides} current={index} comments={deck.open_comments} onSelect={go} />

      <section className="cq-stage" aria-label="Slide">
        <div className="cq-stagebar">
          <button type="button" className="cq-btn" data-variant="ghost" data-icon data-size="sm" aria-label="Previous slide" disabled={index === 0} onClick={() => go(index - 1)}>
            <ChevronLeft />
          </button>
          <span className="cq-pos">
            {slide.number} / {deck.slides.length}
          </span>
          <button type="button" className="cq-btn" data-variant="ghost" data-icon data-size="sm" aria-label="Next slide" disabled={index === last} onClick={() => go(index + 1)}>
            <ChevronRight />
          </button>
          <span className="cq-spacer" />
          {props.onComment && <span className="cq-stagebar-hint">Click an element to comment on it</span>}
          {props.slideActions?.(slide)}
          <button
            type="button"
            className="cq-btn"
            data-variant="ghost"
            data-size="sm"
            aria-pressed={outline}
            title="Outline every shape"
            onClick={() => setOutline((o) => !o)}
          >
            <SquareDashed /> Shapes
          </button>
        </div>
        <div className="cq-stage-view">
          <SlideCanvas slide={slide} selected={shape} comments={here} outline={outline} onSelect={setShape} />
          {props.working && (
            <div className="cq-working" role="status">
              <div>
                <Sparkles /> <span className="cq-shimmer">{props.working}…</span>
              </div>
            </div>
          )}
        </div>
        {props.onComment && (
          <form onSubmit={submit} className="cq-comment">
            <div>
              <span className="cq-anchor">
                <MessageSquarePlus />
                <span>
                  Slide {slide.number}
                  {picked && (
                    <>
                      {" · "}
                      <b>{shapeLabel(picked)}</b> <span className="cq-mono">#{picked.shape_id}</span>
                    </>
                  )}
                  {!picked && <span className="cq-muted"> · whole slide</span>}
                </span>
                {picked && (
                  <button type="button" aria-label="Comment on the whole slide" onClick={() => setShape(null)}>
                    <X size={14} />
                  </button>
                )}
              </span>
              <div className="cq-comment-row">
                <textarea
                  aria-label={`Comment on slide ${slide.number}${shape !== null ? `, shape ${shape}` : ""}`}
                  placeholder={picked ? `What should change in this ${shapeLabel(picked)}?` : "What should change on this slide?"}
                  value={text}
                  rows={1}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
                <label className="cq-comment-type" title="A required comment blocks the deck's approval until it is resolved">
                  <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required
                </label>
                <button type="submit" className="cq-btn" data-variant="primary" data-size="sm" disabled={busy || !text.trim()}>
                  Comment
                </button>
              </div>
            </div>
          </form>
        )}
      </section>

      <aside className="cq-panel" aria-label="Side panel">
        <div className="cq-panel-head">
          <div className="cq-tabs" role="tablist">
            {props.agent && (
              <button type="button" role="tab" aria-selected={tab === "agent"} onClick={() => setTab("agent")}>
                <Sparkles /> Agent
              </button>
            )}
            <button type="button" role="tab" aria-selected={tab === "comments"} onClick={() => setTab("comments")}>
              <MessageSquare /> Comments {open > 0 && <span className="cq-count">{open}</span>}
            </button>
            {props.tabs?.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="cq-panel-body">
          {props.agent && (
            <div role="tabpanel" aria-label="Agent" hidden={tab !== "agent"}>
              {props.agent}
            </div>
          )}
          <div role="tabpanel" aria-label="Comments" hidden={tab !== "comments"}>
            {comments}
          </div>
          {props.tabs?.map((t) => (
            <div key={t.id} role="tabpanel" aria-label={t.label} hidden={tab !== t.id}>
              {t.content}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

const who = (c: Comment) => c.author_name || c.author;

/** Every open comment thread, grouped by slide, with its replies; each one can be replied to,
resolved, or picked for the agent. The foot button hands the picked threads (else all) to the agent.
Resolved threads stay one click away, to reopen. */
function Comments(props: {
  deck: DeckView;
  current: string;
  selected: number | null;
  onPick: (slideId: string, shapeId: number | null) => void;
  onApply?: (ids?: number[]) => Promise<void>;
  onReply?: (r: NewReply) => Promise<void>;
  onResolve?: (ids: number[], status: "open" | "resolved") => Promise<void>;
}) {
  const { deck } = props;
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [replying, setReplying] = useState<number | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const open = deck.open_comments.length;
  const resolved = deck.resolved_comments ?? [];
  // only threads still open count: one resolved meanwhile drops out of the selection
  const chosen = deck.open_comments.filter((c) => picked.has(c.id)).map((c) => c.id);
  const groups = deck.slides.map((s) => ({ slide: s, items: deck.open_comments.filter((c) => c.slide_id === s.id) })).filter((g) => g.items.length);

  const toggle = (id: number) =>
    setPicked((p) => {
      const n = new Set(p);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }
  async function send(e: FormEvent, parent_id: number) {
    e.preventDefault();
    if (!reply.trim() || !props.onReply) return;
    const onReply = props.onReply;
    await act(async () => {
      await onReply({ parent_id, text: reply.trim() });
      setReply("");
      setReplying(null);
    });
  }

  return (
    <div className="cq-comments">
      <div className="cq-comments-list">
        {groups.length === 0 && (
          <div className="cq-empty">
            <MessageSquare />
            <strong>No open comment</strong>
            <span>Click an element on the slide, say what should change, then let the agent apply it.</span>
          </div>
        )}
        {groups.map(({ slide, items }) => (
          <section key={slide.id}>
            <h3>Slide {slide.number}</h3>
            <ul>
              {items.map((c) => {
                const s = c.shape_id !== null ? slide.shapes.find((x) => x.shape_id === c.shape_id) : undefined;
                return (
                  <li key={c.id}>
                    <button type="button" aria-current={slide.id === props.current && c.shape_id === props.selected && c.shape_id !== null} onClick={() => props.onPick(slide.id, c.shape_id)}>
                      <span className="cq-comment-meta">
                        <b>{who(c)}</b>
                        {c.type === "required" && <span className="cq-required">Required</span>}
                        <span>·</span>
                        {s ? (
                          <span>
                            {shapeLabel(s)} <span className="cq-mono">#{s.shape_id}</span>
                          </span>
                        ) : (
                          <span>whole slide</span>
                        )}
                      </span>
                      <span>{c.text}</span>
                    </button>
                    {!!c.replies?.length && (
                      <ol className="cq-replies" aria-label={`Replies to comment ${c.id}`}>
                        {c.replies.map((r) => (
                          <li key={r.id}>
                            <b>{who(r)}</b> {r.text}
                          </li>
                        ))}
                      </ol>
                    )}
                    {(props.onApply || props.onReply || props.onResolve) && (
                      <div className="cq-comment-actions">
                        {props.onApply && (
                          <label>
                            <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select comment ${c.id}`} /> Select
                          </label>
                        )}
                        <span className="cq-spacer" />
                        {props.onReply && (
                          <button type="button" className="cq-btn" data-variant="ghost" data-size="sm" aria-label={`Reply to comment ${c.id}`} onClick={() => setReplying(replying === c.id ? null : c.id)}>
                            <Reply /> Reply
                          </button>
                        )}
                        {props.onResolve && (
                          <button
                            type="button"
                            className="cq-btn"
                            data-variant="ghost"
                            data-size="sm"
                            aria-label={`Resolve comment ${c.id}`}
                            disabled={busy}
                            onClick={() => void act(() => props.onResolve?.([c.id], "resolved") ?? Promise.resolve())}
                          >
                            <Check /> Resolve
                          </button>
                        )}
                      </div>
                    )}
                    {replying === c.id && (
                      <form className="cq-reply" onSubmit={(e) => void send(e, c.id)}>
                        <textarea aria-label={`Reply to comment ${c.id}`} rows={2} value={reply} placeholder="Reply…" onChange={(e) => setReply(e.target.value)} />
                        <button type="submit" className="cq-btn" data-variant="primary" data-size="sm" disabled={busy || !reply.trim()}>
                          Send
                        </button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {resolved.length > 0 && (
          <section className="cq-resolved">
            <button type="button" className="cq-btn" data-variant="ghost" data-size="sm" aria-expanded={showResolved} onClick={() => setShowResolved((v) => !v)}>
              {plural(resolved.length, "resolved comment")}
            </button>
            {showResolved && (
              <ul>
                {resolved.map((c) => (
                  <li key={c.id}>
                    <span className="cq-comment-meta">
                      <b>{who(c)}</b>
                      <span>·</span>
                      <span>Slide {deck.slides.find((s) => s.id === c.slide_id)?.number ?? "?"}</span>
                    </span>
                    <span>{c.text}</span>
                    {props.onResolve && (
                      <button
                        type="button"
                        className="cq-btn"
                        data-variant="ghost"
                        data-size="sm"
                        aria-label={`Reopen comment ${c.id}`}
                        disabled={busy}
                        onClick={() => void act(() => props.onResolve?.([c.id], "open") ?? Promise.resolve())}
                      >
                        <RotateCcw /> Reopen
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
      {props.onApply && open > 0 && (
        <div className="cq-comments-foot">
          <button type="button" className="cq-btn" data-variant="accent" onClick={() => void props.onApply?.(chosen.length ? chosen : undefined)}>
            <Sparkles /> {chosen.length ? `Apply ${chosen.length} selected` : `Apply ${plural(open, "comment")}`}
          </button>
          <span className="cq-hint">
            {chosen.length ? "The agent edits the deck for the selected comments only." : "The agent edits the deck, then resolves each comment."}
          </span>
        </div>
      )}
    </div>
  );
}
