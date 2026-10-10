// The editor's "Add slides" and "Review" actions. Adding slides goes through the agent (the
// draft-slides workflow writes the slides); the review runs review_deck and shows its report.
import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { DialogFooter } from "diametral-ds/dialog";
import { Tag } from "diametral-ds/tag";
import { Textarea } from "diametral-ds/textarea";
import { Sparkles, Wand } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { tool } from "../api.ts";
import { Dialog, Field, Spinner } from "../ui.tsx";
import type { Ask } from "./Chat.tsx";

/** Brief the agent on the slides to add; it writes and inserts them (add_slides). */
export function AddSlides({ onClose, onAsk }: { onClose: () => void; onAsk: (a: Ask) => void }) {
  const [brief, setBrief] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!brief.trim()) return;
    onAsk({ text: `Add slides to this deck: ${brief.trim()}`, workflow: "draft-slides" });
    onClose();
  }
  return (
    <Dialog title="Add slides" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="cq-dialog-body">
          <Field label="What should the new slides say?" htmlFor="a-brief" hint="One message per slide, the figures you have. The agent inserts them before the closing slide.">
            <Textarea id="a-brief" rows={5} required value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="A key-figures slide: 3 sites, 120 people, 12% growth…" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!brief.trim()}>
            <Sparkles /> Ask the agent
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

interface Finding {
  severity: "ERROR" | "WARN" | "NOTE";
  slide: number | null;
  check: string;
  message: string;
}
interface Review {
  report: { version: number; ERROR: Finding[]; WARN: Finding[]; NOTE: Finding[]; safe_fixes: Finding[]; judgment_calls: Finding[] };
}
const TONE = { ERROR: "danger", WARN: "warning", NOTE: "neutral" } as const;

function Findings({ title, items }: { title: string; items: Finding[] }) {
  if (!items.length) return null;
  return (
    <section className="cq-findings" aria-label={title}>
      <h3>
        {title} ({items.length})
      </h3>
      <ul>
        {items.map((f, i) => (
          <li key={i}>
            <Tag tone={TONE[f.severity]}>{f.severity}</Tag>
            <span className="cq-mono cq-muted">{f.slide ? `Slide ${f.slide}` : "Deck"}</span>
            <span>{f.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** review_deck's report: safe fixes applied in one click, the rest handed to the agent (review workflow). */
export function ReviewDeck(props: { deck_id: string; onClose: () => void; onApplySafe: () => void; onAsk: (a: Ask) => void }) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    tool<Review>("review_deck", { deck_id: props.deck_id }).then(setReview, (e: Error) => setError(e.message));
  }, [props.deck_id]);
  const r = review?.report;
  const notes = r?.NOTE ?? [];
  return (
    <Dialog title="Review" wide onClose={props.onClose}>
      <div className="cq-dialog-body cq-review">
        {!r && !error && <Spinner label="Reviewing: lint and render" />}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {r && (
          <>
            <p className="cq-hint">
              v{r.version}: {r.ERROR.length} error{r.ERROR.length === 1 ? "" : "s"}, {r.WARN.length} warning{r.WARN.length === 1 ? "" : "s"},{" "}
              {notes.length} note{notes.length === 1 ? "" : "s"}. The agent also proofreads and checks the renders slide by slide.
            </p>
            <Findings title="Safe fixes" items={r.safe_fixes} />
            <Findings title="Judgment calls" items={r.judgment_calls} />
            <Findings title="Notes" items={notes} />
          </>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={props.onClose}>
          Close
        </Button>
        {!!r?.safe_fixes.length && (
          <Button variant="outline" onClick={props.onApplySafe}>
            <Wand /> Apply {r.safe_fixes.length} safe fix{r.safe_fixes.length > 1 ? "es" : ""}
          </Button>
        )}
        <Button
          disabled={!r}
          onClick={() => {
            props.onAsk({ text: "Review this deck: report the fixes by severity, then apply the ones I approve.", workflow: "review-deck" });
            props.onClose();
          }}
        >
          <Sparkles /> Review with the agent
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
