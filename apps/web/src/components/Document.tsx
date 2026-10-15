// What a deck and a design editor share (both are documents of one store): the version history,
// and the document's type and approval controls.
import { Button } from "diametral-ds/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "diametral-ds/table";
import { Tag } from "diametral-ds/tag";
import { BadgeCheck, GitCompare, Send, Undo2 } from "lucide-react";
import type { Approval } from "@calque/slide-ui";
import { useState, type ReactNode } from "react";
import { t, tn } from "../i18n.ts";
import { ago, Dialog } from "../ui.tsx";

export interface Version {
  version: number;
  note: string;
  author: string;
  author_name: string | null;
  created_at: string;
  pack_version: number | null;
}

/** Every version, newest first: restore one (editors), and see what one changed when `changes` can. */
export function VersionHistory(props: { versions: Version[]; head: number; canRestore: boolean; onRestore: (version: number) => void; onClose: () => void; changes?: (version: number) => ReactNode }) {
  const [compare, setCompare] = useState<number | null>(null);
  return (
    <Dialog title={t("Version history")} wide onClose={props.onClose}>
      <div className="cq-dialog-body">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Version")}</TableHead>
              <TableHead>{t("Change")}</TableHead>
              <TableHead>{t("By")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...props.versions].reverse().map((v) => (
              <TableRow key={v.version} data-state={compare === v.version ? "selected" : undefined}>
                <TableCell>
                  <span className="cq-mono">v{v.version}</span>
                </TableCell>
                <TableCell>
                  {v.note}
                  <div className="cq-hint">
                    {ago(v.created_at)}
                    {v.pack_version != null && ` · ${t("pack release {n}", { n: v.pack_version })}`}
                  </div>
                </TableCell>
                <TableCell>{v.author_name || v.author}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-2">
                    {props.changes && v.version > 1 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t("Changes in v{version}", { version: v.version })}
                        aria-pressed={compare === v.version}
                        onClick={() => setCompare(compare === v.version ? null : v.version)}
                      >
                        <GitCompare /> {t("Changes")}
                      </Button>
                    )}
                    {v.version === props.head ? (
                      <Tag>{t("Current")}</Tag>
                    ) : (
                      props.canRestore && (
                        <Button size="sm" variant="outline" aria-label={t("Restore v{version}", { version: v.version })} onClick={() => props.onRestore(v.version)}>
                          {t("Restore")}
                        </Button>
                      )
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {compare !== null && props.changes?.(compare)}
      </div>
    </Dialog>
  );
}

const APPROVAL = { draft: "Draft", in_review: "In review", approved: "Approved" } as const;

/** The document's type (editors pick one of its pack's) and its approval status and actions. */
export function TypeAndApproval(props: {
  kind: string | null | undefined;
  kinds: string[] | undefined;
  approval: Approval | null | undefined;
  edits: boolean;
  busy: boolean;
  onKind: (kind: string | null) => void;
  onApproval: (status: "draft" | "in_review" | "approved", label: string) => void;
}) {
  const approval = props.approval && props.approval.enabled ? props.approval : null;
  return (
    <>
      {props.edits && !!props.kinds?.length ? (
        <select
          className="cq-select"
          aria-label={t("Deck type")}
          title={t("The deck's type: the brand pack may require approval for some types")}
          value={props.kind ?? ""}
          disabled={props.busy}
          onChange={(e) => props.onKind(e.target.value || null)}
        >
          <option value="">{t("No type")}</option>
          {props.kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      ) : (
        props.kind && <Tag>{props.kind}</Tag>
      )}
      {approval && (
        <>
          <Tag tone={approval.status === "approved" ? "success" : approval.status === "in_review" ? "warning" : "neutral"}>{t(APPROVAL[approval.status])}</Tag>
          {approval.status === "in_review" && !!approval.blocking?.length && (
            <Tag tone="danger" title={t("Required comments block approval until they are resolved")}>
              {tn(approval.blocking.length, "{n} required comment open", "{n} required comments open")}
            </Tag>
          )}
          {approval.can_request && (
            <Button variant="ghost" onClick={() => props.onApproval("in_review", t("Requesting review"))}>
              <Send /> {t("Request review")}
            </Button>
          )}
          {approval.can_approve && (
            <>
              <Button variant="ghost" onClick={() => props.onApproval("approved", t("Approving"))}>
                <BadgeCheck /> {t("Approve")}
              </Button>
              <Button variant="ghost" onClick={() => props.onApproval("draft", t("Requesting changes"))}>
                <Undo2 /> {t("Request changes")}
              </Button>
            </>
          )}
          {approval.can_withdraw && !approval.can_approve && (
            <Button variant="ghost" onClick={() => props.onApproval("draft", t("Back to draft"))}>
              <Undo2 /> {t("Back to draft")}
            </Button>
          )}
        </>
      )}
    </>
  );
}
