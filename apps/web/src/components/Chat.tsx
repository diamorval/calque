import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { Kbd } from "diametral-ds/kbd";
import { ArrowUp, Check, Paperclip, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { agent, upload } from "../api.ts";

/** A file attached to the conversation, uploaded to /api/files. */
interface Attached {
  file_id: string;
  name: string;
}
const ACCEPT = "image/*,.pptx,.pdf,.docx,.xlsx,.csv,.txt,.md";

/** An AI SDK model message, as the server returns them; the client keeps the conversation. */
export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string | { type: string; text?: string; toolName?: string }[];
}
/** A message sent from outside the composer (a toolbar action), with the workflow it runs. */
export interface Ask {
  text: string;
  workflow?: "draft-slides" | "edit-slides" | "review-deck";
}
export interface AgentResult {
  model: string;
  text: string;
  messages: ChatMessage[];
}

const load = <T = ChatMessage,>(key: string): T[] => {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "[]");
  } catch {
    return [];
  }
};
export const saveChat = (key: string, messages: unknown[]) => {
  try {
    sessionStorage.setItem(key, JSON.stringify(messages));
  } catch {
    // storage full or blocked: the conversation lives in memory only
  }
};

function lines(m: ChatMessage): { text: string; tools: string[] } {
  if (typeof m.content === "string") return { text: m.content, tools: [] };
  return {
    text: m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n"),
    tools: m.content.filter((p) => p.type === "tool-call").map((p) => p.toolName ?? ""),
  };
}

/** The tools the agent called, one row each; the last one live while it runs. */
function Trace({ tools, live }: { tools: string[]; live?: boolean }) {
  return (
    <ul className="cq-trace">
      {tools.map((t, i) => (
        <li key={i}>
          <Check /> <span className="cq-mono">{t}</span>
        </li>
      ))}
      {live && (
        <li data-live>
          <span className="cq-spinner" /> <span className="cq-shimmer">{tools.length ? "Working" : "Thinking"}</span>
        </li>
      )}
    </ul>
  );
}

