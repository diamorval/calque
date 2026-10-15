// The chat's composer: a growing textarea, attachments (files, Microsoft 365), the model, dictation,
// and two menus typed in place: "/" at a line start picks a workflow, "@" references a slide.
// Adapted from beautifului.dev (MIT): PromptBar.
import { Button } from "diametral-ds/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "diametral-ds/dropdown-menu";
import { Kbd } from "diametral-ds/kbd";
import { ArrowUp, ChevronDown, Cloud, MessageSquarePlus, Mic, MicOff, Paperclip, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { getLang, t } from "../../i18n.ts";
import type { Key } from "../../i18n/fr.ts";

export type Workflow = "draft-slides" | "edit-slides" | "review-deck";
export const WORKFLOWS: Record<Workflow, Key> = { "draft-slides": "Draft slides", "edit-slides": "Edit slides", "review-deck": "Review the deck" };

export interface Attached {
  file_id: string;
  name: string;
}
export interface ModelChoice {
  id: string;
  model: string;
  label: string | null;
  is_default: boolean;
  /** the one the agent runs for this viewer by default (their team's, else the workspace's) */
  your_default?: boolean;
}
const ACCEPT = "image/*,.pptx,.pdf,.docx,.xlsx,.csv,.txt,.md";

/** The "/" or "@" being typed just before the caret, if any. */
function token(text: string, caret: number): { kind: "/" | "@"; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|\n)\/([\w-]*)$/.exec(before) ?? /(?:^|\s)@(\d*)$/.exec(before);
  if (!m) return null;
  const query = m[1] ?? "";
  return { kind: m[0].trimStart().startsWith("/") ? "/" : "@", query, start: caret - query.length - 1 };
}

// the Web Speech API: Chrome and Safari prefix it, Firefox lacks it
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
const Speech = (globalThis as unknown as Record<string, (new () => Recognition) | undefined>).SpeechRecognition ?? (globalThis as unknown as Record<string, (new () => Recognition) | undefined>).webkitSpeechRecognition;

/** Dictation into the composer, final phrases appended; null where the browser has none. */
function useDictation(onText: (s: string) => void) {
  const [rec, setRec] = useState<Recognition | null>(null);
  const push = useRef(onText);
  push.current = onText;
  useEffect(() => () => rec?.stop(), [rec]);
  if (!Speech) return null;
  return {
    on: !!rec,
    toggle() {
      if (rec) return rec.stop();
      const r = new Speech();
      r.lang = getLang() === "fr" ? "fr-FR" : "en-US";
      r.continuous = true;
      r.interimResults = false;
      r.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i]?.isFinal) push.current(e.results[i]?.[0]?.transcript ?? "");
      };
      r.onend = () => setRec(null);
      r.start();
      setRec(r);
    },
  };
}

