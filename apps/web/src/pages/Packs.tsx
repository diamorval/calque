import { Alert, AlertDescription, AlertTitle } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { Card } from "diametral-ds/card";
import { FieldLegend, FieldSet } from "diametral-ds/field";
import { Input } from "diametral-ds/input";
import { Stepper, StepperIndicator, StepperItem, StepperSeparator, StepperTitle } from "diametral-ds/stepper";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "diametral-ds/table";
import { Tag } from "diametral-ds/tag";
import { Textarea } from "diametral-ds/textarea";
import { Archive, ArchiveRestore, Eye, FileUp, GitBranch, Globe, History, Lock, Pencil, Plus, ShieldCheck, Star, Trash2, Upload, Users, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";
import { api, upload, type Me, type Pack } from "../api.ts";
import { dateTime, t } from "../i18n.ts";
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
  const [managing, setManaging] = useState<{ pack: Pack; managers: string[] } | null>(null);
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
  const saveManagers = (p: Pack, managers: string[]) => act(() => api(`/api/packs/${p.id}/managers`, { managers }));
  const makeDefault = (p: Pack, on: boolean) => act(() => api(`/api/packs/${p.id}/default`, { default: on }));
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
        title={t("Brand packs")}
        description={t("Each company's template, charter and voice. A new pack is visible to your teams only; an admin shares it with the whole workspace. Its owner, its co-managers and the admins edit it; every save is a release you can roll back.")}
      >
        {(me.admin || packs?.some((p) => p.editable)) && (
          <Button variant="outline" onClick={(e) => go(e, "/settings/compliance")}>
            <ShieldCheck /> {t("Compliance")}
          </Button>
        )}
        <Button onClick={() => setImporting(true)}>
          <Upload /> {t("Import a template")}
        </Button>
      </PageHead>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {opening && <Spinner label={t("Opening {id}: rendering its template", { id: opening })} />}
      {!packs ? (
        <Spinner label={t("Loading packs")} />
      ) : (
        <Card className="cq-table-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Pack")}</TableHead>
                <TableHead>{t("Owner")}</TableHead>
                <TableHead>{t("Languages")}</TableHead>
                <TableHead>{t("Visible to")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {packs.map((p) => (
                <TableRow key={p.id} data-pack={p.id} className={p.archived ? "cq-muted" : undefined}>
                  <TableCell>
                    <a href={`/settings/packs/${p.id}`} onClick={(e) => go(e, `/settings/packs/${p.id}`)} title={t("Open its charter")}>
                      <strong>{p.name}</strong>
                    </a>{" "}
                    <span className="cq-mono cq-muted">
                      {p.id} · v{p.version}
                      {p.pack_version ? ` · ${t("release {n}", { n: p.pack_version })}` : ""}
                    </span>{" "}
                    {p.extends && (
                      <Tag tone="info" title={t("Inherits voice, storyline, exemplar and lint rules from {pack}", { pack: p.extends })}>
                        <GitBranch /> {t("extends {pack}", { pack: p.extends })}
                      </Tag>
                    )}{" "}
                    {p.archived && (
                      <Tag tone="warning">
                        <Archive /> {t("Archived")}
                      </Tag>
                    )}
                    {p.default && (
                      <Tag tone="success">
                        <Star /> {t("Default")}
                      </Tag>
                    )}
                  </TableCell>
                  <TableCell>
                    {p.owner ?? <span className="cq-muted">{t("Admins")}</span>}
                    {p.managers?.length ? <div className="cq-hint">with {p.managers.join(", ")}</div> : null}
                  </TableCell>
                  <TableCell>{p.languages.join(", ")}</TableCell>
                  <TableCell>
                    {p.visibility === "workspace" ? (
                      <Tag tone="info">
                        <Globe /> {t("Workspace")}
                      </Tag>
                    ) : (
                      <Tag tone="neutral">
                        <Lock /> {p.teams.join(", ") || t("Owner only")}
                      </Tag>
                    )}
                  </TableCell>
                  <TableCell className="cq-row-actions">
                    {p.editable && (
                      <Button size="sm" variant="outline" disabled={!!opening} onClick={() => void edit(p)}>
                        <Pencil /> {t("Edit")}
                      </Button>
                    )}
                    {me.admin && p.visibility === "team" && (
                      <Button size="sm" variant="outline" onClick={() => share(p, "workspace")}>
                        {t("Share with the workspace")}
                      </Button>
                    )}
                    {p.editable && (
                      <Button size="sm" variant="ghost" onClick={() => setRestricting({ pack: p, teams: p.visibility === "team" ? p.teams : me.teams })}>
                        <Lock /> {p.visibility === "team" ? t("Teams") : t("Restrict to teams")}
                      </Button>
                    )}
                    {(me.admin || (p.owner !== null && p.owner === me.id)) && (
                      <Button size="sm" variant="ghost" onClick={() => setManaging({ pack: p, managers: p.managers ?? [] })}>
                        <Users /> Managers
                      </Button>
                    )}
                    {p.editable && (
                      <Button size="sm" variant="ghost" onClick={() => void releases(p)}>
                        <History /> {t("History")}
                      </Button>
                    )}
                    {me.admin && (p.default || (p.visibility === "workspace" && !p.archived)) && (
                      <Button size="sm" variant="ghost" title={t("The pack New deck preselects for everyone")} onClick={() => void makeDefault(p, !p.default)}>
                        <Star /> {p.default ? t("Unset default") : t("Make default")}
                      </Button>
                    )}
                    {p.editable && (
                      <Button size="sm" variant="ghost" onClick={() => void archive(p, !p.archived)}>
                        {p.archived ? (
                          <>
                            <ArchiveRestore /> {t("Unarchive")}
                          </>
                        ) : (
                          <>
                            <Archive /> {t("Archive")}
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
        <Dialog title={t("Who sees {name}", { name: restricting.pack.name })} onClose={() => setRestricting(null)}>
          <p className="cq-hint">{t("The teams picked, and its owner. Nobody picked: its owner only.")}</p>
          <TeamPicker options={me.teams} value={restricting.teams} onChange={(teams) => setRestricting({ ...restricting, teams })} />
          <Button
            onClick={() => {
              void share(restricting.pack, "team", restricting.teams);
              setRestricting(null);
            }}
          >
            {restricting.teams.length ? t("Restrict to {teams}", { teams: restricting.teams.join(", ") }) : t("Restrict to its owner")}
          </Button>
        </Dialog>
      )}
      {managing && (
        <Dialog title={`Who manages ${managing.pack.name}`} onClose={() => setManaging(null)}>
          <p className="cq-hint">Besides its owner{managing.pack.owner ? ` (${managing.pack.owner})` : ""} and the admins: they edit it, restrict it to teams, archive it and roll it back.</p>
          <TeamPicker options={[]} value={managing.managers} placeholder="A user id, then Enter" onChange={(managers) => setManaging({ ...managing, managers })} />
          <Button
            onClick={() => {
              void saveManagers(managing.pack, managing.managers);
              setManaging(null);
            }}
          >
            Save managers
          </Button>
        </Dialog>
      )}
      {history && (
        <Card className="cq-table-card" data-history={history.id}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Release of {id}", { id: history.id })}</TableHead>
                <TableHead>{t("Note")}</TableHead>
                <TableHead>{t("By")}</TableHead>
                <TableHead>{t("When")}</TableHead>
                <TableHead className="cq-row-actions">
                  <Button size="sm" variant="ghost" onClick={() => setHistory(null)}>
                    <X /> {t("Close")}
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
                        <Tag tone="success">{t("Current")}</Tag>
                      </>
                    )}
                  </TableCell>
                  <TableCell>{v.note}</TableCell>
                  <TableCell>{v.author ?? <span className="cq-muted">{t("seeded")}</span>}</TableCell>
                  <TableCell>{dateTime(v.created_at)}</TableCell>
                  <TableCell className="cq-row-actions">
                    {v.version !== history.current && (
                      <Button size="sm" variant="outline" onClick={() => void restore(history.id, v.version)}>
                        {t("Restore")}
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

/** Pick teams: the caller's (`options`), and any other by name (an admin restricts to teams they are not in).
Also picks a pack's co-managers (user ids, no options). */
function TeamPicker({ options, value, onChange, placeholder = "Another team, then Enter" }: { options: string[]; value: string[]; onChange: (teams: string[]) => void; placeholder?: string }) {
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
        aria-label={placeholder.replace(/, then Enter$/, "")}
        placeholder={placeholder}
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
    lint: { placeholders?: string[]; extra_fonts?: string[]; extra_colors?: string[]; slop_rules?: Rule[] };
  };
  slides: { number: number; layout: string; texts: string[]; image_url: string }[];
  /** Archetype names a slide may be declared as (core/forms.yaml). */
  archetypes: string[];
  /** Resolved token values, on import: token path -> hex colour or font family. */
  review?: { colors: Record<string, string>; fonts: Record<string, string> };
  /** Set when the draft edits a published pack. */
  voice?: string;
  fonts?: string[];
  /** The pack's own exemplar.md and storyline.md ("" when it has none), exemplar pages and logo asset. */
  exemplar?: string;
  storyline?: string;
  exemplar_images?: string[];
  logo?: string | null;
}

/** A pack lint rule (pack.yaml lint.slop_rules): a regular expression and the message lint reports. */
interface Rule {
  severity: "ERROR" | "WARN";
  lang: string;
  pattern: string;
  note: string;
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
  const [rules, setRules] = useState<Rule[]>(editing?.manifest.lint.slop_rules ?? []);
  const [exemplar, setExemplar] = useState(editing?.exemplar ?? "");
  const [storyline, setStoryline] = useState(editing?.storyline ?? "");
  const [pages, setPages] = useState<string[]>(editing?.exemplar_images ?? []);
  const [logo, setLogo] = useState<string | null>(editing?.logo ?? null);
  const [preview, setPreview] = useState<{ number: number; image_url: string }[] | null>(null);
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
    await step(t("Reading the template"), async () => {
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

  /** The manifest as reviewed on this screen. */
  function manifestOf(draft: Draft) {
    const assigned = Object.entries(roles);
    const declared: Record<string, number[]> = {};
    for (const [n, a] of Object.entries(archetypes)) if (a !== NONE) (declared[a] ??= []).push(Number(n));
    const lint = { ...draft.manifest.lint };
    delete lint.slop_rules;
    const kept = rules.filter((r) => r.pattern.trim()).map((r) => ({ ...r, lang: r.lang.trim() || "any", note: r.note.trim() || "pack rule" }));
    return {
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
      lint: {
        ...lint,
        extra_fonts: families.map((f) => f.trim()).filter(Boolean),
        placeholders: placeholders.split("\n").map((l) => l.trim()).filter(Boolean),
        // none: no key, so a subsidiary inherits its group's rules
        ...(kept.length ? { slop_rules: kept } : {}),
      },
    };
  }

  async function publish() {
    if (!draft) return;
    await step(t("Validating: template lint and a test deck"), async () => {
      const r = await api<{ status: string; problems?: string[] }>(`/api/packs/drafts/${draft.draft_id}/publish`, {
        manifest: manifestOf(draft),
        visibility,
        teams,
        ...(voice.trim() || editing ? { voice } : {}),
        ...(editing ? { exemplar, storyline } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (r.status === "published") await onDone();
      else setProblems(r.problems ?? [t("the pack did not validate")]);
    });
  }

  /** A new template.pptx: the extractor re-drafts the slides and their roles, to review again. */
  const swapTemplate = (file: File, d: Draft) =>
    step(t("Reading the new template"), async () => {
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
    step(t("Uploading tokens.json"), async () => {
      const form = new FormData();
      form.set("tokens", file);
      const r = await upload<{ review: NonNullable<Draft["review"]> }>(`/api/packs/drafts/${d.draft_id}/tokens`, form);
      setDraft({ ...d, review: r.review });
      setNewTokens(file.name);
    });

  /** The change on a sample deck (cover, content, closing) built on the draft, before publishing. */
  const previewSample = (d: Draft) =>
    step("Building a sample deck on this draft", async () => {
      setPreview((await api<{ slides: { number: number; image_url: string }[] }>(`/api/packs/drafts/${d.draft_id}/preview`, { manifest: manifestOf(d) })).slides);
    });
  const addPages = (files: File[], d: Draft) =>
    step("Uploading exemplar pages", async () => {
      for (const f of files) {
        const form = new FormData();
        form.set("image", f);
        setPages((await upload<{ exemplar_images: string[] }>(`/api/packs/drafts/${d.draft_id}/exemplar`, form)).exemplar_images);
      }
    });
  const removePage = (name: string, d: Draft) =>
    step("Removing an exemplar page", async () => {
      setPages((await api<{ exemplar_images: string[] }>(`/api/packs/drafts/${d.draft_id}/exemplar/remove`, { name })).exemplar_images);
    });
  const swapLogo = (file: File, d: Draft) =>
    step("Uploading the logo", async () => {
      const form = new FormData();
      form.set("logo", file);
      setLogo((await upload<{ logo: string }>(`/api/packs/drafts/${d.draft_id}/logo`, form)).logo);
    });
  const setRule = (i: number, patch: Partial<Rule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const stage = !draft ? 0 : 1;
  return (
    <div className="cq-page">
      <PageHead
        title={editing ? t("Edit {name}", { name: String(editing.manifest.name ?? editing.manifest.id) }) : t("Import a template")}
        description={
          editing
            ? "Change the template, tokens, logo, slide roles, language, placeholders, lint rules, voice, exemplar, storyline or fonts. The pack must still lint clean and build a clean test deck before it becomes the next release; the current one is kept for rollback, and decks move to it only when their authors update them."
            : draft ? "Check the role of each slide, then validate: the template must lint clean and a test deck must build clean." : "The company's official template.pptx."
        }
      >
        <Button variant="ghost" onClick={() => void onDone()}>
          <X /> {t("Cancel")}
        </Button>
      </PageHead>
      {!editing && (
        <Stepper>
          {[t("Upload the template"), t("Review slide roles"), t("Validate and publish")].map((label, i) => (
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
          <AlertTitle>{t("The pack is not valid yet")}</AlertTitle>
          <AlertDescription>
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </AlertDescription>
        </Alert>
      )}

      {!draft ? (
        <form onSubmit={extract} className="cq-card cq-form">
          <Field label={t("Pack id")} htmlFor="p-id" hint={t("Lowercase letters, digits and dashes.")}>
            <Input id="p-id" required pattern="[a-z0-9][a-z0-9-]*" value={id} onChange={(e) => setId(e.target.value)} placeholder="acme" />
          </Field>
          <Field label={t("Name")} htmlFor="p-name">
            <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme" />
          </Field>
          <FileDrop
            label={t("Template file")}
            accept=".pptx,.potx"
            title={template ? template.name : t("Drop the template (.pptx or .potx) here")}
            hint={t("or click to choose it")}
            onFiles={(f) => setTemplate(f[0] ?? null)}
          />
          <FileDrop
            label={t("Tokens file")}
            accept=".json"
            title={tokens ? tokens.name : t("Optional: the company's tokens.json")}
            hint={t("Design tokens (DTCG). Without it, colours and fonts are drafted from the template.")}
            onFiles={(f) => setTokens(f[0] ?? null)}
          />
          <Button type="submit" disabled={!template || !id || !!busy}>
            <FileUp /> {t("Read the template")}
          </Button>
        </form>
      ) : (
        <>
          <ul className="cq-template-grid">
            {draft.slides.map((s) => (
              <li key={s.number} className="cq-card cq-template" data-slide={s.number}>
                <img src={s.image_url} alt={t("Template slide {n}", { n: s.number })} />
                <div>
                  <strong>{t("Slide {n}", { n: s.number })}</strong>
                  <span className="cq-hint">{s.layout}</span>
                </div>
                <select className="cq-select" aria-label={t("Role of slide {n}", { n: s.number })} value={roles[s.number] ?? NONE} onChange={(e) => setRoles({ ...roles, [s.number]: e.target.value })}>
                  <option value={NONE}>{t("No role")}</option>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                  <option value={NEVER}>{t("Never clone")}</option>
                </select>
                <select
                  className="cq-select"
                  aria-label={t("Archetype of slide {n}", { n: s.number })}
                  value={archetypes[s.number] ?? NONE}
                  onChange={(e) => setArchetypes({ ...archetypes, [s.number]: e.target.value })}
                >
                  <option value={NONE}>{t("No archetype")}</option>
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
                <FieldLegend variant="label">{t("Colours")}</FieldLegend>
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
                <FieldLegend variant="label">{t("Fonts")}</FieldLegend>
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
                <Field label={t("Name")} htmlFor="p-edit-name">
                  <Input id="p-edit-name" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
              )}
              <Field label={t("What changed")} htmlFor="p-note" hint={t("One line for the pack's history.")}>
                <Input id="p-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={editing ? t("New logo on the cover") : t("First release")} />
              </Field>
              <Field label={t("Group pack")} htmlFor="p-extends" hint={t("A subsidiary inherits its group's voice, storyline, exemplar and lint rules, unless it sets its own. Template and tokens stay its own.")}>
                <select id="p-extends" className="cq-select" value={parent} onChange={(e) => setParent(e.target.value)}>
                  <option value="">{t("None")}</option>
                  {packs
                    .filter((p) => p.id !== draft.manifest.id && !p.archived)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.id})
                      </option>
                    ))}
                </select>
              </Field>
              <Field label={t("Default language")} htmlFor="p-lang" hint={t("Empty: ask for the language of every deck.")}>
                <Input id="p-lang" value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en" />
              </Field>
              <Field label={t("Template placeholders")} htmlFor="p-ph" hint={t("Sample copy that must never survive in a deck, one per line.")}>
                <Textarea id="p-ph" rows={5} value={placeholders} onChange={(e) => setPlaceholders(e.target.value)} />
              </Field>
              {!editing && me.admin && (
                <FieldSet>
                  <FieldLegend variant="label">{t("Visible to")}</FieldLegend>
                  <label className="cq-check">
                    <input type="radio" name="visibility" value="team" checked={visibility === "team"} onChange={() => setVisibility("team")} />
                    {t("These teams ({teams})", { teams: teams.join(", ") || t("only me") })}
                  </label>
                  {visibility === "team" && <TeamPicker options={me.teams} value={teams} onChange={setTeams} />}
                  <label className="cq-check">
                    <input type="radio" name="visibility" value="workspace" checked={visibility === "workspace"} onChange={() => setVisibility("workspace")} />
                    {t("The whole workspace")}
                  </label>
                </FieldSet>
              )}
              {!editing && !me.admin && (
                <FieldSet>
                  <FieldLegend variant="label">Visible to</FieldLegend>
                  <p className="cq-hint">These teams; an admin can share it with the whole workspace later.</p>
                  <TeamPicker options={me.teams} value={teams} onChange={setTeams} />
                </FieldSet>
              )}
            </div>
            <div className="cq-card cq-form">
              <Field label={t("Voice")} htmlFor="p-voice">
                <Textarea id="p-voice" rows={6} value={voice} onChange={(e) => setVoice(e.target.value)} placeholder={t("Tone, register, words to avoid…")} />
              </Field>
              <FileDrop
                label={t("Font files")}
                accept=".ttf,.otf"
                multiple
                title={fonts.length ? fonts.join(", ") : t("Brand fonts (.ttf, .otf)")}
                hint={t("Uploaded under your company's font license. Without them, slides render with the fallback fonts.")}
                onFiles={(files) =>
                  void step(t("Uploading fonts"), async () => {
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
              <Field label={t("Allowed fonts")} htmlFor="p-fonts" hint={t("Faces used on the template's slides and in the uploaded font files, besides the theme's. Lint flags any other.")}>
                <Textarea id="p-fonts" rows={3} value={families.join("\n")} onChange={(e) => setFamilies(e.target.value.split("\n"))} />
              </Field>
              {editing && (
                <FileDrop
                  label={t("Template")}
                  accept=".pptx,.potx"
                  title={t("Replace the template (.pptx or .potx)")}
                  hint={t("Slides and roles are read again from it; review them before saving.")}
                  onFiles={(f) => f[0] && void swapTemplate(f[0], draft)}
                />
              )}
              {editing && logo && (
                <FileDrop
                  label="Logo"
                  accept=".png,.svg,.jpg,.jpeg"
                  title={`Replace ${logo}`}
                  hint="The pack's logo file. A logo drawn on the template's slides changes with a new template."
                  onFiles={(f) => f[0] && void swapLogo(f[0], draft)}
                />
              )}
              {editing && (
                <FileDrop
                  label={t("Design tokens")}
                  accept=".json"
                  title={newTokens ?? t("Replace the tokens.json")}
                  hint={t("DTCG colours and fonts, the pack's source of truth. The template must lint clean against them.")}
                  onFiles={(f) => f[0] && void swapTokens(f[0], draft)}
                />
              )}
            </div>
          </div>
          <div className="cq-card cq-form" data-rules>
            <FieldSet>
              <FieldLegend variant="label">Lint rules</FieldLegend>
              <p className="cq-hint">
                What lint flags in every deck on this pack, besides the core rules: a regular expression (case ignored), its severity, the deck languages it applies to (any, en, fr…) and the message shown. Unlike the voice, these are enforced.
              </p>
              {rules.map((r, i) => (
                <div key={i} className="cq-rule">
                  <select className="cq-select" aria-label={`Severity of rule ${i + 1}`} value={r.severity} onChange={(e) => setRule(i, { severity: e.target.value as Rule["severity"] })}>
                    <option value="ERROR">ERROR</option>
                    <option value="WARN">WARN</option>
                  </select>
                  <Input aria-label={`Language of rule ${i + 1}`} value={r.lang} onChange={(e) => setRule(i, { lang: e.target.value })} placeholder="any" />
                  <Input aria-label={`Pattern of rule ${i + 1}`} className="cq-mono" value={r.pattern} onChange={(e) => setRule(i, { pattern: e.target.value })} placeholder="\\bsynergy\\b" />
                  <Input aria-label={`Message of rule ${i + 1}`} value={r.note} onChange={(e) => setRule(i, { note: e.target.value })} placeholder="What to write instead" />
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove rule ${i + 1}`} onClick={() => setRules(rules.filter((_, j) => j !== i))}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <div>
                <Button variant="outline" size="sm" onClick={() => setRules([...rules, { severity: "WARN", lang: "any", pattern: "", note: "" }])}>
                  <Plus /> Add a rule
                </Button>
              </div>
            </FieldSet>
          </div>
          {editing && (
            <div className="cq-columns">
              <div className="cq-card cq-form">
                <Field label="Exemplar" htmlFor="p-exemplar" hint="exemplar.md: what a good deck of this brand looks like. Empty: none (a subsidiary inherits its group's).">
                  <Textarea id="p-exemplar" rows={8} value={exemplar} onChange={(e) => setExemplar(e.target.value)} />
                </Field>
                <FileDrop
                  label="Exemplar pages"
                  accept=".png,.jpg,.jpeg,.svg,.webp"
                  multiple
                  title={pages.length ? `${pages.length} page(s)` : "Images of exemplary slides"}
                  hint="Shown with the exemplar in the brand portal and to the agent."
                  onFiles={(files) => void addPages(files, draft)}
                />
                {pages.length > 0 && (
                  <ul className="cq-file-list">
                    {pages.map((name) => (
                      <li key={name}>
                        <span className="cq-mono">{name}</span>
                        <Button variant="ghost" size="icon-sm" aria-label={`Remove ${name}`} onClick={() => void removePage(name, draft)}>
                          <X />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="cq-card cq-form">
                <Field label="Storyline" htmlFor="p-storyline" hint="storyline.md: the narrative arcs the agent proposes. Empty: none (a subsidiary inherits its group's).">
                  <Textarea id="p-storyline" rows={8} value={storyline} onChange={(e) => setStoryline(e.target.value)} />
                </Field>
              </div>
            </div>
          )}
          {preview && (
            <div className="cq-card cq-form" data-preview>
              <FieldLegend variant="label">Sample deck on this draft</FieldLegend>
              <ul className="cq-template-grid">
                {preview.map((s) => (
                  <li key={s.number} className="cq-template">
                    <img src={s.image_url} alt={`Sample slide ${s.number}`} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="cq-row-actions">
            <Button size="lg" variant="outline" disabled={!!busy} onClick={() => void previewSample(draft)}>
              <Eye /> Preview on a sample deck
            </Button>
            <Button size="lg" disabled={!!busy} onClick={() => void publish()}>
              {editing ? t("Validate and save") : t("Validate and publish")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