/** The co-editing chat. `storageKey` keeps the conversation across reloads of this tab. */
export function Chat(props: {
  storageKey: string;
  pack_id?: string | undefined;
  deck_id?: string | undefined;
  placeholder: string;
  disabled?: boolean;
  /** Shown while the conversation is empty. */
  empty?: ReactNode;
  /** One-click briefs, while the conversation is empty. */
  suggestions?: string[];
  /** Left of the send button (the new deck's brand pack). */
  footer?: ReactNode;
  /** Sent as soon as it changes; its workflow stays on for the replies that follow. */
  ask?: Ask | null;
  /** `conversation`: every message so far, the agent's included */
  onDone?: (r: AgentResult, conversation: ChatMessage[]) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => load(props.storageKey));
  const [text, setText] = useState("");
  const [steps, setSteps] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<Ask["workflow"]>();
  // sent with every turn, so the agent keeps them as context; `pending` go with the next message
  const [files, setFiles] = useState<Attached[]>(() => load<Attached>(`${props.storageKey}:files`));
  const [pending, setPending] = useState<Attached[]>([]);
  const [uploading, setUploading] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => saveChat(props.storageKey, messages), [props.storageKey, messages]);
  useEffect(() => saveChat(`${props.storageKey}:files`, files), [props.storageKey, files]);

  async function attach(list: FileList | null) {
    if (!list?.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of Array.from(list)) {
        const form = new FormData();
        form.append("file", f);
        const r = await upload<Attached>("/api/files", form);
        setPending((p) => [...p, { file_id: r.file_id, name: r.name }]);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      if (picker.current) picker.current.value = "";
    }
  }
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [messages, steps, error]);

  async function send(e?: FormEvent, ask?: Ask) {
    e?.preventDefault();
    const typed = ask?.text ?? text.trim();
    if (!typed || steps || uploading || props.disabled) return;
    const note = pending.length ? `\n\nAttached: ${pending.map((f) => f.name).join(", ")}` : "";
    const asked = [...messages, { role: "user" as const, content: typed + note }];
    const all = [...files, ...pending];
    const flow = ask ? ask.workflow : workflow;
    if (ask) setWorkflow(ask.workflow);
    setMessages(asked);
    setFiles(all);
    setPending([]);
    if (!ask) setText("");
    setSteps([]);
    setError(null);
    try {
      const r = await agent<AgentResult>(
        "/api/agent/chat",
        { messages: asked, pack_id: props.pack_id, deck_id: props.deck_id, workflow: flow, ...(all.length ? { files: all.map((f) => f.file_id) } : {}) },
        (tools) => setSteps((s) => [...(s ?? []), ...tools]),
      );
      const conversation = [...asked, ...r.messages];
      setMessages(conversation);
      setModel(r.model);
      props.onDone?.(r, conversation);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSteps(null);
    }
  }

  useEffect(() => {
    if (props.ask) void send(undefined, props.ask);
  }, [props.ask]); // eslint-disable-line react-hooks/exhaustive-deps

  // one turn per run of assistant messages: the agent's steps, then its answer
  const shown: { role: ChatMessage["role"]; text: string; tools: string[] }[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const { text, tools } = lines(m);
    if (!text && !tools.length) continue;
    const prev = shown.at(-1);
    if (m.role === "assistant" && prev?.role === "assistant") {
      prev.tools.push(...tools);
      prev.text = [prev.text, text].filter(Boolean).join("\n\n");
    } else shown.push({ role: m.role, text, tools: [...tools] });
  }
  return (
    <section className="cq-chat" aria-label="Chat with the agent">
      <div className="cq-chat-log" ref={log}>
        {shown.length === 0 && !steps && props.empty}
        {shown.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="cq-msg" data-role="user">
              {m.text}
            </div>
          ) : (
            <div key={i} className="cq-msg" data-role="assistant">
              <span className="cq-msg-avatar" aria-hidden>
                <Sparkles />
              </span>
              <div>
                {m.tools.length > 0 && <Trace tools={m.tools} />}
                {m.text && <p>{m.text}</p>}
              </div>
            </div>
          ),
        )}
        {steps && (
          <div className="cq-msg" data-role="assistant" role="status" aria-label="The agent is working">
            <span className="cq-msg-avatar" aria-hidden>
              <Sparkles />
            </span>
            <Trace tools={steps} live />
          </div>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
      {shown.length === 0 && !steps && !!props.suggestions?.length && (
        <div className="cq-chips">
          {props.suggestions.map((s) => (
            <Button
              key={s}
              variant="outline"
              size="sm"
              className="cq-chip"
              onClick={() => {
                setText(s);
                input.current?.focus();
              }}
            >
              {s}
            </Button>
          ))}
        </div>
      )}
      <form className="cq-composer" onSubmit={send}>
        <textarea
          ref={input}
          aria-label="Message"
          value={text}
          rows={2}
          placeholder={props.placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {pending.length > 0 && (
          <div className="cq-attached">
            {pending.map((f) => (
              <Button
                key={f.file_id}
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Remove ${f.name}`}
                onClick={() => setPending((p) => p.filter((x) => x !== f))}
              >
                {f.name} <X />
              </Button>
            ))}
          </div>
        )}
        <div className="cq-composer-foot">
          <input ref={picker} type="file" multiple hidden accept={ACCEPT} onChange={(e) => void attach(e.target.files)} />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Attach files"
            title="Attach images, PPTX, PDF, Word, Excel, CSV, text or Markdown"
            disabled={uploading || !!steps || props.disabled}
            onClick={() => picker.current?.click()}
          >
            {uploading ? <span className="cq-spinner" /> : <Paperclip />}
          </Button>
          {props.footer}
          {model && <span className="cq-hint">Model: {model}</span>}
          <span className="cq-spacer" />
          <span className="cq-hint cq-keys">
            <Kbd>↵</Kbd> send · <Kbd>⇧↵</Kbd> new line
          </span>
          <Button type="submit" size="icon" aria-label="Send" disabled={!!steps || uploading || props.disabled || !text.trim()}>
            <ArrowUp />
          </Button>
        </div>
      </form>
    </section>
  );
}