export function PromptBar(props: {
  value: string;
  onChange: (text: string) => void;
  onSubmit: () => void;
  placeholder: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** a run in progress */
  busy: boolean;
  uploading: boolean;
  disabled: boolean;
  workflow: Workflow | undefined;
  onWorkflow: (w: Workflow | undefined) => void;
  /** false: the conversation runs one workflow (a new design), no "/" menu */
  workflows?: boolean;
  /** the deck's slide count, for "@" */
  slides?: number | undefined;
  attached: Attached[];
  onDetach: (f: Attached) => void;
  onAttach: (files: FileList | null) => void;
  /** Microsoft 365 is connected: open its picker */
  onM365?: (() => void) | undefined;
  models: ModelChoice[];
  mine: ModelChoice | undefined;
  picked: string;
  onPick: (id: string) => void;
  /** the model of the last reply */
  model: string | null;
  /** the conversation has messages: start it over */
  onRestart?: (() => void) | undefined;
  footer?: ReactNode;
}) {
  const { value, onChange, inputRef } = props;
  const picker = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const locked = props.busy || props.disabled;
  const dictation = useDictation((s) => onChange(`${value}${value && !/\s$/.test(value) ? " " : ""}${s.trim()}`));

  // the open menu, filtered by what follows its "/" or "@"
  const tok = dismissed ? null : token(value, caret);
  const items: { key: string; label: string; pick: () => string }[] =
    tok?.kind === "/" && props.workflows !== false
      ? (Object.keys(WORKFLOWS) as Workflow[])
          .filter((w) => w.includes(tok.query.toLowerCase()) || t(WORKFLOWS[w]).toLowerCase().includes(tok.query.toLowerCase()))
          .map((w) => ({ key: w, label: t(WORKFLOWS[w]), pick: () => (props.onWorkflow(w), "") }))
      : tok?.kind === "@"
        ? Array.from({ length: props.slides ?? 0 }, (_, i) => i + 1)
            .filter((n) => String(n).startsWith(tok.query))
            .map((n) => ({ key: String(n), label: t("Slide {n}", { n }), pick: () => `${t("slide {n}", { n })} ` }))
        : [];
  const open = !!tok && items.length > 0;
  const current = Math.min(active, items.length - 1);

  function choose(i: number) {
    const item = items[i];
    if (!tok || !item) return;
    const insert = item.pick();
    const next = value.slice(0, tok.start) + insert + value.slice(caret);
    onChange(next);
    const at = tok.start + insert.length;
    setCaret(at);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(at, at));
  }

  return (
    <form
      className="cq-composer relative"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      {open && (
        <ul
          id="cq-prompt-menu"
          role="listbox"
          aria-label={tok.kind === "/" ? t("Workflows") : t("Slides")}
          className="absolute inset-x-0 bottom-full z-20 m-0 mb-1 max-h-56 list-none overflow-y-auto border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {items.map((it, i) => (
            <li
              key={it.key}
              id={`cq-prompt-${it.key}`}
              role="option"
              aria-selected={i === current}
              className="flex cursor-default items-center justify-between gap-3 px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault(); // keep the focus in the textarea
                choose(i);
              }}
            >
              {it.label}
              {tok.kind === "/" && <span className="font-mono text-xs text-muted-foreground">/{it.key}</span>}
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={inputRef}
        aria-label={t("Message")}
        aria-activedescendant={open ? `cq-prompt-${items[current]?.key}` : undefined}
        aria-controls={open ? "cq-prompt-menu" : undefined}
        value={value}
        rows={2}
        placeholder={props.placeholder}
        className="field-sizing-content min-h-[3lh] overflow-y-auto"
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart);
          setDismissed(false);
          setActive(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setActive((current + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
          } else if (open && (e.key === "Enter" || e.key === "Tab")) {
            e.preventDefault();
            choose(current);
          } else if (open && e.key === "Escape") {
            e.preventDefault();
            setDismissed(true);
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            props.onSubmit();
          }
        }}
      />
      {(props.workflow || props.attached.length > 0) && (
        <div className="cq-attached">
          {props.workflow && (
            <Button type="button" variant="secondary" size="sm" aria-label={t("Remove {name}", { name: t(WORKFLOWS[props.workflow]) })} onClick={() => props.onWorkflow(undefined)}>
              <span className="font-mono">/{props.workflow}</span> <X />
            </Button>
          )}
          {props.attached.map((f) => (
            <Button key={f.file_id} type="button" variant="outline" size="sm" aria-label={t("Remove {name}", { name: f.name })} onClick={() => props.onDetach(f)}>
              {f.name} <X />
            </Button>
          ))}
        </div>
      )}
      <div className="cq-composer-foot">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept={ACCEPT}
          onChange={(e) => {
            props.onAttach(e.target.files);
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("Attach files")}
          title={t("Attach images, PPTX, PDF, Word, Excel, CSV, text or Markdown")}
          disabled={props.uploading || locked}
          onClick={() => picker.current?.click()}
        >
          {props.uploading ? <span className="cq-spinner" /> : <Paperclip />}
        </Button>
        {props.onM365 && (
          <Button type="button" variant="ghost" size="icon" aria-label={t("From Microsoft 365")} title={t("Attach a file from OneDrive or SharePoint")} disabled={props.uploading || locked} onClick={props.onM365}>
            <Cloud />
          </Button>
        )}
        {dictation && (
          <Button type="button" variant={dictation.on ? "secondary" : "ghost"} size="icon" aria-label={dictation.on ? t("Stop dictation") : t("Dictate")} aria-pressed={dictation.on} disabled={locked} onClick={dictation.toggle}>
            {dictation.on ? <MicOff /> : <Mic />}
          </Button>
        )}
        {props.footer}
        {props.models.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" aria-label={t("AI model")} className="max-w-48 normal-case tracking-normal" />}>
              <span className="truncate">{props.models.find((m) => m.id === props.picked)?.model ?? t("Default model")}</span>
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" className="w-auto">
              <DropdownMenuRadioGroup value={props.picked} onValueChange={(v: string) => props.onPick(v)}>
                {[{ id: "", text: `${t("Default model")}${props.mine ? ` (${props.mine.model})` : ""}` }, ...props.models.map((m) => ({ id: m.id, text: `${m.model}${m.label ? ` (${m.label})` : ""}${m.is_default ? ` · ${t("default")}` : ""}` }))].map((o) => (
                  <DropdownMenuRadioItem key={o.id} value={o.id} className="normal-case tracking-normal">
                    {o.text}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {props.model && <span className="cq-hint">{t("Model: {model}", { model: props.model })}</span>}
        {props.onRestart && (
          <Button type="button" variant="ghost" size="icon" aria-label={t("New conversation")} title={t("Start the conversation over")} disabled={locked} onClick={props.onRestart}>
            <MessageSquarePlus />
          </Button>
        )}
        <span className="cq-spacer" />
        <span className="cq-hint cq-keys">
          <Kbd>↵</Kbd> {t("send")} · <Kbd>⇧↵</Kbd> {t("new line")}
          {props.workflows !== false && (
            <>
              {" "}
              · <Kbd>/</Kbd> {t("workflow")}
            </>
          )}
          {!!props.slides && (
            <>
              {" "}
              · <Kbd>@</Kbd> {t("slide")}
            </>
          )}
        </span>
        <Button type="submit" size="icon" aria-label={t("Send")} disabled={props.uploading || locked || !value.trim()}>
          <ArrowUp />
        </Button>
      </div>
    </form>
  );
}
