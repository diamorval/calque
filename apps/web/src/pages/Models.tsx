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
import { KeyRound, Pencil, Server, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Me } from "../api.ts";
import { t } from "../i18n.ts";
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
}

/** Settings > AI models (PipesHub pattern): provider catalog, Configure, Configured, Set as default. */
export function Models({ me }: { me: Me }) {
  const [data, setData] = useState<{ providers: Provider[]; models: Model[] } | null>(null);
  const [tab, setTab] = useState<"configured" | "providers">("configured");
  const [editing, setEditing] = useState<{ provider: Provider; model?: Model } | null>(null);
  const [removing, setRemoving] = useState<Model | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => api<{ providers: Provider[]; models: Model[] }>("/api/models").then(setData), []);
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
