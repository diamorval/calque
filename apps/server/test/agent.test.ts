import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHttp } from "../src/http.ts";
import { Forbidden } from "../src/models.ts";
import { TOOLS, type App } from "../src/tools.ts";
import { acmeDeck, ENGINE_TIMEOUT, LOCAL, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = { content?: string; tool?: { name: string; args: Json } };

/** A fake OpenAI-compatible endpoint: checks the key, records each request, answers from `script`. */
function fakeModel(script: (body: Json) => Reply) {
  const requests: Json[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== "Bearer good-key") {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }));
      }
      const body = JSON.parse(raw);
      requests.push(body);
      const r = body.tools ? script(body) : { content: "OK" };
      const call = r.tool && { id: `call_${++n}`, type: "function", function: { name: r.tool.name, arguments: JSON.stringify(r.tool.args) } };
      res.end(
        JSON.stringify({
          id: `chatcmpl-${n}`,
          object: "chat.completion",
          created: 0,
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: r.content ?? null, ...(call ? { tool_calls: [call] } : {}) }, finish_reason: call ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  return { server, requests, url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

/** The last tool result the model received, parsed. */
const lastResult = (body: Json): Json => JSON.parse(body.messages.findLast((m: Json) => m.role === "tool").content);
const toolsCalled = (body: Json) => body.messages.filter((m: Json) => m.role === "tool").length;

describe("web agent", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let http: ReturnType<typeof createHttp>;
  let script: (body: Json) => Reply = () => ({ content: "hi" });
  const fake = fakeModel((b) => script(b));

  const api = async (path: string, body?: Json, method = body ? "POST" : "GET") => {
    const res = await http.request(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as Json };
  };

  beforeAll(async () => {
    await new Promise<void>((ok) => fake.server.listen(0, "127.0.0.1", ok));
    vi.stubEnv("CALQUE_LLM_BASE_URL", fake.url());
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
    expect(listed.providers.map((p: Json) => p.id)).toEqual(["anthropic", "openai", "mistral", "gemini", "ollama", "openai-compatible"]);
    expect(listed.models).toEqual([{ id: "env", provider: "openai-compatible", model: "gateway-model", base_url: fake.url(), has_key: true, is_default: true }]);

    const bad = await api("/api/models", { provider: "openai-compatible", model: "other", base_url: fake.url(), api_key: "bad-key" });
    expect(bad.status).toBe(422);
    expect(bad.json.message).toContain("Incorrect API key");
    expect((await api("/api/models")).json.models).toHaveLength(1);
    expect((await api("/api/models", { provider: "anthropic", model: "x" })).status).toBe(422); // no key

    const good = await api("/api/models", { provider: "openai-compatible", model: "other", base_url: fake.url(), api_key: "good-key" });
    expect(good.json).toEqual({ id: "openai-compatible:other", provider: "openai-compatible", model: "other", base_url: fake.url(), has_key: true, is_default: false });
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
});
