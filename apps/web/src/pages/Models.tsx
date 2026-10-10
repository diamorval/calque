import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { Card } from "diametral-ds/card";
import { Checkbox } from "diametral-ds/checkbox";
import { DialogFooter } from "diametral-ds/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "diametral-ds/empty";
import { Input } from "diametral-ds/input";
import { Label } from "diametral-ds/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "diametral-ds/table";
import { Tabs, TabsList, TabsTrigger } from "diametral-ds/tabs";
import { Tag } from "diametral-ds/tag";
import { Textarea } from "diametral-ds/textarea";
import { KeyRound, Pencil, Server, Star, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Me } from "../api.ts";
import { num, t } from "../i18n.ts";
import { Dialog, Field, PageHead } from "../ui.tsx";

interface Provider {
  id: string;
  label: string;
  key: boolean;
  baseURL: boolean;
  defaultBaseURL?: string;
  example: string;
  modelLabel?: string;
  options?: ("resource" | "apiVersion" | "managedIdentity")[];
}
interface Model {
  id: string;
  provider: string;
  model: string;
  label: string | null;
  base_url: string | null;
  has_key: boolean;
  /** custom header names (values never come back) */
  headers?: string[];
  resource: string | null;
  api_version: string | null;
  managed_identity: boolean;
  is_default: boolean;
  /** restricted to these teams; []: everyone */
  teams: string[];
}
interface Data {
  providers: Provider[];
  models: Model[];
  /** admins: each team's default model id */
  team_defaults?: Record<string, string>;
}

