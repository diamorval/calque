import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  PageHeader,
  PageHeaderDescription,
  PageHeaderHeading,
  PageHeaderTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
} from "@diametral/design-system/react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Me } from "../api.ts";

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
  const [tab, setTab] = useState<string>("configured");
  const [editing, setEditing] = useState<Provider | null>(null);
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
    <>
      <PageHeader>
        <PageHeaderHeading>
          <PageHeaderTitle>AI models</PageHeaderTitle>
          <PageHeaderDescription>The models the web app's agent runs on. Keys are tested when saved and never shown again.</PageHeaderDescription>
        </PageHeaderHeading>
      </PageHeader>
      {!me.admin && (
        <Alert tone="info">
          <AlertDescription>Only workspace admins change the models.</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert tone="danger" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: "configured", label: "Configured" },
          { id: "providers", label: "Providers" },
        ]}
      />
      {tab === "configured" && (
        <>
          {data?.models.length === 0 ? (
            <p>No model yet: configure one from the Providers tab.</p>
          ) : (
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
                    <TableCell>{m.model}</TableCell>
                    <TableCell>{m.base_url ?? "—"}</TableCell>
                    <TableCell>
                      {m.is_default ? (
                        <Badge variant="solid">Default</Badge>
                      ) : (
                        me.admin && (
                          <Button size="sm" onClick={() => act(() => api(`/api/models/${encodeURIComponent(m.id)}/default`, {}))}>
                            Set as default
                          </Button>
                        )
                      )}
                    </TableCell>
                    <TableCell>
                      {me.admin && (
                        <Button size="sm" variant="ghost" onClick={() => act(() => api(`/api/models/${encodeURIComponent(m.id)}`, undefined, "DELETE"))}>
                          Remove
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
      {tab === "providers" && (
          <div className="cq-cards">
            {data?.providers.map((p) => (
              <Card key={p.id} size="sm">
                <CardHeader>
                  <CardTitle>{p.label}</CardTitle>
                  <CardDescription>{p.key ? "API key" : "No key needed"}{p.baseURL ? " · your endpoint" : ""}</CardDescription>
                  <CardAction>
                    <Button size="sm" disabled={!me.admin} aria-label={`Configure ${p.label}`} onClick={() => setEditing(p)}>
                      Configure
                    </Button>
                  </CardAction>
                </CardHeader>
              </Card>
            ))}
          </div>
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
    </>
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
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <form onSubmit={save} className="cq-stack">
          <DialogHeader>
            <DialogTitle>Configure {p.label}</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="m-model">Model</FieldLabel>
            <Input id="m-model" required value={model} placeholder={p.example} onChange={(e) => setModel(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="m-key">API key{p.key ? "" : " (optional)"}</FieldLabel>
            <Input id="m-key" type="password" autoComplete="off" required={p.key} value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          {(p.baseURL || p.defaultBaseURL) && (
            <Field>
              <FieldLabel htmlFor="m-base">Base URL{p.baseURL ? "" : " (optional)"}</FieldLabel>
              <Input id="m-base" type="url" required={p.baseURL} value={base} placeholder={p.defaultBaseURL ?? "https://…/v1"} onChange={(e) => setBase(e.target.value)} />
            </Field>
          )}
          <Field orientation="horizontal">
            <Checkbox id="m-default" checked={isDefault} onCheckedChange={(v) => setDefault(!!v)} />
            <FieldLabel htmlFor="m-default">Use as the default model</FieldLabel>
          </Field>
          <FieldDescription>Saving sends a one-token request to check the key and the model.</FieldDescription>
          {error && (
            <Alert tone="danger" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={saving}>
              Test and save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
