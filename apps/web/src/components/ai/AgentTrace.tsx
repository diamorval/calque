// The agent's tool calls in a turn. Live: a shimmering label, the seconds elapsed, one row per
// finished call. Done: folded to one line ("Used 3 tools"), unfolded on demand. Adapted from
// beautifului.dev (MIT): ThinkingState, ToolChips, LoadingState.
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "diametral-ds/collapsible";
import { Check, ChevronRight, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ToolStep } from "../../api.ts";
import { t, tn } from "../../i18n.ts";

/** A failed tool's error, short: the server's `message` when the error is its JSON. */
export function shortError(error: string, max = 160): string {
  let msg = error;
  try {
    const e = JSON.parse(error);
    if (typeof e?.message === "string") msg = e.message;
    else if (Array.isArray(e)) msg = e.map((c) => c?.text ?? "").join(" ");
  } catch {
    // not JSON: the message as is
  }
  return msg.length > max ? `${msg.slice(0, max - 1)}…` : msg;
}

/** "lint_deck" -> "Lint deck" */
const friendly = (name: string) => name.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Seconds since mount, ticking. */
function useElapsed() {
  const [s, setS] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setS(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return s;
}

function Rows({ tools }: { tools: ToolStep[] }) {
  return (
    <ul className="m-0 grid list-none gap-1 border-l border-border py-1 pl-3">
      {tools.map((step, i) => (
        <li key={i} className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground" data-failed={step.error !== undefined || undefined}>
          {step.error === undefined ? <Check className="size-3.5 shrink-0 text-foreground" aria-label={t("done")} /> : <X className="size-3.5 shrink-0 text-destructive" aria-label={t("failed")} />}
          <span className="text-foreground">{friendly(step.name)}</span>
          <span className="font-mono text-[11px]">{step.name}</span>
          {step.error !== undefined && <span className="basis-full pl-5.5 text-destructive">{shortError(step.error)}</span>}
        </li>
      ))}
    </ul>
  );
}

/** A run in progress: the label, the seconds, the calls finished so far. */
function Live({ tools }: { tools: ToolStep[] }) {
  const elapsed = useElapsed();
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2 text-sm">
        <span className="cq-spinner" aria-hidden />
        <span className="cq-shimmer font-medium">{tools.length ? t("Working") : t("Thinking")}</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{t("{n}s", { n: elapsed })}</span>
      </div>
      {tools.length > 0 && <Rows tools={tools} />}
    </div>
  );
}

/** The tools the agent called: live while it runs, then one folded line. */
export function AgentTrace({ tools, live }: { tools: ToolStep[]; live?: boolean }) {
  if (live) return <Live tools={tools} />;
  const failed = tools.filter((s) => s.error !== undefined).length;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" aria-hidden />
        {tn(tools.length, "Used {n} tool", "Used {n} tools")}
        {failed > 0 && <span className="text-destructive">· {t("{n} failed", { n: failed })}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1">
        <Rows tools={tools} />
      </CollapsibleContent>
    </Collapsible>
  );
}
