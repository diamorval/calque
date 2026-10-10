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
import { KeyRound, Server, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Me } from "../api.ts";
import { Dialog, Field, PageHead } from "../ui.tsx";

interface Provider {
  id: string;
  label: string;
  key: boolean;
  baseURL: boolean;
  defaultBaseURL?: string;
  example: string;
}
interface Model {
  id: string;
  provider: string;
  model: string;
  base_url: string | null;
  has_key: boolean;
  is_default: boolean;
}

/** Settings > AI models (PipesHub pattern): provider catalog, Configure, Configured, Set as default. */
export function Models({ me }: { me: Me }) {
  const [data, setData] = useState<{ providers: Provider[]; models: Model[] } | null>(null);
  const [tab, setTab] = useState<"configured" | "providers">("configured");
  const [editing, setEditing] = useState<Provider | null>(null);
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
  const label = (id: string) => data?.providers.find((p) => p.id === id)?.label ?? id;

  return (
    <div className="cq-page">
      <PageHead title="AI models" description="The models the web app's agent runs on. Keys are tested when saved and never shown again." />
      {!me.admin && (
        <Alert tone="info">
          <AlertDescription>Only workspace admins change the models.</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList variant="line">
          <TabsTrigger value="configured">Configured</TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "configured" &&
        (data?.models.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Server />
              </EmptyMedia>
              <EmptyTitle>No model yet</EmptyTitle>
              <EmptyDescription>Configure one from the Providers tab.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card className="cq-table-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>Default</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.models.map((m) => (
                  <TableRow key={m.id} data-model={m.id}>
                    <TableCell>{label(m.provider)}</TableCell>
                    <TableCell>
                      <span className="cq-mono">{m.model}</span>
                    </TableCell>
                    <TableCell className="cq-muted">{m.base_url ?? "—"}</TableCell>
                    <TableCell>
                      {m.is_default ? (
                        <Tag>Default</Tag>
                      ) : (
                        me.admin && (
                          <Button size="sm" variant="outline" onClick={() => act(() => api(`/api/models/${encodeURIComponent(m.id)}/default`, {}))}>
                            <Star /> Set as default
                          </Button>
                        )
                      )}
                    </TableCell>
                    <TableCell>
                      {me.admin && (
                        <Button size="sm" variant="ghost" onClick={() => setRemoving(m)}>
                          <Trash2 /> Remove
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
                    {p.key ? "API key" : "No key needed"}
                    {p.baseURL ? " · your endpoint" : ""}
                  </span>
                </div>
                <Button size="sm" variant="outline" disabled={!me.admin} aria-label={`Configure ${p.label}`} onClick={() => setEditing(p)}>
                  Configure
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {removing && (
        <Dialog title={`Remove ${label(removing.provider)} ${removing.model}?`} onClose={() => setRemoving(null)}>
          <div className="cq-dialog-body">
            <p>
              The agent stops running on it, and its key is deleted.
              {removing.is_default && " It is the default: the most recently configured model takes over."}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const id = removing.id;
                setRemoving(null);
                void act(() => api(`/api/models/${encodeURIComponent(id)}`, undefined, "DELETE"));
              }}
            >
              <Trash2 /> Remove
            </Button>
          </DialogFooter>
        </Dialog>
      )}
      {editing && (
        <Configure
          provider={editing}
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

function Configure(props: { provider: Provider; onClose: () => void; onSaved: () => Promise<void> }) {
  const p = props.provider;
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [base, setBase] = useState("");
  const [isDefault, setDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api("/api/models", {
        provider: p.id,
        model,
        ...(key ? { api_key: key } : {}),
        ...(base ? { base_url: base } : {}),
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
    <Dialog title={`Configure ${p.label}`} onClose={props.onClose}>
      <form onSubmit={save}>
        <div className="cq-dialog-body">
          <Field label="Model" htmlFor="m-model">
            <Input id="m-model" required value={model} placeholder={p.example} onChange={(e) => setModel(e.target.value)} />
          </Field>
          <Field label={`API key${p.key ? "" : " (optional)"}`} htmlFor="m-key">
            <Input id="m-key" type="password" autoComplete="off" required={p.key} value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          {(p.baseURL || p.defaultBaseURL) && (
            <Field label={`Base URL${p.baseURL ? "" : " (optional)"}`} htmlFor="m-base">
              <Input id="m-base" type="url" required={p.baseURL} value={base} placeholder={p.defaultBaseURL ?? "https://…/v1"} onChange={(e) => setBase(e.target.value)} />
            </Field>
          )}
          <Label className="cq-check">
            <Checkbox checked={isDefault} onCheckedChange={setDefault} />
            Use as the default model
          </Label>
          <span className="cq-hint">
            <KeyRound size={13} /> Saving sends a one-token request to check the key and the model.
          </span>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Testing…" : "Test and save"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
