// Designs: social posts, stories, banners, ads, posters, web sections (DesignSpec, docs/adr/0002).
// The list, and one design: its artboards as rendered by the engine, their lint, the token mode,
// adapting an artboard to another format, undo, and the exports. Every change is a tool call.
import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { Card, CardContent, CardHeader } from "diametral-ds/card";
import { CodeBlock, CodeBlockBody, CodeBlockCopyButton, CodeBlockFilename, CodeBlockHead } from "diametral-ds/code-block";
import { DialogFooter } from "diametral-ds/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "diametral-ds/empty";
import { Tag } from "diametral-ds/tag";
import { ToggleGroup, ToggleGroupItem } from "diametral-ds/toggle-group";
import { ArrowLeft, Code, Copy, Download, Shapes, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { tool } from "../api.ts";
import { t, tn } from "../i18n.ts";
import { go } from "../nav.ts";
import { ago, Dialog, PageHead, Spinner } from "../ui.tsx";

const BASE = import.meta.env.BASE_URL;
/** The toggle's value for the pack's base values (no mode). */
const BASE_MODE = "__base";

export interface DesignRow {
  design_id: string;
  title: string;
  pack_id: string;
  version: number;
  cover: string | null;
  artboards: number;
  updated_at: string;
}

interface Finding {
  severity: "ERROR" | "WARN";
  artboard: string | null;
  node: string | null;
  check?: string;
  message: string;
}

interface Artboard {
  id: string;
  format: string;
  width: number;
  height: number;
  mode: string | null;
}

interface DesignView {
  design_id: string;
  title: string;
  pack_id: string;
  version: number;
  head: number;
  artboards: Artboard[];
  errors: Finding[];
  warnings: Finding[];
  spec: { mode?: string };
}

interface Formats {
  formats: { id: string; label: string; width: number; height: number }[];
  modes: string[];
}

/** A rendered artboard, read with the session like the deck previews. */
const png = (id: string, artboard: string, version: number) => `${BASE}designs/${id}/${artboard}.png?v=${version}`;

export function Designs() {
  const [rows, setRows] = useState<DesignRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    tool<{ designs: DesignRow[] }>("list_designs").then(
      (r) => setRows(r.designs),
      (e) => setError((e as Error).message),
    );
  }, []);
  return (
    <div className="cq-page">
      <PageHead title={t("Designs")} description={t("Social posts, stories, banners, ads, posters and web sections on your brand packs.")} />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!rows && !error && <Spinner label={t("Loading designs")} />}
      {rows?.length === 0 && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Shapes />
            </EmptyMedia>
            <EmptyTitle>{t("No design yet")}</EmptyTitle>
            <EmptyDescription>{t("Ask the agent for one in Claude with the create-design prompt: it lays the design out, checks it and saves it here.")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {!!rows?.length && (
        <ul className="cq-deck-grid">
          {rows.map((d) => (
            <li key={d.design_id} className="cq-deck-item">
              <a className="cq-deck-card" href={`/designs/${d.design_id}`} onClick={(e) => go(e, `/designs/${d.design_id}`)}>
                <span className="cq-deck-cover cq-design-cover">{d.cover && <img src={png(d.design_id, d.cover, d.version)} alt="" loading="lazy" />}</span>
                <span className="cq-deck-info">
                  <strong>{d.title}</strong>
                  <span>
                    {d.pack_id} · {tn(d.artboards, "{n} artboard", "{n} artboards")} · v{d.version} · {ago(d.updated_at)}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const TONE = { ERROR: "danger", WARN: "warning" } as const;

function FindingCard({ f }: { f: Finding }) {
  return (
    <Card size="sm" role="listitem">
      <CardHeader className="flex flex-wrap items-center gap-2">
        <Tag tone={TONE[f.severity]}>{f.severity}</Tag>
        {f.node && <span className="cq-mono text-sm">{f.node}</span>}
        {f.check && <span className="cq-mono ml-auto text-xs text-muted-foreground">{f.check}</span>}
      </CardHeader>
      <CardContent className="text-sm">{f.message}</CardContent>
    </Card>
  );
}

type Export = "png" | "png2" | "pdf" | "svg" | "html";
const EXPORTS: { id: Export; label: string; args: { format: string; scale?: number } }[] = [
  { id: "png", label: "PNG", args: { format: "png" } },
  { id: "png2", label: "PNG @2x", args: { format: "png", scale: 2 } },
  { id: "pdf", label: "PDF", args: { format: "pdf" } },
  { id: "svg", label: "SVG", args: { format: "svg" } },
  { id: "html", label: "HTML", args: { format: "html" } },
];

/** Start one download per file (the server sends them as attachments, PNG inline: `download` names it). */
function download(urls: string[]) {
  for (const url of urls) {
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
  }
}

export function DesignEditor({ id }: { id: string }) {
  const [d, setD] = useState<DesignView | null>(null);
  const [formats, setFormats] = useState<Formats | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<{ filename: string; code: string } | null>(null);
  const [adapt, setAdapt] = useState<{ artboard: string; format: string } | null>(null);

  const open = () => tool<DesignView>("open_design", { design_id: id }).then(setD);
  useEffect(() => {
    open().catch((e) => setError((e as Error).message));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (d?.pack_id) tool<Formats>("list_formats", { pack_id: d.pack_id }).then(setFormats, () => setFormats(null));
  }, [d?.pack_id]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setError(null);
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  // a change returns the new version's renders and lint; open_design adds the spec and history
  const patch = (label: string, ops: unknown[]) => run(label, async () => (await tool("patch_design", { design_id: id, ops, note: label }), await open()));
  const undo = () => run(t("Undoing"), async () => (await tool("restore_design", { design_id: id }), await open()));
  const exportAll = (e: (typeof EXPORTS)[number]) =>
    run(t("Exporting {format}", { format: e.label }), async () => {
      const r = await tool<{ files: { url: string }[] }>("export_design", { design_id: id, ...e.args });
      download(r.files.map((f) => f.url));
    });
  const exportCode = (artboard: string, format: "react" | "tailwind") =>
    run(t("Exporting {format}", { format }), async () => setCode(await tool<{ filename: string; code: string }>("export_design", { design_id: id, format, artboard })));

  if (!d)
    return (
      <div className="cq-page">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <Spinner label={t("Loading the design")} />
        )}
      </div>
    );

  const label = (format: string) => formats?.formats.find((f) => f.id === format)?.label ?? format;
  const findings = (artboard: string) => [...d.errors, ...d.warnings].filter((f) => f.artboard === artboard);
  const deckWide = [...d.errors, ...d.warnings].filter((f) => !f.artboard);
  const mode = d.spec.mode ?? "";

  return (
    <div className="cq-page cq-design">
      <PageHead
        title={d.title}
        description={`${d.pack_id} · v${d.version} · ${tn(d.errors.length, "{n} error", "{n} errors")} · ${tn(d.warnings.length, "{n} warning", "{n} warnings")}`}
      >
        <Button variant="ghost" onClick={(e) => go(e, "/designs")}>
          <ArrowLeft /> {t("Designs")}
        </Button>
        <Button variant="outline" disabled={!!busy || d.head < 2} onClick={() => void undo()}>
          <Undo2 /> {t("Undo")}
        </Button>
      </PageHead>

      <div className="cq-design-bar" role="toolbar" aria-label={t("Design tools")}>
        {!!formats?.modes.length && (
          <ToggleGroup
            variant="outline"
            spacing={0}
            aria-label={t("Colour mode")}
            value={[mode || BASE_MODE]}
            onValueChange={(v: string[]) => {
              const next = v[0] === BASE_MODE ? "" : v[0];
              if (next !== undefined && next !== mode) void patch(t("Colour mode"), [{ op: "set_field", field: "mode", value: next || null }]);
            }}
          >
            {[BASE_MODE, ...formats.modes].map((m) => (
              <ToggleGroupItem key={m} value={m} className="aria-pressed:bg-foreground aria-pressed:text-background">
                {m === BASE_MODE ? t("Base") : m}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <span className="cq-design-exports">
          <Download aria-hidden />
          {EXPORTS.map((e) => (
            <Button key={e.id} size="sm" variant="outline" disabled={!!busy} onClick={() => void exportAll(e)}>
              {e.label}
            </Button>
          ))}
        </span>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {busy && <Spinner label={busy} />}
      {deckWide.length > 0 && (
        <div role="list" className="cq-findings">
          {deckWide.map((f, i) => (
            <FindingCard key={i} f={f} />
          ))}
        </div>
      )}

      {d.artboards.map((a) => {
        const fs = findings(a.id);
        return (
          <section key={a.id} className="cq-board" aria-label={t("Artboard {id}", { id: a.id })}>
            <header className="cq-board-head">
              <h2>{a.id}</h2>
              <span>
                {label(a.format)} · {a.width}×{a.height}
                {a.mode && ` · ${a.mode}`}
              </span>
              <span className="cq-board-actions">
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setAdapt({ artboard: a.id, format: formats?.formats.find((f) => f.id !== a.format)?.id ?? "" })}>
                  <Copy /> {t("Adapt to…")}
                </Button>
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void exportCode(a.id, "react")}>
                  <Code /> React
                </Button>
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void exportCode(a.id, "tailwind")}>
                  <Code /> Tailwind
                </Button>
              </span>
            </header>
            <div className="cq-board-body">
              <div className="cq-board-canvas">
                <img src={png(d.design_id, a.id, d.version)} alt={t("Artboard {id}", { id: a.id })} width={a.width} height={a.height} />
              </div>
              <div role="list" className="cq-findings" aria-label={t("Checks for {id}", { id: a.id })}>
                {fs.length === 0 ? <p className="cq-hint">{t("No issue found.")}</p> : fs.map((f, i) => <FindingCard key={i} f={f} />)}
              </div>
            </div>
          </section>
        );
      })}

      {code && (
        <Dialog title={code.filename} wide onClose={() => setCode(null)}>
          <CodeBlock className="min-w-0">
            <CodeBlockHead>
              <CodeBlockFilename>{code.filename}</CodeBlockFilename>
              <CodeBlockCopyButton value={code.code} />
            </CodeBlockHead>
            <CodeBlockBody className="max-h-[60vh] text-xs leading-relaxed whitespace-pre">{code.code}</CodeBlockBody>
          </CodeBlock>
        </Dialog>
      )}
      {adapt && formats && (
        <Dialog title={t("Adapt {id} to another format", { id: adapt.artboard })} onClose={() => setAdapt(null)}>
          <div className="cq-dialog-body">
            <select className="cq-select" aria-label={t("Format")} value={adapt.format} onChange={(e) => setAdapt({ ...adapt, format: e.target.value })}>
              {formats.formats.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label} · {f.width}×{f.height}
                </option>
              ))}
            </select>
            <p className="cq-hint">{t("A copy on the new canvas: auto layout reflows, type follows the format. Check its lint after.")}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdapt(null)}>
              {t("Cancel")}
            </Button>
            <Button
              disabled={!adapt.format}
              onClick={() => {
                const taken = new Set(d.artboards.map((b) => b.id));
                let nid = `${adapt.artboard}_${adapt.format}`;
                for (let i = 2; taken.has(nid); i++) nid = `${adapt.artboard}_${adapt.format}_${i}`;
                setAdapt(null);
                void patch(t("Adapt to {format}", { format: label(adapt.format) }), [{ op: "adapt_artboard", artboard: adapt.artboard, id: nid, format: adapt.format }]);
              }}
            >
              <Copy /> {t("Adapt")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}
