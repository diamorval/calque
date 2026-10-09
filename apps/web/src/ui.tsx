// The web app's compositions over the Diametral design system (diametral-ds): the parts
// every page repeats. Pages use the design system's components directly for the rest.
import { Dialog as DsDialog, DialogContent, DialogHeader, DialogTitle } from "diametral-ds/dialog";
import { Field as DsField, FieldDescription, FieldLabel } from "diametral-ds/field";
import { FileUpload, FileUploadDescription, FileUploadIcon, FileUploadTitle } from "diametral-ds/file-upload";
import { PageHeader, PageHeaderActions, PageHeaderDescription, PageHeaderHeading, PageHeaderTitle } from "diametral-ds/page-header";
import { Spinner as DsSpinner } from "diametral-ds/spinner";
import type { ReactNode } from "react";

/** A spinner that says what is happening. */
export const Spinner = ({ label }: { label: string }) => (
  <span className="cq-loading">
    <DsSpinner label={label} /> {label}
  </span>
);

export function Field(props: { label: string; htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <DsField>
      <FieldLabel htmlFor={props.htmlFor}>{props.label}</FieldLabel>
      {props.children}
      {props.hint && <FieldDescription>{props.hint}</FieldDescription>}
    </DsField>
  );
}

export function PageHead(props: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <PageHeader>
      <PageHeaderHeading>
        <div>
          <PageHeaderTitle>{props.title}</PageHeaderTitle>
          {props.description && <PageHeaderDescription>{props.description}</PageHeaderDescription>}
        </div>
        {props.children && <PageHeaderActions>{props.children}</PageHeaderActions>}
      </PageHeaderHeading>
    </PageHeader>
  );
}

/** A modal dialog, open while mounted. Esc, the close button and a click outside close it. */
export function Dialog(props: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  return (
    <DsDialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="cq-modal" data-wide={props.wide || undefined}>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        {props.children}
      </DialogContent>
    </DsDialog>
  );
}

/** A drop zone that also opens the file chooser on click. */
export function FileDrop(props: { label: string; accept: string; multiple?: boolean; title: string; hint: string; onFiles: (files: File[]) => void }) {
  return (
    <FileUpload aria-label={props.label} accept={props.accept} multiple={props.multiple ?? false} onFiles={props.onFiles}>
      <FileUploadIcon />
      <FileUploadTitle>{props.title}</FileUploadTitle>
      <FileUploadDescription>{props.hint}</FileUploadDescription>
    </FileUpload>
  );
}

/** Calque's mark: two offset sheets, a tracing laid over a page. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect x="3" y="7" width="20" height="20" fill="currentColor" opacity="0.28" />
      <rect x="9" y="3" width="20" height="20" fill="currentColor" />
    </svg>
  );
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
/** "3 minutes ago", "yesterday"… */
export function ago(iso: string): string {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [["second", 60], ["minute", 60], ["hour", 24], ["day", 7], ["week", 4.35], ["month", 12], ["year", Infinity]];
  let v = s;
  for (const [unit, size] of steps) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit);
    v /= size;
  }
  return iso;
}
