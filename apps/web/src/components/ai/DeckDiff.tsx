// What a deck version changed against the one before it: per slide and shape, old -> new text,
// slides added and removed. Adapted from beautifului.dev (MIT): DiffTable, on real DeckSpecs.
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "diametral-ds/table";
import { useEffect, useState } from "react";
import { tool } from "../../api.ts";
import { t } from "../../i18n.ts";
import { Spinner } from "../../ui.tsx";

/** The DeckSpec fields a diff reads (packages/deckspec/src/schema.ts). */
type Spec = {
  slides: { id: string; message: string; title?: string; eyebrow?: string; notes?: string; source: { kind: string; values?: Record<string, unknown> } }[];
};
const FIELDS = ["title", "eyebrow", "message", "notes"] as const;
type Where = "slide" | "content" | (typeof FIELDS)[number] | number;
export type DiffRow = { slide: number; where: Where; kind: "added" | "removed" | "changed"; before?: string; after?: string };

/** Every string and number under `x`, in order: the text a reader sees in a value or params. */
const words = (x: unknown): string =>
  x == null || typeof x === "boolean"
    ? ""
    : typeof x === "string" || typeof x === "number"
      ? String(x)
      : (Array.isArray(x) ? x : Object.values(x)).map(words).filter(Boolean).join(" · ");

/** Slides match by id. Moves alone show no row: only text, added and removed slides. */
export function diffSpecs(before: Spec, after: Spec): DiffRow[] {
  const rows: DiffRow[] = [];
  const old = new Map(before.slides.map((s, i) => [s.id, { s, n: i + 1 }]));
  const kept = new Set(after.slides.map((s) => s.id));
  before.slides.forEach((s, i) => kept.has(s.id) || rows.push({ slide: i + 1, where: "slide", kind: "removed", before: s.title || s.message }));
  after.slides.forEach((s, i) => {
    const slide = i + 1;
    const was = old.get(s.id)?.s;
    if (!was) return void rows.push({ slide, where: "slide", kind: "added", after: s.title || s.message });
    const cmp = (where: Where, a: string, b: string) => a !== b && rows.push({ slide, where, kind: "changed", before: a, after: b });
    for (const f of FIELDS) cmp(f, was[f] ?? "", s[f] ?? "");
    if (was.source.kind === "clone" && s.source.kind === "clone") {
      const ids = new Set([...Object.keys(was.source.values ?? {}), ...Object.keys(s.source.values ?? {})]);
      for (const id of [...ids].sort((a, b) => +a - +b)) cmp(+id, words(was.source.values?.[id]), words(s.source.values?.[id]));
    } else cmp("content", words(was.source), words(s.source));
  });
  return rows.sort((a, b) => a.slide - b.slide);
}

const WHERE = { slide: "Slide", content: "Content", title: "Title", eyebrow: "Eyebrow", message: "Message", notes: "Notes" } as const;

/** Version `version` of deck `deck_id` against `version - 1`, as a table. */
export function DeckDiff({ deck_id, version }: { deck_id: string; version: number }) {
  const [rows, setRows] = useState<DiffRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRows(null);
    setError(null);
    const spec = (v: number) => tool<{ spec: Spec }>("open_deck", { deck_id, version: v, render: false }).then((d) => d.spec);
    Promise.all([spec(version - 1), spec(version)]).then(([a, b]) => setRows(diffSpecs(a, b)), (e: Error) => setError(e.message));
  }, [deck_id, version]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!rows) return <Spinner label={t("Comparing versions")} />;
  if (!rows.length) return <p className="cq-hint">{t("No text change in v{version}.", { version })}</p>;
  const struck = "bg-[var(--ds-danger-bg)] text-[var(--ds-danger-ink)] line-through decoration-[var(--ds-danger-ink)]/50";
  const added = "bg-[var(--ds-success-bg)] text-[var(--ds-success-ink)]";
  return (
    <Table aria-label={t("Changes in v{version}", { version })}>
      <TableHeader>
        <TableRow>
          <TableHead>{t("Slide")}</TableHead>
          <TableHead>{t("Element")}</TableHead>
          <TableHead>{t("Before v{version}", { version })}</TableHead>
          <TableHead>{t("In v{version}", { version })}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i} data-kind={r.kind}>
            <TableCell className="tabular-nums">{r.slide}</TableCell>
            <TableCell>
              {typeof r.where === "number" ? t("shape {id}", { id: r.where }) : r.kind === "changed" ? t(WHERE[r.where]) : r.kind === "added" ? t("Slide added") : t("Slide removed")}
            </TableCell>
            <TableCell className={`whitespace-pre-wrap ${r.before ? struck : ""}`}>{r.before}</TableCell>
            <TableCell className={`whitespace-pre-wrap ${r.after ? added : ""}`}>{r.after}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
