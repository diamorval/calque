// The soft export gate: a deck with lint ERRORs still exports, once the user says why. The reason
// goes to export_pptx, which records it with the export (deck_audit).
import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { DialogFooter } from "diametral-ds/dialog";
import { Textarea } from "diametral-ds/textarea";
import { Download } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Finding } from "../lint.ts";
import { Dialog, Field } from "../ui.tsx";

export function ExportWithErrors(props: { errors: Finding[]; onClose: () => void; onExport: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = props.errors.length;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) return;
    setBusy(true);
    try {
      await props.onExport(reason.trim());
      props.onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={`Export with ${n} lint error${n === 1 ? "" : "s"}?`} onClose={props.onClose}>
      <form onSubmit={submit}>
        <div className="cq-dialog-body">
          <p className="cq-hint">This version is off-charter. You can still export it: say why, the reason is recorded with the export.</p>
          <ul className="cq-findings">
            {props.errors.slice(0, 5).map((f, i) => (
              <li key={i}>
                <span className="cq-mono cq-muted">{f.slide ? `Slide ${f.slide}` : "Deck"}</span> <span>{f.message}</span>
              </li>
            ))}
            {n > 5 && <li className="cq-muted">and {n - 5} more</li>}
          </ul>
          <Field label="Why does it go out anyway?" htmlFor="x-reason">
            <Textarea id="x-reason" rows={3} required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Client draft for tonight, fixes in the final version" />
          </Field>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !reason.trim()}>
            <Download /> Export anyway
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
