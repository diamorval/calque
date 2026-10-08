import { Alert, AlertDescription, AlertTitle } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { Card } from "diametral-ds/card";
import { FieldLegend, FieldSet } from "diametral-ds/field";
import { Input } from "diametral-ds/input";
import { Stepper, StepperIndicator, StepperItem, StepperSeparator, StepperTitle } from "diametral-ds/stepper";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "diametral-ds/table";
import { Tag } from "diametral-ds/tag";
import { Textarea } from "diametral-ds/textarea";
import { FileUp, Globe, Lock, Upload, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";
import { api, tool, upload, type Me, type Pack } from "../api.ts";
import { Field, FileDrop, PageHead, Spinner } from "../ui.tsx";

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
    <div className="cq-page">
      <PageHead title="Brand packs" description="Each company's template, charter and voice. A new pack is visible to your teams only until you share it.">
        <Button onClick={() => setImporting(true)}>
          <Upload /> Import a template
        </Button>
      </PageHead>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!packs ? (
        <Spinner label="Loading packs" />
      ) : (
        <Card className="cq-table-card">
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
                    <strong>{p.name}</strong>{" "}
                    <span className="cq-mono cq-muted">
                      {p.id} · v{p.version}
                    </span>
                  </TableCell>
                  <TableCell>{p.languages.join(", ")}</TableCell>
                  <TableCell>
                    {p.visibility === "workspace" ? (
                      <Tag tone="info">
                        <Globe /> Workspace
                      </Tag>
                    ) : (
                      <Tag tone="neutral">
                        <Lock /> {p.teams.join(", ") || "Owner only"}
                      </Tag>
                    )}
                  </TableCell>
                  <TableCell>
                    {p.editable &&
                      (p.visibility === "team" ? (
                        <Button size="sm" variant="outline" onClick={() => share(p, "workspace")}>
                          Share with the workspace
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => share(p, "team")}>
                          Restrict to my teams
                        </Button>
                      ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
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

  const stage = !draft ? 0 : 1;
  return (
    <div className="cq-page">
      <PageHead
        title="Import a template"
        description={
          draft ? "Check the role of each slide, then validate: the template must lint clean and a test deck must build clean." : "The company's official template.pptx."
        }
      >
        <Button variant="ghost" onClick={() => void onDone()}>
          <X /> Cancel
        </Button>
      </PageHead>
      <Stepper>
        {["Upload the template", "Review slide roles", "Validate and publish"].map((label, i) => (
          <Fragment key={label}>
            {i > 0 && <StepperSeparator />}
            <StepperItem state={i < stage ? "completed" : i === stage ? "active" : "inactive"}>
              <StepperIndicator>{i + 1}</StepperIndicator>
              <StepperTitle>{label}</StepperTitle>
            </StepperItem>
          </Fragment>
        ))}
      </Stepper>
      {busy && <Spinner label={busy} />}
      {problems.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>The pack is not valid yet</AlertTitle>
          <AlertDescription>
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </AlertDescription>
        </Alert>
      )}

      {!draft ? (
        <form onSubmit={extract} className="cq-card cq-form">
          <Field label="Pack id" htmlFor="p-id" hint="Lowercase letters, digits and dashes.">
            <Input id="p-id" required pattern="[a-z0-9][a-z0-9-]*" value={id} onChange={(e) => setId(e.target.value)} placeholder="acme" />
          </Field>
          <Field label="Name" htmlFor="p-name">
            <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme" />
          </Field>
          <FileDrop
            label="Template file"
            accept=".pptx"
            title={template ? template.name : "Drop the template.pptx here"}
            hint="or click to choose it"
            onFiles={(f) => setTemplate(f[0] ?? null)}
          />
          <Button type="submit" disabled={!template || !id || !!busy}>
            <FileUp /> Read the template
          </Button>
        </form>
      ) : (
        <>
          <ul className="cq-template-grid">
            {draft.slides.map((s) => (
              <li key={s.number} className="cq-card cq-template" data-slide={s.number}>
                <img src={s.image_url} alt={`Template slide ${s.number}`} />
                <div>
                  <strong>Slide {s.number}</strong>
                  <span className="cq-hint">{s.layout}</span>
                </div>
                <select className="cq-select" aria-label={`Role of slide ${s.number}`} value={roles[s.number] ?? NONE} onChange={(e) => setRoles({ ...roles, [s.number]: e.target.value })}>
                  <option value={NONE}>No role</option>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                  <option value={NEVER}>Never clone</option>
                </select>
              </li>
            ))}
          </ul>
          <div className="cq-columns">
            <div className="cq-card cq-form">
              <Field label="Default language" htmlFor="p-lang" hint="Empty: ask for the language of every deck.">
                <Input id="p-lang" value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en" />
              </Field>
              <Field label="Template placeholders" htmlFor="p-ph" hint="Sample copy that must never survive in a deck, one per line.">
                <Textarea id="p-ph" rows={5} value={placeholders} onChange={(e) => setPlaceholders(e.target.value)} />
              </Field>
              <FieldSet>
                <FieldLegend variant="label">Visible to</FieldLegend>
                <label className="cq-check">
                  <input type="radio" name="visibility" value="team" checked={visibility === "team"} onChange={() => setVisibility("team")} />
                  My teams ({me.teams.join(", ") || "only me"})
                </label>
                <label className="cq-check">
                  <input type="radio" name="visibility" value="workspace" checked={visibility === "workspace"} onChange={() => setVisibility("workspace")} />
                  The whole workspace
                </label>
              </FieldSet>
            </div>
            <div className="cq-card cq-form">
              <Field label="Voice" htmlFor="p-voice">
                <Textarea id="p-voice" rows={6} value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="Tone, register, words to avoid…" />
              </Field>
              <FileDrop
                label="Font files"
                accept=".ttf,.otf"
                multiple
                title={fonts.length ? fonts.join(", ") : "Brand fonts (.ttf, .otf)"}
                hint="Uploaded under your company's font license. Without them, slides render with the fallback fonts."
                onFiles={(files) =>
                  void step("Uploading fonts", async () => {
                    for (const f of files) {
                      const form = new FormData();
                      form.set("font", f);
                      setFonts((await upload<{ fonts: string[] }>(`/api/packs/drafts/${draft.draft_id}/fonts`, form)).fonts);
                    }
                  })
                }
              />
            </div>
          </div>
          <div>
            <Button size="lg" disabled={!!busy} onClick={() => void publish()}>
              Validate and publish
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
