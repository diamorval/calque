import { Button } from "diametral-ds/button";
import { DataTable, type ColumnDef } from "diametral-ds/data-table";
import { Copy, Pencil, Trash2 } from "lucide-react";
import { ago, t } from "../i18n.ts";
import { go } from "../nav.ts";

/** A row of GET /api/decks. */
export interface DeckRow {
  id: string;
  title: string;
  pack_id: string;
  pack_version?: string;
  kind?: string | null;
  head: number;
  updated_at: string;
  owner: string;
  role: "owner" | "editor" | "commenter" | "viewer";
  /** deck or design; a design's first artboard is its cover */
  medium?: "deck" | "design";
  cover?: string | null;
}

/** Where a row opens: the deck editor, or the design page. */
export const docHref = (d: Pick<DeckRow, "id" | "medium">) => (d.medium === "design" ? `/designs/${d.id}` : `/d/${d.id}`);

export const ROLE = { owner: "Owner", editor: "Editor", commenter: "Commenter", viewer: "Viewer" } as const;

export interface DeckActions {
  onRename?: (() => void) | undefined;
  onDuplicate: () => void;
  onDelete?: (() => void) | undefined;
}

/** Rename, duplicate, delete: the same buttons on a card and in a table row. */
export function DeckActionButtons({ d, onRename, onDuplicate, onDelete }: { d: DeckRow } & DeckActions) {
  return (
    <>
      {onRename && (
        <Button size="icon" variant="outline" aria-label={t("Rename {title}", { title: d.title })} title={t("Rename")} onClick={onRename}>
          <Pencil />
        </Button>
      )}
      <Button size="icon" variant="outline" aria-label={t("Duplicate {title}", { title: d.title })} title={t("Duplicate")} onClick={onDuplicate}>
        <Copy />
      </Button>
      {onDelete && (
        <Button size="icon" variant="outline" aria-label={t("Delete {title}", { title: d.title })} title={t("Delete")} onClick={onDelete}>
          <Trash2 />
        </Button>
      )}
    </>
  );
}

/** The decks as a sortable table; narrow screens scroll it sideways inside its container. */
export function DeckTable({ decks, packName, actions }: { decks: DeckRow[]; packName: (id: string) => string; actions: (d: DeckRow) => DeckActions }) {
  const columns: ColumnDef<DeckRow>[] = [
    {
      accessorKey: "title",
      header: t("Title"),
      cell: ({ row: { original: d } }) => (
        <a className="font-medium whitespace-nowrap hover:underline" href={docHref(d)} onClick={(e) => go(e, docHref(d))}>
          {d.title}
        </a>
      ),
    },
    { id: "pack", accessorFn: (d) => packName(d.pack_id), header: t("Brand pack"), cell: (c) => <span className="whitespace-nowrap">{String(c.getValue())}</span> },
    { id: "kind", accessorFn: (d) => d.kind ?? "", header: t("Deck type"), cell: (c) => String(c.getValue()) || <span className="text-muted-foreground">—</span> },
    { id: "role", accessorFn: (d) => t(ROLE[d.role]), header: t("Role") },
    { accessorKey: "owner", header: t("Owner") },
    { accessorKey: "head", header: t("Version"), cell: (c) => <span className="tabular-nums">v{String(c.getValue())}</span> },
    // ISO timestamps sort as text
    { accessorKey: "updated_at", header: t("Updated"), cell: (c) => <span className="whitespace-nowrap">{ago(String(c.getValue()))}</span> },
    {
      id: "actions",
      header: () => <span className="sr-only">{t("Actions")}</span>,
      enableSorting: false,
      cell: ({ row: { original: d } }) => (
        <span className="flex justify-end gap-1">
          <DeckActionButtons d={d} {...actions(d)} />
        </span>
      ),
    },
  ];
  return <DataTable className="min-w-0" columns={columns} data={decks} rowKey={(d) => d.id} defaultSort={[{ id: "updated_at", desc: true }]} />;
}
