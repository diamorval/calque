import { KeyRound, Server, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Me } from "../api.ts";
import { Alert, Badge, Button, Dialog, Field, PageHead, Tabs } from "../ui.tsx";

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
      {!me.admin && <Alert tone="info">Only workspace admins change the models.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: "configured", label: "Configured" },
          { id: "providers", label: "Providers" },
        ]}
      />
      {tab === "configured" &&
        (data?.models.length === 0 ? (
          <div className="cq-empty cq-card">
            <Server />
            <strong>No model yet</strong>
            <span>Configure one from the Providers tab.</span>
          </div>
        ) : (
          <div className="cq-card cq-table-wrap">
            <table className="cq-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Endpoint</th>
                  <th>Default</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data?.models.map((m) => (
                  <tr key={m.id} data-model={m.id}>
                    <td>{label(m.provider)}</td>
                    <td>
                      <span className="cq-mono">{m.model}</span>
                    </td>
                    <td className="cq-muted">{m.base_url ?? "—"}</td>
                    <td>
                      {m.is_default ? (
                        <Badge tone="solid">Default</Badge>
                      ) : (
                        me.admin && (
                          <Button size="sm" onClick={() => act(() => api(`/api/models/${encodeURIComponent(m.id)}/default`, {}))}>
                            <Star /> Set as default
                          </Button>
                        )
                      )}
                    </td>
                    <td>
                      {me.admin && (
                        <Button size="sm" variant="ghost" onClick={() => act(() => api(`/api/models/${encodeURIComponent(m.id)}`, undefined, "DELETE"))}>
                          <Trash2 /> Remove
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {tab === "providers" && (
        <ul className="cq-provider-grid">
          {data?.providers.map((p) => (
            <li key={p.id} className="cq-card cq-provider">
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
              <Button size="sm" disabled={!me.admin} aria-label={`Configure ${p.label}`} onClick={() => setEditing(p)}>
                Configure
              </Button>
            </li>
          ))}
        </ul>
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
            <input className="cq-input" id="m-model" required value={model} placeholder={p.example} onChange={(e) => setModel(e.target.value)} />
          </Field>
          <Field label={`API key${p.key ? "" : " (optional)"}`} htmlFor="m-key">
            <input className="cq-input" id="m-key" type="password" autoComplete="off" required={p.key} value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          {(p.baseURL || p.defaultBaseURL) && (
            <Field label={`Base URL${p.baseURL ? "" : " (optional)"}`} htmlFor="m-base">
              <input className="cq-input" id="m-base" type="url" required={p.baseURL} value={base} placeholder={p.defaultBaseURL ?? "https://…/v1"} onChange={(e) => setBase(e.target.value)} />
            </Field>
          )}
          <label className="cq-check">
            <input type="checkbox" checked={isDefault} onChange={(e) => setDefault(e.target.checked)} />
            Use as the default model
          </label>
          <span className="cq-hint">
            <KeyRound size={13} /> Saving sends a one-token request to check the key and the model.
          </span>
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
        <div className="cq-dialog-foot">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? "Testing…" : "Test and save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
