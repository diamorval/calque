// The web app's primitives: thin wrappers over the cq-* classes of @calque/slide-ui/styles.css,
// so the app and the deck UI share one visual language.
import { CircleAlert, Info, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "accent" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: boolean;
};

export function Button({ variant, size, icon, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className="cq-btn"
      data-variant={variant === "default" ? undefined : variant}
      data-size={size === "md" ? undefined : size}
      data-icon={icon || undefined}
      {...rest}
    />
  );
}

export function Badge(props: { tone?: "ok" | "danger" | "note" | "accent" | "solid"; children: ReactNode }) {
  return (
    <span className="cq-badge" data-tone={props.tone}>
      {props.children}
    </span>
  );
}

export function Alert(props: { tone?: "danger" | "info"; title?: string; children: ReactNode }) {
  return (
    <div className="cq-alert" data-tone={props.tone} role={props.tone === "danger" ? "alert" : undefined}>
      {props.tone === "danger" ? <CircleAlert /> : <Info />}
      <div>
        {props.title && <strong>{props.title}. </strong>}
        {props.children}
      </div>
    </div>
  );
}

export const Spinner = ({ label }: { label: string }) => <span className="cq-spinner">{label}</span>;

export function Field(props: { label: string; htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="cq-field">
      <label htmlFor={props.htmlFor}>{props.label}</label>
      {props.children}
      {props.hint && <span className="cq-hint">{props.hint}</span>}
    </div>
  );
}

export function PageHead(props: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <header className="cq-page-head">
      <div>
        <h1>{props.title}</h1>
        {props.description && <p>{props.description}</p>}
      </div>
      {props.children && <div className="cq-page-actions">{props.children}</div>}
    </header>
  );
}

export function Tabs<T extends string>(props: { value: T; onChange: (v: T) => void; items: { id: T; label: string }[] }) {
  return (
    <div className="cq-tabs" role="tablist">
      {props.items.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={props.value === t.id} onClick={() => props.onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** A modal dialog, open while mounted. Esc, the close button and a click outside close it. */
export function Dialog(props: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="cq-dialog"
      aria-label={props.title}
      data-wide={props.wide || undefined}
      onClose={props.onClose}
      onClick={(e) => e.target === ref.current && props.onClose()}
    >
      <div className="cq-dialog-head">
        <h2>{props.title}</h2>
        <Button variant="ghost" size="sm" icon aria-label="Close" onClick={props.onClose}>
          <X />
        </Button>
      </div>
      {props.children}
    </dialog>
  );
}

/** A drop zone that also opens the file chooser on click. */
export function FileDrop(props: { label: string; accept: string; multiple?: boolean; title: string; hint: string; onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <>
      <button
        type="button"
        className="cq-drop"
        data-over={over || undefined}
        aria-label={props.label}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          props.onFiles([...e.dataTransfer.files]);
        }}
      >
        <Upload />
        <strong>{props.title}</strong>
        <span>{props.hint}</span>
      </button>
      <input ref={input} type="file" hidden accept={props.accept} multiple={props.multiple} onChange={(e) => props.onFiles([...(e.target.files ?? [])])} />
    </>
  );
}

/** Calque's mark: two offset sheets, a tracing laid over a page. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect x="3" y="7" width="20" height="20" rx="5" fill="currentColor" opacity="0.28" />
      <rect x="9" y="3" width="20" height="20" rx="5" fill="currentColor" />
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
