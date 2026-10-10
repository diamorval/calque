import { Alert, AlertDescription, AlertTitle } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { Card } from "diametral-ds/card";
import { FieldLegend, FieldSet } from "diametral-ds/field";
import { Input } from "diametral-ds/input";
import { Stepper, StepperIndicator, StepperItem, StepperSeparator, StepperTitle } from "diametral-ds/stepper";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "diametral-ds/table";
import { Tag } from "diametral-ds/tag";
import { Textarea } from "diametral-ds/textarea";
import { Archive, ArchiveRestore, FileUp, GitBranch, Globe, History, Lock, Pencil, ShieldCheck, Upload, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";
import { api, upload, type Me, type Pack } from "../api.ts";
import { go } from "../nav.ts";
import { Dialog, Field, FileDrop, PageHead, Spinner } from "../ui.tsx";

interface Releases {
  id: string;
  current: number;
  versions: { version: number; note: string; author: string | null; created_at: string }[];
}

/** Settings > Brand packs: the packs this user sees or manages (archived too), their owner and
visibility, their releases, and importing a new one. Owners and admins manage a pack. */
export function Packs({ me }: { me: Me }) {
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [history, setHistory] = useState<Releases | null>(null);
  const [restricting, setRestricting] = useState<{ pack: Pack; teams: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => api<{ packs: Pack[] }>("/api/packs").then((r) => setPacks(r.packs)), []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const share = async (p: Pack, visibility: Pack["visibility"], teams = p.teams) => {
    setError(null);
    try {
      await api(`/api/packs/${p.id}/visibility`, { visibility, teams });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const archive = (p: Pack, archived: boolean) => act(() => api(`/api/packs/${p.id}/archive`, { archived }));
  const releases = (p: Pack) => act(async () => setHistory(await api<Releases>(`/api/packs/${p.id}/versions`)));
  const restore = (id: string, version: number) =>
    act(async () => {
      await api(`/api/packs/${id}/restore`, { version });
      setHistory(await api<Releases>(`/api/packs/${id}/versions`));
    });

  const edit = async (p: Pack) => {
    setError(null);
    setOpening(p.id);
    try {
      setEditing(await api<Draft>(`/api/packs/${p.id}/edit`, {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOpening(null);
    }
  };

  if (importing || editing)
    return (
      <Import
        me={me}
        editing={editing}
        packs={packs ?? []}
        onDone={async () => {
          setImporting(false);
          setEditing(null);
          await reload();
        }}
      />
    );
  return (
    <div className="cq-page">
      <PageHead
        title="Brand packs"
        description="Each company's template, charter and voice. A new pack is visible to your teams only until you share it. Its owner and the admins edit it; every save is a release you can roll back."
      >
        {(me.admin || packs?.some((p) => p.editable)) && (
          <Button variant="outline" onClick={(e) => go(e, "/settings/compliance")}>
            <ShieldCheck /> Compliance
          </Button>
        )}
        <Button onClick={() => setImporting(true)}>
          <Upload /> Import a template
        </Button>
      </PageHead>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {opening && <Spinner label={`Opening ${opening}: rendering its template`} />}
      {!packs ? (
        <Spinner label="Loading packs" />
      ) : (
        <Card className="cq-table-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pack</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Languages</TableHead>
                <TableHead>Visible to</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {packs.map((p) => (
                <TableRow key={p.id} data-pack={p.id} className={p.archived ? "cq-muted" : undefined}>
                  <TableCell>
                    <a href={`/settings/packs/${p.id}`} onClick={(e) => go(e, `/settings/packs/${p.id}`)} title="Open its charter">
                      <strong>{p.name}</strong>
                    </a>{" "}
                    <span className="cq-mono cq-muted">
                      {p.id} · v{p.version}
                      {p.pack_version ? ` · release ${p.pack_version}` : ""}
                    </span>{" "}
                    {p.extends && (
                      <Tag tone="info" title={`Inherits voice, storyline, exemplar and lint rules from ${p.extends}`}>
                        <GitBranch /> extends {p.extends}
                      </Tag>
                    )}{" "}
                    {p.archived && (
                      <Tag tone="warning">
                        <Archive /> Archived
                      </Tag>
                    )}
                  </TableCell>
                  <TableCell>{p.owner ?? <span className="cq-muted">Admins</span>}</TableCell>
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
                  <TableCell className="cq-row-actions">
                    {p.editable && (
                      <Button size="sm" variant="outline" disabled={!!opening} onClick={() => void edit(p)}>
                        <Pencil /> Edit
                      </Button>
                    )}
                    {p.editable && p.visibility === "team" && (
                      <Button size="sm" variant="outline" onClick={() => share(p, "workspace")}>
                        Share with the workspace
                      </Button>
                    )}
                    {p.editable && (
                      <Button size="sm" variant="ghost" onClick={() => setRestricting({ pack: p, teams: p.visibility === "team" ? p.teams : me.teams })}>
                        <Lock /> {p.visibility === "team" ? "Teams" : "Restrict to teams"}
                      </Button>
                    )}
                    {p.editable && (
                      <Button size="sm" variant="ghost" onClick={() => void releases(p)}>
                        <History /> History
                      </Button>
                    )}
                    {p.editable && (
                      <Button size="sm" variant="ghost" onClick={() => void archive(p, !p.archived)}>
                        {p.archived ? (
                          <>
                            <ArchiveRestore /> Unarchive
                          </>
                        ) : (
                          <>
                            <Archive /> Archive
                          </>
                        )}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {restricting && (
        <Dialog title={`Who sees ${restricting.pack.name}`} onClose={() => setRestricting(null)}>
          <p className="cq-hint">The teams picked, and its owner. Nobody picked: its owner only.</p>
          <TeamPicker options={me.teams} value={restricting.teams} onChange={(teams) => setRestricting({ ...restricting, teams })} />
          <Button
            onClick={() => {
              void share(restricting.pack, "team", restricting.teams);
              setRestricting(null);
            }}
          >
            Restrict to {restricting.teams.length ? restricting.teams.join(", ") : "its owner"}
          </Button>
        </Dialog>
      )}
      {history && (
        <Card className="cq-table-card" data-history={history.id}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Release of {history.id}</TableHead>
                <TableHead>Note</TableHead>
                <TableHead>By</TableHead>
                <TableHead>When</TableHead>
                <TableHead className="cq-row-actions">
                  <Button size="sm" variant="ghost" onClick={() => setHistory(null)}>
                    <X /> Close
                  </Button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.versions.map((v) => (
                <TableRow key={v.version}>
                  <TableCell>
                    {v.version}
                    {v.version === history.current && (
                      <>
                        {" "}
                        <Tag tone="success">Current</Tag>
                      </>
                    )}
                  </TableCell>
                  <TableCell>{v.note}</TableCell>
                  <TableCell>{v.author ?? <span className="cq-muted">seeded</span>}</TableCell>
                  <TableCell>{new Date(v.created_at).toLocaleString()}</TableCell>
                  <TableCell className="cq-row-actions">
                    {v.version !== history.current && (
                      <Button size="sm" variant="outline" onClick={() => void restore(history.id, v.version)}>
                        Restore
                      </Button>
                    )}
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

/** Pick teams: the caller's (`options`), and any other by name (an admin restricts to teams they are not in). */
function TeamPicker({ options, value, onChange }: { options: string[]; value: string[]; onChange: (teams: string[]) => void }) {
  const [other, setOther] = useState("");
  const add = () => {
    const t = other.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setOther("");
  };
  return (
    <div className="cq-team-pick">
      {[...new Set([...options, ...value])].map((t) => (
        <label key={t} className="cq-check">
          <input type="checkbox" checked={value.includes(t)} onChange={(e) => onChange(e.target.checked ? [...value, t] : value.filter((x) => x !== t))} />
          {t}
        </label>
      ))}
      <Input
        aria-label="Another team"
        placeholder="Another team, then Enter"
        value={other}
        onChange={(e) => setOther(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          add();
        }}
      />
    </div>
  );
}

interface Draft {
  draft_id: string;
  manifest: Record<string, unknown> & {
    roles: Record<string, number[]> & { archetypes?: Record<string, number[]> };
    never_clone: number[];
    default_language: string | null;
    lint: { placeholders?: string[]; extra_fonts?: string[]; extra_colors?: string[] };
  };
  slides: { number: number; layout: string; texts: string[]; image_url: string }[];
  /** Archetype names a slide may be declared as (core/forms.yaml). */
  archetypes: string[];
  /** Resolved token values, on import: token path -> hex colour or font family. */
  review?: { colors: Record<string, string>; fonts: Record<string, string> };
  /** Set when the draft edits a published pack. */
  voice?: string;
  fonts?: string[];
}

const ROLES = ["cover", "summary", "divider", "subsection", "content", "closing", "appendix"] as const;
const NONE = "none";
const NEVER = "never";

/** Role per slide from the draft manifest (the first role wins). */
function rolesOf(d: Draft): Record<number, string> {
  const out: Record<number, string> = {};
  for (const s of d.slides) out[s.number] = d.manifest.never_clone.includes(s.number) ? NEVER : NONE;
  for (const r of ROLES) for (const n of d.manifest.roles[r] ?? []) if (out[n] === NONE) out[n] = r;
  return out;
}

/** Archetype per slide from the draft manifest (the first archetype wins). */
function archetypesOf(d: Draft): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [a, ns] of Object.entries(d.manifest.roles.archetypes ?? {})) for (const n of ns) out[n] ??= a;
  return out;
}

/** Import a template, or (`editing`) review and republish an existing pack: same review screen. */
function Import({ me, editing, packs, onDone }: { me: Me; editing?: Draft | null; packs: Pack[]; onDone: () => Promise<void> }) {
  const [id, setId] = useState("");
  const [name, setName] = useState(editing ? String(editing.manifest.name ?? "") : "");
  const [template, setTemplate] = useState<File | null>(null);
  const [tokens, setTokens] = useState<File | null>(null);
  const [draft, setDraft] = useState<Draft | null>(editing ?? null);
  const [roles, setRoles] = useState<Record<number, string>>(editing ? rolesOf(editing) : {});
  const [archetypes, setArchetypes] = useState<Record<number, string>>(editing ? archetypesOf(editing) : {});
  const [families, setFamilies] = useState<string[]>(editing?.manifest.lint.extra_fonts ?? []);
  const [language, setLanguage] = useState(editing ? (editing.manifest.default_language ?? "") : "en");
  const [placeholders, setPlaceholders] = useState((editing?.manifest.lint.placeholders ?? []).join("\n"));
  const [voice, setVoice] = useState(editing?.voice ?? "");
  const [fonts, setFonts] = useState<string[]>(editing?.fonts ?? []);
  const [visibility, setVisibility] = useState<"team" | "workspace">("team");
  const [teams, setTeams] = useState<string[]>(me.teams);
  const [parent, setParent] = useState(editing ? String(editing.manifest.extends ?? "") : "");
  const [note, setNote] = useState("");
  const [newTokens, setNewTokens] = useState<string | null>(null);
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
      if (tokens) form.set("tokens", tokens);
      const d = await upload<Draft>("/api/packs/drafts", form);
      setDraft(d);
      setRoles(rolesOf(d));
      setArchetypes(archetypesOf(d));
      setFamilies(d.manifest.lint.extra_fonts ?? []);
      setLanguage(d.manifest.default_language ?? "en");
      setPlaceholders((d.manifest.lint.placeholders ?? []).join("\n"));
    });
  }

  async function publish() {
    if (!draft) return;
    await step("Validating: template lint and a test deck", async () => {
      const assigned = Object.entries(roles);
      const declared: Record<string, number[]> = {};
      for (const [n, a] of Object.entries(archetypes)) if (a !== NONE) (declared[a] ??= []).push(Number(n));
      const manifest = {
        ...draft.manifest,
        extends: parent || undefined, // none: left out of the JSON
        ...(editing ? { name: name || draft.manifest.name } : {}),
        default_language: language || null,
        roles: {
          ...Object.fromEntries(
            ROLES.map((r) => [r, assigned.filter(([, v]) => v === r).map(([n]) => Number(n))]).filter(([, ns]) => (ns as number[]).length),
          ),
          ...(Object.keys(declared).length ? { archetypes: declared } : {}),
        },
        never_clone: assigned.filter(([, v]) => v === NEVER).map(([n]) => Number(n)),
        lint: { ...draft.manifest.lint, extra_fonts: families.map((f) => f.trim()).filter(Boolean), placeholders: placeholders.split("\n").map((l) => l.trim()).filter(Boolean) },
      };
      const r = await api<{ status: string; problems?: string[] }>(`/api/packs/drafts/${draft.draft_id}/publish`, {
        manifest,
        visibility,
        teams,
        ...(voice.trim() || editing ? { voice } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (r.status === "published") await onDone();
      else setProblems(r.problems ?? ["the pack did not validate"]);
    });
  }

  /** A new template.pptx: the extractor re-drafts the slides and their roles, to review again. */
  const swapTemplate = (file: File, d: Draft) =>
    step("Reading the new template", async () => {
      const form = new FormData();
      form.set("template", file);
      const next = await upload<Draft>(`/api/packs/drafts/${d.draft_id}/template`, form);
      const t = Date.now(); // same image URLs, new pictures
      const fresh = { ...next, slides: next.slides.map((s) => ({ ...s, image_url: `${s.image_url}?t=${t}` })) };
      setDraft(fresh);
      setRoles(rolesOf(fresh));
      setPlaceholders((fresh.manifest.lint.placeholders ?? []).join("\n"));
      setFamilies(fresh.manifest.lint.extra_fonts ?? []);
    });
  const swapTokens = (file: File, d: Draft) =>
    step("Uploading tokens.json", async () => {
      const form = new FormData();
      form.set("tokens", file);
      const r = await upload<{ review: NonNullable<Draft["review"]> }>(`/api/packs/drafts/${d.draft_id}/tokens`, form);
      setDraft({ ...d, review: r.review });
      setNewTokens(file.name);
    });

  const stage = !draft ? 0 : 1;
  return (
    <div className="cq-page">
      <PageHead
        title={editing ? `Edit ${String(editing.manifest.name ?? editing.manifest.id)}` : "Import a template"}
        description={
          editing
            ? "Change the template, tokens, slide roles, language, placeholders, voice or fonts. The pack must still lint clean and build a clean test deck before it becomes the next release; the current one is kept for rollback."
            : draft ? "Check the role of each slide, then validate: the template must lint clean and a test deck must build clean." : "The company's official template.pptx."
        }
      >
        <Button variant="ghost" onClick={() => void onDone()}>
          <X /> Cancel
        </Button>
      </PageHead>
      {!editing && (
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
      )}
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
            accept=".pptx,.potx"
            title={template ? template.name : "Drop the template (.pptx or .potx) here"}
            hint="or click to choose it"
            onFiles={(f) => setTemplate(f[0] ?? null)}
          />
          <FileDrop
            label="Tokens file"
            accept=".json"
            title={tokens ? tokens.name : "Optional: the company's tokens.json"}
            hint="Design tokens (DTCG). Without it, colours and fonts are drafted from the template."
            onFiles={(f) => setTokens(f[0] ?? null)}
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
                <select
                  className="cq-select"
                  aria-label={`Archetype of slide ${s.number}`}
                  value={archetypes[s.number] ?? NONE}
                  onChange={(e) => setArchetypes({ ...archetypes, [s.number]: e.target.value })}
                >
                  <option value={NONE}>No archetype</option>
                  {draft.archetypes.map((a) => (
                    <option key={a} value={a}>
                      {a.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
          {draft.review && (
            <div className="cq-card cq-form">
              <FieldSet>
                <FieldLegend variant="label">Colours</FieldLegend>
                <ul className="cq-swatches">
                  {Object.entries(draft.review.colors).map(([path, hex]) => (
                    <li key={path} title={path}>
                      <svg className="cq-swatch" viewBox="0 0 1 1" aria-hidden>
                        <rect width="1" height="1" fill={`#${hex}`} />
                      </svg>
                      <span className="cq-mono">{path.replace(/^(theme|role\.color)\./, "")}</span>
                      <span className="cq-mono cq-muted">#{hex}</span>
                    </li>
                  ))}
                </ul>
              </FieldSet>
              <FieldSet>
                <FieldLegend variant="label">Fonts</FieldLegend>
                <ul className="cq-swatches">
                  {Object.entries(draft.review.fonts).map(([path, family]) => (
                    <li key={path}>
                      <span className="cq-mono">{path.replace(/^(theme|role)\.font\./, "")}</span> {family}
                    </li>
                  ))}
                </ul>
              </FieldSet>
            </div>
          )}
          <div className="cq-columns">
            <div className="cq-card cq-form">
              {editing && (
                <Field label="Name" htmlFor="p-edit-name">
                  <Input id="p-edit-name" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
              )}
              <Field label="What changed" htmlFor="p-note" hint="One line for the pack's history.">
                <Input id="p-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={editing ? "New logo on the cover" : "First release"} />
              </Field>
              <Field label="Group pack" htmlFor="p-extends" hint="A subsidiary inherits its group's voice, storyline, exemplar and lint rules, unless it sets its own. Template and tokens stay its own.">
                <select id="p-extends" className="cq-select" value={parent} onChange={(e) => setParent(e.target.value)}>
                  <option value="">None</option>
                  {packs
                    .filter((p) => p.id !== draft.manifest.id && !p.archived)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.id})
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Default language" htmlFor="p-lang" hint="Empty: ask for the language of every deck.">
                <Input id="p-lang" value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en" />
              </Field>
              <Field label="Template placeholders" htmlFor="p-ph" hint="Sample copy that must never survive in a deck, one per line.">
                <Textarea id="p-ph" rows={5} value={placeholders} onChange={(e) => setPlaceholders(e.target.value)} />
              </Field>
              {!editing && (
                <FieldSet>
                  <FieldLegend variant="label">Visible to</FieldLegend>
                  <label className="cq-check">
                    <input type="radio" name="visibility" value="team" checked={visibility === "team"} onChange={() => setVisibility("team")} />
                    These teams ({teams.join(", ") || "only me"})
                  </label>
                  {visibility === "team" && <TeamPicker options={me.teams} value={teams} onChange={setTeams} />}
                  <label className="cq-check">
                    <input type="radio" name="visibility" value="workspace" checked={visibility === "workspace"} onChange={() => setVisibility("workspace")} />
                    The whole workspace
                  </label>
                </FieldSet>
              )}
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
                      const r = await upload<{ fonts: string[]; family: string }>(`/api/packs/drafts/${draft.draft_id}/fonts`, form);
                      setFonts(r.fonts);
                      setFamilies((fs) => (fs.includes(r.family) ? fs : [...fs, r.family]));
                    }
                  })
                }
              />
              <Field label="Allowed fonts" htmlFor="p-fonts" hint="Faces used on the template's slides and in the uploaded font files, besides the theme's. Lint flags any other.">
                <Textarea id="p-fonts" rows={3} value={families.join("\n")} onChange={(e) => setFamilies(e.target.value.split("\n"))} />
              </Field>
              {editing && (
                <FileDrop
                  label="Template"
                  accept=".pptx,.potx"
                  title="Replace the template (.pptx or .potx)"
                  hint="Slides and roles are read again from it; review them before saving."
                  onFiles={(f) => f[0] && void swapTemplate(f[0], draft)}
                />
              )}
              {editing && (
                <FileDrop
                  label="Design tokens"
                  accept=".json"
                  title={newTokens ?? "Replace the tokens.json"}
                  hint="DTCG colours and fonts, the pack's source of truth. The template must lint clean against them."
                  onFiles={(f) => f[0] && void swapTokens(f[0], draft)}
                />
              )}
            </div>
          </div>
          <div>
            <Button size="lg" disabled={!!busy} onClick={() => void publish()}>
              {editing ? "Validate and save" : "Validate and publish"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
