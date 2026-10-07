import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardMedia,
  CardTitle,
  Field,
  FieldDescription,
  FieldLabel,
  FileUpload,
  FileUploadDescription,
  FileUploadTitle,
  Input,
  PageHeader,
  PageHeaderActions,
  PageHeaderDescription,
  PageHeaderHeading,
  PageHeaderTitle,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@diametral/design-system/react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, tool, upload, type Me, type Pack } from "../api.ts";

/** Settings > Brand packs: the packs this user sees, their visibility, and importing a new one. */
export function Packs({ me }: { me: Me }) {
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => tool<{ packs: Pack[] }>("list_packs").then((r) => setPacks(r.packs)), []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const share = async (p: Pack, visibility: Pack["visibility"]) => {
    setError(null);
    try {
      await api(`/api/packs/${p.id}/visibility`, { visibility, teams: p.teams.length ? p.teams : me.teams });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (importing)
    return (
      <Import
        me={me}
        onDone={async () => {
          setImporting(false);
          await reload();
        }}
      />
    );
  return (
    <>
      <PageHeader>
        <PageHeaderHeading>
          <PageHeaderTitle>Brand packs</PageHeaderTitle>
          <PageHeaderDescription>Each company's template, charter and voice. A new pack is visible to your teams only until you share it.</PageHeaderDescription>
        </PageHeaderHeading>
        <PageHeaderActions>
          <Button variant="primary" onClick={() => setImporting(true)}>
            Import a template
          </Button>
        </PageHeaderActions>
      </PageHeader>
      {error && (
        <Alert tone="danger" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!packs ? (
        <Spinner label="Loading packs" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pack</TableHead>
              <TableHead>Languages</TableHead>
              <TableHead>Visible to</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {packs.map((p) => (
              <TableRow key={p.id} data-pack={p.id}>
                <TableCell>
                  {p.name} <small>{p.id} · v{p.version}</small>
                </TableCell>
                <TableCell>{p.languages.join(", ")}</TableCell>
                <TableCell>{p.visibility === "workspace" ? <Badge>Workspace</Badge> : <Badge variant="outline">{p.teams.join(", ") || "Owner only"}</Badge>}</TableCell>
                <TableCell>
                  {p.editable &&
                    (p.visibility === "team" ? (
                      <Button size="sm" onClick={() => share(p, "workspace")}>
                        Share with the workspace
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => share(p, "team")}>
                        Restrict to my teams
                      </Button>
                    ))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

interface Draft {
  draft_id: string;
  manifest: Record<string, unknown> & { roles: Record<string, number[]>; never_clone: number[]; default_language: string | null; lint: { placeholders?: string[] } };
  slides: { number: number; layout: string; texts: string[]; image_url: string }[];
}

const ROLES = ["cover", "summary", "divider", "subsection", "content", "closing", "appendix"] as const;
const NONE = "none";
const NEVER = "never";

/** Role per slide from the draft manifest (the first role wins; archetypes stay as drafted). */
function rolesOf(d: Draft): Record<number, string> {
  const out: Record<number, string> = {};
  for (const s of d.slides) out[s.number] = d.manifest.never_clone.includes(s.number) ? NEVER : NONE;
  for (const r of ROLES) for (const n of d.manifest.roles[r] ?? []) if (out[n] === NONE) out[n] = r;
  return out;
}

function Import({ me, onDone }: { me: Me; onDone: () => Promise<void> }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<File | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [roles, setRoles] = useState<Record<number, string>>({});
  const [language, setLanguage] = useState("en");
  const [placeholders, setPlaceholders] = useState("");
  const [voice, setVoice] = useState("");
  const [fonts, setFonts] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<"team" | "workspace">("team");
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const step = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setProblems([]);
    try {
      await fn();
    } catch (e) {
      setProblems([(e as Error).message]);
    } finally {
      setBusy(null);
    }
  };

  async function extract(e: FormEvent) {
    e.preventDefault();
    if (!template) return;
    await step("Reading the template", async () => {
      const form = new FormData();
      form.set("id", id);
      form.set("name", name || id);
      form.set("template", template);
      const d = await upload<Draft>("/api/packs/drafts", form);
      setDraft(d);
      setRoles(rolesOf(d));
      setLanguage(d.manifest.default_language ?? "en");
      setPlaceholders((d.manifest.lint.placeholders ?? []).join("\n"));
    });
  }

  async function publish() {
    if (!draft) return;
    await step("Validating: template lint and a test deck", async () => {
      const assigned = Object.entries(roles);
      const manifest = {
        ...draft.manifest,
        default_language: language || null,
        roles: {
          ...Object.fromEntries(
            ROLES.map((r) => [r, assigned.filter(([, v]) => v === r).map(([n]) => Number(n))]).filter(([, ns]) => (ns as number[]).length),
          ),
          ...(draft.manifest.roles.archetypes ? { archetypes: draft.manifest.roles.archetypes } : {}),
        },
        never_clone: assigned.filter(([, v]) => v === NEVER).map(([n]) => Number(n)),
        lint: { ...draft.manifest.lint, placeholders: placeholders.split("\n").map((l) => l.trim()).filter(Boolean) },
      };
      const r = await api<{ status: string; problems?: string[] }>(`/api/packs/drafts/${draft.draft_id}/publish`, {
        manifest,
        visibility,
        teams: me.teams,
        ...(voice.trim() ? { voice } : {}),
      });
      if (r.status === "published") await onDone();
      else setProblems(r.problems ?? ["the pack did not validate"]);
    });
  }

  return (
    <>
      <PageHeader>
        <PageHeaderHeading>
          <PageHeaderTitle>Import a template</PageHeaderTitle>
          <PageHeaderDescription>
            {draft ? "Check the role of each slide, then validate: the template must lint clean and a test deck must build clean." : "The company's official template.pptx."}
          </PageHeaderDescription>
        </PageHeaderHeading>
        <PageHeaderActions>
          <Button onClick={() => void onDone()}>Cancel</Button>
        </PageHeaderActions>
      </PageHeader>
      {busy && <Spinner label={busy} />}
      {problems.length > 0 && (
        <Alert tone="danger" role="alert">
          <AlertTitle>The pack is not valid yet</AlertTitle>
          <AlertDescription>
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </AlertDescription>
        </Alert>
      )}

      {!draft ? (
        <form onSubmit={extract} className="cq-stack cq-narrow">
          <Field>
            <FieldLabel htmlFor="p-id">Pack id</FieldLabel>
            <Input id="p-id" required pattern="[a-z0-9][a-z0-9-]*" value={id} onChange={(e) => setId(e.target.value)} placeholder="acme" />
            <FieldDescription>Lowercase letters, digits and dashes.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="p-name">Name</FieldLabel>
            <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme" />
          </Field>
          <FileUpload accept=".pptx" aria-label="Template file" onFiles={(f) => setTemplate(f[0] ?? null)}>
            <FileUploadTitle>{template ? template.name : "Drop the template.pptx here"}</FileUploadTitle>
            <FileUploadDescription>or click to choose it</FileUploadDescription>
          </FileUpload>
          <Button type="submit" variant="primary" disabled={!template || !id || !!busy}>
            Read the template
          </Button>
        </form>
      ) : (
        <div className="cq-stack">
          <div className="cq-cards">
            {draft.slides.map((s) => (
              <Card key={s.number} size="sm" data-slide={s.number}>
                <CardMedia src={s.image_url} alt={`Template slide ${s.number}`} />
                <CardHeader>
                  <CardTitle>Slide {s.number}</CardTitle>
                  <CardDescription>{s.layout}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Select value={roles[s.number] ?? NONE} onValueChange={(v) => setRoles({ ...roles, [s.number]: String(v) })}>
                    <SelectTrigger aria-label={`Role of slide ${s.number}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>No role</SelectItem>
                      {ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {r}
                        </SelectItem>
                      ))}
                      <SelectItem value={NEVER}>Never clone</SelectItem>
                    </SelectContent>
                  </Select>
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="cq-columns">
            <div className="cq-stack">
              <Field>
                <FieldLabel htmlFor="p-lang">Default language</FieldLabel>
                <Input id="p-lang" value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en" />
                <FieldDescription>Empty: ask for the language of every deck.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="p-ph">Template placeholders</FieldLabel>
                <Textarea id="p-ph" rows={5} value={placeholders} onChange={(e) => setPlaceholders(e.target.value)} />
                <FieldDescription>Sample copy that must never survive in a deck, one per line.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Visible to</FieldLabel>
                <RadioGroup value={visibility} onValueChange={(v) => setVisibility(v as "team" | "workspace")}>
                  <Field orientation="horizontal">
                    <RadioGroupItem id="v-team" value="team" />
                    <FieldLabel htmlFor="v-team">My teams ({me.teams.join(", ") || "only me"})</FieldLabel>
                  </Field>
                  <Field orientation="horizontal">
                    <RadioGroupItem id="v-ws" value="workspace" />
                    <FieldLabel htmlFor="v-ws">The whole workspace</FieldLabel>
                  </Field>
                </RadioGroup>
              </Field>
            </div>
            <div className="cq-stack">
              <Field>
                <FieldLabel htmlFor="p-voice">Voice</FieldLabel>
                <Textarea id="p-voice" rows={6} value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="Tone, register, words to avoid…" />
              </Field>
              <FileUpload
                accept=".ttf,.otf"
                multiple
                aria-label="Font files"
                onFiles={(files) =>
                  void step("Uploading fonts", async () => {
                    for (const f of files) {
                      const form = new FormData();
                      form.set("font", f);
                      setFonts((await upload<{ fonts: string[] }>(`/api/packs/drafts/${draft.draft_id}/fonts`, form)).fonts);
                    }
                  })
                }
              >
                <FileUploadTitle>{fonts.length ? fonts.join(", ") : "Brand fonts (.ttf, .otf)"}</FileUploadTitle>
                <FileUploadDescription>Uploaded under your company's font license. Without them, slides render with the fallback fonts.</FileUploadDescription>
              </FileUpload>
            </div>
          </div>
          <Button variant="primary" disabled={!!busy} onClick={() => void publish()}>
            Validate and publish
          </Button>
        </div>
      )}
    </>
  );
}
