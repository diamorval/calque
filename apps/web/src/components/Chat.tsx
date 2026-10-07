import { Button, Message, MessageContent, MessageGroup, MessageHeader, Spinner, Textarea } from "@diametral/design-system/react";
import { useEffect, useState, type FormEvent } from "react";
import { agent } from "../api.ts";

/** An AI SDK model message, as the server returns them; the client keeps the conversation. */
export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string | { type: string; text?: string; toolName?: string }[];
}
export interface AgentResult {
  model: string;
  text: string;
  messages: ChatMessage[];
}

const load = (key: string): ChatMessage[] => {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "[]");
  } catch {
    return [];
  }
};
export const saveChat = (key: string, messages: ChatMessage[]) => {
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

/** The co-editing chat. `storageKey` keeps the conversation across reloads of this tab. */
export function Chat(props: {
  storageKey: string;
  pack_id?: string | undefined;
  deck_id?: string | undefined;
  placeholder: string;
  disabled?: boolean;
  /** `conversation`: every message so far, the agent's included */
  onDone?: (r: AgentResult, conversation: ChatMessage[]) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => load(props.storageKey));
  const [text, setText] = useState("");
  const [steps, setSteps] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  useEffect(() => saveChat(props.storageKey, messages), [props.storageKey, messages]);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    const asked = [...messages, { role: "user" as const, content: text.trim() }];
    setMessages(asked);
    setText("");
    setSteps([]);
    setError(null);
    try {
      const r = await agent<AgentResult>(
        "/api/agent/chat",
        { messages: asked, pack_id: props.pack_id, deck_id: props.deck_id },
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

  const shown = messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, ...lines(m) }));
  return (
    <section className="cq-chat" aria-label="Chat with the agent">
      <MessageGroup>
        {shown.map((m, i) =>
          m.text || m.tools.length ? (
            <Message key={i} align={m.role === "user" ? "end" : "start"}>
              <MessageContent>
                {m.tools.length > 0 && <MessageHeader>{m.tools.join(" · ")}</MessageHeader>}
                {m.text}
              </MessageContent>
            </Message>
          ) : null,
        )}
        {steps && (
          <Message align="start">
            <MessageContent>
              <Spinner label="The agent is working" /> {steps.join(" · ")}
            </MessageContent>
          </Message>
        )}
      </MessageGroup>
      {error && <p role="alert">{error}</p>}
      {model && <small>Model: {model}</small>}
      <form onSubmit={send}>
        <Textarea
          aria-label="Message"
          value={text}
          rows={3}
          placeholder={props.placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(e);
          }}
        />
        <Button type="submit" variant="primary" disabled={!!steps || props.disabled || !text.trim()}>
          Send
        </Button>
      </form>
    </section>
  );
}