/** Settings > AI models (PipesHub pattern): provider catalog, Configure, Configured, Set as default. */
export function Models({ me }: { me: Me }) {
  const [data, setData] = useState<Data | null>(null);
  const [tab, setTab] = useState<"configured" | "providers">("configured");
  const [editing, setEditing] = useState<{ provider: Provider; model?: Model } | null>(null);
  const [removing, setRemoving] = useState<Model | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => api<Data>("/api/models").then(setData), []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const provider = (id: string) => data?.providers.find((p) => p.id === id);
  const label = (id: string) => provider(id)?.label ?? id;

  return (
    <div className="cq-page">
      <PageHead title={t("AI models")} description={t("The models the web app's agent runs on. Keys are tested when saved and never shown again.")} />
      {!me.admin && (
        <Alert tone="info">
          <AlertDescription>{t("Only workspace admins change the models.")}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList variant="line">
          <TabsTrigger value="configured">{t("Configured")}</TabsTrigger>
          <TabsTrigger value="providers">{t("Providers")}</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "configured" &&
        (data?.models.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Server />
              </EmptyMedia>
              <EmptyTitle>{t("No model yet")}</EmptyTitle>
              <EmptyDescription>{t("Configure one from the Providers tab.")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card className="cq-table-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Provider")}</TableHead>
                  <TableHead>{t("Model")}</TableHead>
                  <TableHead>{t("Endpoint")}</TableHead>
                  <TableHead>{t("Teams")}</TableHead>
                  <TableHead>{t("Default")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.models.map((m) => (
                  <TableRow key={m.id} data-model={m.id}>
                    <TableCell>{label(m.provider)}</TableCell>
                    <TableCell>
                      <span className="cq-mono">{m.model}</span> {m.label && <Tag>{m.label}</Tag>}
                    </TableCell>
                    <TableCell className="cq-muted">{m.base_url ?? m.resource ?? "—"}</TableCell>
                    <TableCell>{m.teams?.length ? m.teams.map((t) => <Tag key={t}>{t}</Tag>) : <span className="cq-muted">{t("Everyone")}</span>}</TableCell>
                    <TableCell>
                      {m.is_default ? (
                        <Tag>{t("Default")}</Tag>
                      ) : (
                        me.admin && (
                          <Button size="sm" variant="outline" onClick={() => act(() => api(`/api/models/${encodeURIComponent(m.id)}/default`, {}))}>
                            <Star /> {t("Set as default")}
                          </Button>
                        )
                      )}
                    </TableCell>
                    <TableCell>
                      {me.admin && provider(m.provider) && (
                        <Button size="sm" variant="ghost" aria-label={t("Edit {name}", { name: m.id })} onClick={() => setEditing({ provider: provider(m.provider) as Provider, model: m })}>
                          <Pencil /> {t("Edit")}
                        </Button>
                      )}
                      {me.admin && (
                        <Button size="sm" variant="ghost" onClick={() => setRemoving(m)}>
                          <Trash2 /> {t("Remove")}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        ))}
      {tab === "configured" && me.admin && !!data?.models.length && (
        <TeamDefaults models={data.models} defaults={data.team_defaults ?? {}} onSet={(team, model_id) => act(() => api("/api/models/team-defaults", { team, model_id }))} />
      )}
      {tab === "configured" && me.admin && <UsageTable />}
      {tab === "providers" && (
        <ul className="cq-provider-grid">
          {data?.providers.map((p) => (
            <li key={p.id}>
              <Card className="cq-provider">
                <span className="cq-monogram" aria-hidden>
                  {p.label.slice(0, 1)}
                </span>
                <div>
                  <strong>{p.label}</strong>
                  <span className="cq-hint">
                    {p.key ? t("API key") : t("No key needed")}
                    {p.baseURL ? ` · ${t("your endpoint")}` : ""}
                  </span>
                </div>
                <Button size="sm" variant="outline" disabled={!me.admin} aria-label={t("Configure {name}", { name: p.label })} onClick={() => setEditing({ provider: p })}>
                  {t("Configure")}
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {removing && (
        <Dialog title={t("Remove {name}?", { name: `${label(removing.provider)} ${removing.model}` })} onClose={() => setRemoving(null)}>
          <div className="cq-dialog-body">
            <p>
              {t("The agent stops running on it, and its key is deleted.")}
              {removing.is_default && ` ${t("It is the default: the most recently configured model takes over.")}`}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              {t("Cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const id = removing.id;
                setRemoving(null);
                void act(() => api(`/api/models/${encodeURIComponent(id)}`, undefined, "DELETE"));
              }}
            >
              <Trash2 /> {t("Remove")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
      {editing && (
        <Configure
          provider={editing.provider}
          initial={editing.model}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            setTab("configured");
            await reload();
          }}
        />
      )}
    </div>
  );
}

/** "Name: value" per line -> headers; blank lines skipped. */
function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const i = line.indexOf(":");
    if (i < 1) throw new Error(t("Custom header \"{line}\": write Name: value", { line: line.trim() }));
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Configure a new model of `provider`, or edit `initial` (its key and headers kept unless retyped). */
function Configure(props: { provider: Provider; initial?: Model | undefined; onClose: () => void; onSaved: () => Promise<void> }) {
  const p = props.provider;
  const m = props.initial;
  const has = (o: NonNullable<Provider["options"]>[number]) => p.options?.includes(o) ?? false;
  const [model, setModel] = useState(m?.model ?? "");
  const [label, setLabel] = useState(m?.label ?? "");
  const [key, setKey] = useState("");
  const [base, setBase] = useState(m?.base_url ?? "");
  const [headers, setHeaders] = useState("");
  const [resource, setResource] = useState(m?.resource ?? "");
  const [apiVersion, setApiVersion] = useState(m?.api_version ?? "");
  const [identity, setIdentity] = useState(m?.managed_identity ?? false);
  const [isDefault, setDefault] = useState(m?.is_default ?? false);
  const [teams, setTeams] = useState((m?.teams ?? []).join(", "));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const extra = parseHeaders(headers);
      await api("/api/models", {
        ...(m ? { id: m.id } : {}),
        provider: p.id,
        model,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(key && !identity ? { api_key: key } : {}),
        ...(base ? { base_url: base } : {}),
        ...(Object.keys(extra).length ? { headers: extra } : {}),
        ...(resource ? { resource } : {}),
        ...(apiVersion ? { api_version: apiVersion } : {}),
        ...(identity ? { managed_identity: true } : {}),
        teams: teams
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        default: isDefault,
      });
      await props.onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={m ? t("Edit {name}", { name: m.id }) : t("Configure {name}", { name: p.label })} onClose={props.onClose}>
      <form onSubmit={save}>
        <div className="cq-dialog-body">
          <Field label={p.modelLabel ?? t("Model")} htmlFor="m-model">
            <Input id="m-model" required value={model} placeholder={p.example} onChange={(e) => setModel(e.target.value)} />
          </Field>
          <Field label={t("Label (optional)")} htmlFor="m-label" hint={t("Tells two configurations of one model apart: a region, a subsidiary.")}>
            <Input id="m-label" maxLength={40} value={label} placeholder="EU" onChange={(e) => setLabel(e.target.value)} />
          </Field>
          {has("managedIdentity") && (
            <Label className="cq-check">
              <Checkbox checked={identity} onCheckedChange={setIdentity} />
              {t("Sign in with the server's managed identity (Entra ID), no key")}
            </Label>
          )}
          {!identity && (
            <Field label={p.key && !m?.has_key ? t("API key") : t("API key (optional)")} htmlFor="m-key" hint={m?.has_key ? t("Leave empty to keep the stored key.") : undefined}>
              <Input id="m-key" type="password" autoComplete="off" required={p.key && !m?.has_key} value={key} onChange={(e) => setKey(e.target.value)} />
            </Field>
          )}
          {has("resource") && (
            <Field label={t("Resource name")} htmlFor="m-resource" hint={t("Or a base URL: an APIM gateway, a private endpoint.")}>
              <Input id="m-resource" value={resource} placeholder="my-openai-eu" onChange={(e) => setResource(e.target.value)} />
            </Field>
          )}
          <Field label={p.baseURL ? t("Base URL") : t("Base URL (optional)")} htmlFor="m-base">
            <Input id="m-base" type="url" required={p.baseURL} value={base} placeholder={p.defaultBaseURL ?? "https://…/v1"} onChange={(e) => setBase(e.target.value)} />
          </Field>
          {has("apiVersion") && (
            <Field label={t("API version (optional)")} htmlFor="m-version" hint={t("Empty: the v1 API. A dated version (2024-10-21) calls the deployment URL.")}>
              <Input id="m-version" value={apiVersion} placeholder="v1" onChange={(e) => setApiVersion(e.target.value)} />
            </Field>
          )}
          <Field
            label={t("Custom headers (optional)")}
            htmlFor="m-headers"
            hint={m?.headers?.length ? t("Leave empty to keep the stored ones ({names}).", { names: m.headers.join(", ") }) : t("One per line, e.g. Ocp-Apim-Subscription-Key: …, stored encrypted.")}
          >
            <Textarea id="m-headers" rows={2} value={headers} placeholder={t("Name: value")} onChange={(e) => setHeaders(e.target.value)} />
          </Field>
          <Field label={t("Teams (optional)")} htmlFor="m-teams" hint={t("Only these teams (and admins) may use it, e.g. a subsidiary's own contract. Empty: everyone.")}>
            <Input id="m-teams" value={teams} placeholder={t("sales, emea")} onChange={(e) => setTeams(e.target.value)} />
          </Field>
          <Label className="cq-check">
            <Checkbox checked={isDefault} onCheckedChange={setDefault} />
            {t("Use as the default model")}
          </Label>
          <span className="cq-hint">
            <KeyRound size={13} /> {t("Saving sends a one-token request to check the key and the model.")}
          </span>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            {t("Cancel")}
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? t("Testing…") : t("Test and save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

const modelName = (m: Model) => `${m.model}${m.label ? ` (${m.label})` : ""}`;

/** Admins: each team's default model, ahead of the workspace default for its members. */
function TeamDefaults(props: { models: Model[]; defaults: Record<string, string>; onSet: (team: string, model_id: string | null) => Promise<void> }) {
  const [team, setTeam] = useState("");
  const [model, setModel] = useState("");
  // a model restricted to teams can only be those teams' default
  const fits = (m: Model, team: string) => !m.teams?.length || m.teams.includes(team);
  return (
    <section className="cq-section" aria-label={t("Team defaults")}>
      <h2>
        <Users size={16} /> {t("Team defaults")}
      </h2>
      <p className="cq-hint">{t("A team's members run its default model; others run the workspace default. A member of several teams gets the first one's.")}</p>
      <Card className="cq-table-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Team")}</TableHead>
              <TableHead>{t("Default model")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {Object.entries(props.defaults).map(([name, id]) => {
              const m = props.models.find((x) => x.id === id);
              return (
                <TableRow key={name} data-team={name}>
                  <TableCell>{name}</TableCell>
                  <TableCell>
                    <span className="cq-mono">{m ? modelName(m) : id}</span>
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" aria-label={t("Clear {team}'s default", { team: name })} onClick={() => void props.onSet(name, null)}>
                      <Trash2 /> {t("Clear")}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            <TableRow>
              <TableCell>
                <Input aria-label={t("Team")} value={team} placeholder={t("sales")} onChange={(e) => setTeam(e.target.value)} />
              </TableCell>
              <TableCell>
                <select className="cq-select" aria-label={t("Team default model")} value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="" disabled>
                    {t("Choose a model")}
                  </option>
                  {props.models
                    .filter((m) => !team.trim() || fits(m, team.trim()))
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {modelName(m)}
                      </option>
                    ))}
                </select>
              </TableCell>
              <TableCell>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!team.trim() || !model}
                  onClick={() => {
                    void props.onSet(team.trim(), model).then(() => (setTeam(""), setModel("")));
                  }}
                >
                  <Star /> {t("Set default")}
                </Button>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>
    </section>
  );
}

interface UsageRow {
  runs: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
}
interface Usage {
  total: UsageRow;
  by_user: (UsageRow & { user_id: string })[];
  by_team: (UsageRow & { team: string })[];
  by_model: (UsageRow & { model_id: string })[];
}
const PERIODS = { "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days" } as const;

/** Admins: the agent's runs and tokens per user, team or model over a period (usage metering). */
function UsageTable() {
  const [days, setDays] = useState<keyof typeof PERIODS>("30");
  const [by, setBy] = useState<"user" | "team" | "model">("user");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const since = new Date(Date.now() - Number(days) * 86_400_000).toISOString();
    api<Usage>(`/api/admin/usage?since=${encodeURIComponent(since)}`).then(
      (u) => (setUsage(u), setError(null)),
      (e: Error) => setError(e.message),
    );
  }, [days]);
  const rows = usage
    ? by === "user"
      ? usage.by_user.map((r) => ({ key: r.user_id, ...r }))
      : by === "team"
        ? usage.by_team.map((r) => ({ key: r.team, ...r }))
        : usage.by_model.map((r) => ({ key: r.model_id, ...r }))
    : [];
  return (
    <section className="cq-section" aria-label={t("Usage")}>
      <h2>{t("Usage")}</h2>
      <p className="cq-hint">{t("The web agent's runs and the tokens the providers counted. Kept as long as the retention policy keeps uploads.")}</p>
      <div className="cq-row">
        <Tabs value={by} onValueChange={(v) => setBy(v as typeof by)}>
          <TabsList variant="line">
            <TabsTrigger value="user">{t("By user")}</TabsTrigger>
            <TabsTrigger value="team">{t("By team")}</TabsTrigger>
            <TabsTrigger value="model">{t("By model")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <select className="cq-select" aria-label={t("Period")} value={days} onChange={(e) => setDays(e.target.value as keyof typeof PERIODS)}>
          {Object.entries(PERIODS).map(([d, label]) => (
            <option key={d} value={d}>
              {t(label)}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Card className="cq-table-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{by === "user" ? t("User") : by === "team" ? t("Team") : t("Model")}</TableHead>
              <TableHead>{t("Runs")}</TableHead>
              <TableHead>{t("Input tokens")}</TableHead>
              <TableHead>{t("Output tokens")}</TableHead>
              <TableHead>{t("Time")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell className="cq-mono">{r.key}</TableCell>
                <TableCell>{num(r.runs)}</TableCell>
                <TableCell>{num(r.input_tokens)}</TableCell>
                <TableCell>{num(r.output_tokens)}</TableCell>
                <TableCell>{num(Math.round(r.duration_ms / 1000))} s</TableCell>
              </TableRow>
            ))}
            {usage && (
              <TableRow>
                <TableCell>
                  <strong>{t("Total")}</strong>
                </TableCell>
                <TableCell>{num(usage.total.runs)}</TableCell>
                <TableCell>{num(usage.total.input_tokens)}</TableCell>
                <TableCell>{num(usage.total.output_tokens)}</TableCell>
                <TableCell>{num(Math.round(usage.total.duration_ms / 1000))} s</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </section>
  );
}
