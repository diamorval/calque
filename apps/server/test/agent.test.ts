import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHttp } from "../src/http.ts";
import { Forbidden } from "../src/models.ts";
import { TOOLS, type App } from "../src/tools.ts";
import { fakeModel, lastResult, toolsCalled, type Reply } from "./fakes.ts";
import { acmeDeck, ENGINE_TIMEOUT, LOCAL, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const NO_EXTRAS = { label: null, headers: [], resource: null, api_version: null, managed_identity: false };
describe("web agent", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let http: ReturnType<typeof createHttp>;
  let script: (body: Json) => Reply = () => ({ content: "hi" });
  let fake: Awaited<ReturnType<typeof fakeModel>>;

  const api = async (path: string, body?: Json, method = body ? "POST" : "GET") => {
    const res = await http.request(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as Json };
  };

  beforeAll(async () => {
    fake = await fakeModel((b) => script(b));
    vi.stubEnv("CALQUE_LLM_BASE_URL", fake.url);
    vi.stubEnv("CALQUE_LLM_API_KEY", "good-key");
    vi.stubEnv("CALQUE_LLM_MODEL", "gateway-model");
    app = await testApp();
    http = createHttp(app);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    fake.server.close();
    await app.db.close();
  });

  it("configures models: the env gateway is the default, a bad key is refused, a new default applies at once", async () => {
    const listed = (await api("/api/models")).json;
    expect(listed.providers.map((p: Json) => p.id)).toEqual(["anthropic", "openai", "azure", "mistral", "gemini", "ollama", "openai-compatible"]);
    expect(listed.models).toEqual([{ id: "env", ...NO_EXTRAS, provider: "openai-compatible", model: "gateway-model", base_url: fake.url, has_key: true, is_default: true }]);

    const bad = await api("/api/models", { provider: "openai-compatible", model: "other", base_url: fake.url, api_key: "bad-key" });
    expect(bad.status).toBe(422);
    expect(bad.json.message).toContain("Incorrect API key");
    expect((await api("/api/models")).json.models).toHaveLength(1);
    expect((await api("/api/models", { provider: "anthropic", model: "x" })).status).toBe(422); // no key

    const good = await api("/api/models", { provider: "openai-compatible", model: "other", base_url: fake.url, api_key: "good-key" });
    expect(good.json).toEqual({ id: "openai-compatible:other", ...NO_EXTRAS, provider: "openai-compatible", model: "other", base_url: fake.url, has_key: true, is_default: false });
    const stored = (await app.db.query<Json>("select api_key from models where id = $1", ["openai-compatible:other"])).rows[0];
    expect(stored?.api_key).not.toContain("good-key"); // sealed at rest

    script = () => ({ content: "Which pack?" });
    expect((await api("/api/agent/chat", { messages: [{ role: "user", content: "hi" }] })).json).toMatchObject({ model: "env", text: "Which pack?" });
    expect(fake.requests.at(-1)?.model).toBe("gateway-model");

    expect((await api("/api/models/openai-compatible:other/default", {})).status).toBe(200);
    expect((await api("/api/agent/chat", { messages: [{ role: "user", content: "hi" }] })).json.model).toBe("openai-compatible:other");
    expect(fake.requests.at(-1)?.model).toBe("other");

    await expect(app.models.setDefault({ id: "bob", teams: ["sales"] }, "env")).rejects.toThrow(Forbidden);
  });

  it("keeps two configurations of one model apart, edits one in place, and the chat picks one", async () => {
    const other = await fakeModel(() => ({ content: "from the second host" }));
    try {
      const again = await api("/api/models", { provider: "openai-compatible", model: "other", base_url: fake.url, api_key: "good-key" });
      expect(again.json.id).toBe("openai-compatible:other"); // same endpoint: an edit
      const second = await api("/api/models", { provider: "openai-compatible", model: "other", base_url: other.url, api_key: "good-key" });
      expect(second.json.id).toBe("openai-compatible:other@2"); // another endpoint: no overwrite
      const eu = await api("/api/models", {
        provider: "openai-compatible",
        model: "other",
        label: "EU région",
        base_url: other.url,
        api_key: "good-key",
        headers: { "Ocp-Apim-Subscription-Key": "apim-secret" },
      });
      expect(eu.json).toMatchObject({ id: "openai-compatible:other@eu-region", label: "EU région", headers: ["Ocp-Apim-Subscription-Key"] });
      const stored = (await app.db.query<Json>("select headers from models where id = $1", [eu.json.id])).rows[0];
      expect(stored?.headers).not.toContain("apim-secret"); // sealed at rest
      expect(JSON.stringify((await api("/api/models")).json)).not.toContain("apim-secret");

      // edit: a new endpoint and label, the stored key and headers kept
      const edited = await api("/api/models", { id: eu.json.id, provider: "openai-compatible", model: "other", label: "EU", base_url: fake.url });
      expect(edited.json).toMatchObject({ id: "openai-compatible:other@eu-region", label: "EU", base_url: fake.url, has_key: true, headers: ["Ocp-Apim-Subscription-Key"] });
      expect((await api("/api/models", { id: "nope", provider: "openai-compatible", model: "x", base_url: fake.url })).status).toBe(404);
      expect((await api("/api/models", { id: eu.json.id, provider: "anthropic", model: "x", api_key: "k" })).status).toBe(422);

      script = () => ({ content: "from the first host" });
      const picked = await api("/api/agent/chat", { model: "openai-compatible:other@2", messages: [{ role: "user", content: "hi" }] });
      expect(picked.json).toMatchObject({ model: "openai-compatible:other@2", text: "from the second host" });
      expect((await api("/api/models")).json.models.find((m: Json) => m.is_default).id).toBe("openai-compatible:other"); // the default is unchanged
    } finally {
      other.server.close();
      for (const id of ["openai-compatible:other@2", "openai-compatible:other@eu-region"]) await api(`/api/models/${encodeURIComponent(id)}`, undefined, "DELETE");
    }
  });

  it("removing the default model promotes the most recently configured one", async () => {
    const add = (model: string) => api("/api/models", { provider: "openai-compatible", model, base_url: fake.url, api_key: "good-key" });
    await add("older");
    await add("newer");
    expect((await api("/api/models/openai-compatible:older/default", {})).status).toBe(200);
    expect((await api("/api/models/openai-compatible:older", undefined, "DELETE")).status).toBe(200);
    const models = (await api("/api/models")).json.models as Json[];
    expect(models.filter((m) => m.is_default).map((m) => m.id)).toEqual(["openai-compatible:newer"]);
    expect((await api("/api/agent/chat", { messages: [{ role: "user", content: "hi" }] })).json.model).toBe("openai-compatible:newer");

    await api("/api/models/openai-compatible:other", undefined, "DELETE"); // not the default: the default stays
    expect((await app.models.resolve()).id).toBe("openai-compatible:newer");
  });

  it("builds a deck from a brief through the MCP tools, to 0 lint error", async () => {
    script = (b) => {
      const steps = toolsCalled(b);
      if (steps === 0) return { tool: { name: "read_resource", args: { uri: "pack://acme-test/template-map" } } };
      if (steps === 1) return { tool: { name: "create_deck", args: { deck: acmeDeck() } } };
      if (steps === 2) return { tool: { name: "lint_deck", args: { deck_id: lastResult(b).deck_id } } };
      return { content: `Done: ${lastResult(b).errors} error.` };
    };
    const r = await api("/api/agent/chat", {
      pack_id: "acme-test",
      messages: [{ role: "user", content: "Build the quarterly review: north led growth, deals close in 4 steps." }],
    });
    expect(r.json.text).toBe("Done: 0 error.");
    const first = fake.requests.at(-4) as Json;
    const system = first.messages[0].content as string;
    expect(system).toContain("# Workflow: build"); // the MCP prompt
    expect(system).toContain('<resource uri="core://doctrine">');
    expect(system).toContain('<resource uri="pack://acme-test/DESIGN.md">');
    const tools = first.tools.map((t: Json) => t.function.name);
    expect(tools).toContain("create_deck");
    expect(tools).toContain("read_resource");
    expect(tools).not.toContain("add_comment"); // UI-only
    expect(JSON.stringify(fake.requests.at(-3))).toContain("slots"); // the template map came back
    expect(r.json.messages.filter((m: Json) => m.role === "tool")).toHaveLength(3);
  });

  it("streams a failed tool call with its error, and the model gets the error back", async () => {
    script = (b) => (toolsCalled(b) === 0 ? { tool: { name: "create_deck", args: { deck: { title: "x" } } } } : { content: "The deck was invalid." });
    const res = await http.request("/api/agent/chat", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ pack_id: "acme-test", messages: [{ role: "user", content: "build" }] }),
    });
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    const step = lines[0].step.tools[0];
    expect(step.name).toBe("create_deck");
    expect(step.error).toMatch(/\S/);
    const toolMessage = (fake.requests.at(-1) as Json).messages.findLast((m: Json) => m.role === "tool").content;
    expect(toolMessage).toContain(JSON.parse(step.error).message); // the model sees the full error to correct itself
    const done = lines.at(-1).done;
    expect(done.text).toBe("The deck was invalid.");
    const result = done.messages.find((m: Json) => m.role === "tool").content[0];
    expect(result.output.type).toBe("error-text"); // the conversation keeps the failure for the chat's history
  });

  it("applies 5 typical comments (colour, rewording, move, chart, deletion) to 0 lint error", async () => {
    const { deck_id } = await TOOLS.create_deck.run(app, LOCAL, { deck: acmeDeck() });
    const comment = (slide_id: string, text: string, shape_id?: number) =>
      TOOLS.add_comment.run(app, LOCAL, { deck_id, slide_id, text, ...(shape_id ? { shape_id } : {}) });
    await comment("cover", "Title in the accent colour", 2);
    await comment("d1", "Say what moved instead", 3);
    await comment("plan", "Move this before the process slide");
    await comment("regions", "North is 20%, not 18%");
    await comment("mix", "Drop this slide");

    script = (b) => {
      const steps = toolsCalled(b);
      if (steps === 0) return { tool: { name: "list_comments", args: { deck_id } } };
      if (steps === 1) {
        const ids = lastResult(b).comments.map((c: Json) => c.id);
        const ops = [
          { op: "set", slide: "cover", shape_id: 2, value: { color: "accent" } },
          { op: "set", slide: "d1", shape_id: 3, value: "North drove the growth" },
          { op: "move_slide", slide: "plan", to: 3 },
          { op: "set_params", slide: "regions", params: { series: [{ name: "Growth", values: [20, 7, 5, 3] }] } },
          { op: "delete_slide", slide: "mix" },
        ];
        return { tool: { name: "patch_deck", args: { deck_id, ops, resolves: ids, note: "apply comments" } } };
      }
      if (steps === 2) return { tool: { name: "lint_deck", args: { deck_id } } };
      return { content: `Applied 5 comments, ${lastResult(b).errors} error.` };
    };
    const r = await api("/api/agent/apply-comments", { deck_id });
    expect(r.json.text).toBe("Applied 5 comments, 0 error.");
    expect(fake.requests.at(-1)?.messages[0].content).toContain("# Workflow: edit");

    expect((await TOOLS.list_comments.run(app, LOCAL, { deck_id, status: "open" })).comments).toEqual([]);
    const spec = (await TOOLS.open_deck.run(app, LOCAL, { deck_id, render: false })).spec as Json;
    expect(spec.slides.map((s: Json) => s.id)).toEqual(["cover", "d1", "regions", "plan", "process", "end"]);
    expect(spec.slides[2].source.params.series[0].values[0]).toBe(20);
    expect((await TOOLS.lint_deck.run(app, LOCAL, { deck_id })).errors).toBe(0);
  });

  it("gives the model the attached files: a document's text, an image's file reference", async () => {
    const send = async (name: string, content: string, type: string) => {
      const form = new FormData();
      form.append("file", new File([content], name, { type }));
      return (await (await http.request("/api/files", { method: "POST", body: form })).json()) as Json;
    };
    const brief = await send("brief.md", "# Brief\nNorth led growth: +18% in Q3.", "text/markdown");
    const logo = await send("logo.png", "not really a png", "image/png");
    script = () => ({ content: "Read it." });
    const r = await api("/api/agent/chat", { pack_id: "acme-test", files: [brief.file_id, logo.file_id], messages: [{ role: "user", content: "Build from the brief" }] });
    expect(r.json.text).toBe("Read it.");
    const system = fake.requests.at(-1)?.messages[0].content as string;
    expect(system).toContain("# Attached files");
    expect(system).toContain("North led growth: +18% in Q3.");
    expect(system).toContain(`"image": "file:${logo.file_id}"`);

    expect((await api("/api/agent/chat", { files: ["0b9b3c4e-0000-4000-8000-000000000000"], messages: [{ role: "user", content: "hi" }] })).status).toBe(404);
  });
});
