import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message } from "@calque/llm";
import { MAX_CHAT, trim } from "../src/chats.ts";
import { createHttp } from "../src/http.ts";
import type { User } from "../src/packs.ts";
import { TOOLS, type App } from "../src/tools.ts";
import { fakeModel, fakeOidc, toolsCalled, type Reply } from "./fakes.ts";
import { acmeDeck, ENGINE_TIMEOUT, testApp } from "./helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const alice: User = { id: "alice", teams: ["sales"] };

/** The web agent's data on the server: conversations per deck (S3), models per team (S9), usage (S16). */
describe("agent conversations, team models and usage", { timeout: ENGINE_TIMEOUT }, () => {
  let app: App;
  let http: ReturnType<typeof createHttp>;
  let idp: Awaited<ReturnType<typeof fakeOidc>>;
  let fake: Awaited<ReturnType<typeof fakeModel>>;
  let script: (b: Json) => Reply = () => ({ content: "Noted." });
  let deck = "";
  const tokens: Record<string, string> = {};

  const req = async (who: string, path: string, body?: Json) => {
    const res = await http.request(path, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Json };
  };
  const chat = (who: string, body: Json) => req(who, "/api/agent/chat", { pack_id: "acme-test", ...body });
  const sent = () => JSON.stringify(fake.requests.at(-1)?.messages);

  beforeAll(async () => {
    fake = await fakeModel((b) => script(b));
    vi.stubEnv("CALQUE_LLM_BASE_URL", fake.url);
    vi.stubEnv("CALQUE_LLM_API_KEY", "good-key");
    vi.stubEnv("CALQUE_LLM_MODEL", "gateway-model");
    vi.stubEnv("CALQUE_RATE_LIMIT", "off");
    idp = await fakeOidc();
    app = await testApp();
    http = createHttp(app, { issuer: idp.issuer, audience: "calque", resource: new URL("/mcp", app.publicUrl), teamsClaim: "groups" });
    for (const [who, groups] of Object.entries({ alice: ["/sales"], bob: ["/ops"], carol: ["/sales"], root: ["/calque-admins"] })) tokens[who] = await idp.token(who, groups);
    deck = (await TOOLS.create_deck.run(app, alice, { deck: acmeDeck() })).deck_id as string;
    await TOOLS.share_deck.run(app, alice, { deck_id: deck, principal_type: "user", principal: "bob", role: "viewer" });
    await TOOLS.share_deck.run(app, alice, { deck_id: deck, principal_type: "user", principal: "carol", role: "editor" });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    fake.server.close();
    idp.server.close();
    await app.db.close();
  });

  it("keeps a deck's conversation on the server: everyone with access reads it, editors continue it", async () => {
    expect((await chat("alice", { deck_id: deck, message: "Make the title shorter" })).json.text).toBe("Noted.");
    const read = (await req("bob", "/api/tools/get_chat", { deck_id: deck })).json;
    expect(read.messages.map((m: Json) => m.role)).toEqual(["user", "assistant"]);
    expect(read.messages[0].content).toBe("Make the title shorter");
    expect(read.can_write).toBe(false);
    expect((await chat("bob", { deck_id: deck, message: "Me too" })).status).toBe(403); // a viewer reads only

    // a colleague continues it on another PC: the model gets the whole conversation
    await chat("carol", { deck_id: deck, message: "And bolder" });
    expect(sent()).toContain("Make the title shorter");
    expect((await req("alice", "/api/tools/get_chat", { deck_id: deck })).json.messages).toHaveLength(4);
    expect((await req("root", "/api/tools/get_chat", { deck_id: deck })).status).toBe(404); // not shared with the admin

    expect((await req("bob", "/api/tools/clear_chat", { deck_id: deck })).status).toBe(403);
    expect((await req("carol", "/api/tools/clear_chat", { deck_id: deck })).json).toEqual({ deck_id: deck, cleared: true });
    expect((await req("alice", "/api/tools/get_chat", { deck_id: deck })).json.messages).toEqual([]);
    expect((await chat("alice", { deck_id: deck, message: "x", messages: [{ role: "user", content: "x" }] })).status).toBe(422);
  });

  it("keeps a new-deck draft per user, and moves it to the deck the agent creates", async () => {
    await chat("bob", { message: "Something for ops" });
    // a deck the agent only looks at keeps the draft a draft
    script = (b) => (toolsCalled(b) === 0 ? { tool: { name: "open_deck", args: { deck_id: deck, render: false } } } : { content: "Seen." });
    await chat("alice", { message: "A quarterly review" });
    expect(sent()).not.toContain("Something for ops"); // drafts are private
    expect((await req("alice", "/api/tools/get_chat", {})).json.messages.length).toBeGreaterThan(0);
    script = (b) => (toolsCalled(b) === 0 ? { tool: { name: "create_deck", args: { deck: acmeDeck() } } } : { content: "Created." });
    const r = await chat("alice", { message: "Go" });
    script = () => ({ content: "Noted." });
    expect(r.json.deck_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await req("alice", "/api/tools/get_chat", {})).json.messages).toEqual([]);
    const moved = (await req("alice", "/api/tools/get_chat", { deck_id: r.json.deck_id })).json.messages as Json[];
    expect(moved.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["A quarterly review", "Go"]);
    expect((await req("bob", "/api/tools/get_chat", {})).json.messages[0].content).toBe("Something for ops");
  });

  it("caps a conversation by dropping its oldest turns", () => {
    const turn = (n: number): Message[] => [
      { role: "user", content: `ask ${n}` },
      { role: "assistant", content: "x".repeat(MAX_CHAT / 4) },
    ];
    const long = [1, 2, 3, 4, 5].flatMap(turn);
    const kept = trim(long);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(MAX_CHAT);
    expect(kept[0]).toEqual({ role: "user", content: "ask 3" });
    expect(kept.at(-2)).toEqual({ role: "user", content: "ask 5" });
  });

  it("restricts a model to teams, with a default per team ahead of the workspace's", async () => {
    const eu = await req("root", "/api/models", { provider: "openai-compatible", model: "eu-model", base_url: fake.url, api_key: "good-key", teams: ["sales"] });
    expect(eu.json).toMatchObject({ id: "openai-compatible:eu-model", teams: ["sales"], is_default: false });
    const ids = async (who: string) => ((await req(who, "/api/models")).json.models as Json[]).map((m) => m.id);
    expect(await ids("bob")).toEqual(["env"]);
    expect(await ids("alice")).toEqual(["env", "openai-compatible:eu-model"]);
    expect((await req("bob", "/api/models")).json.team_defaults).toBeUndefined();

    expect((await req("alice", "/api/models/team-defaults", { team: "sales", model_id: eu.json.id })).status).toBe(403);
    expect((await req("root", "/api/models/team-defaults", { team: "ops", model_id: eu.json.id })).status).toBe(422); // not ops'
    expect((await req("root", "/api/models/team-defaults", { team: "sales", model_id: eu.json.id })).status).toBe(200);
    expect((await req("root", "/api/models")).json.team_defaults).toEqual({ sales: eu.json.id });
    const mine = ((await req("alice", "/api/models")).json.models as Json[]).find((m) => m.your_default);
    expect(mine?.id).toBe(eu.json.id);

    expect((await chat("alice", { deck_id: deck, message: "hi" })).json.model).toBe(eu.json.id);
    expect(fake.requests.at(-1)?.model).toBe("eu-model");
    expect((await chat("bob", { message: "hi" })).json.model).toBe("env");
    expect((await chat("bob", { message: "hi", model: eu.json.id })).status).toBe(403);

    // restricted to ops instead: sales' default on it goes, sales falls back to the workspace default
    expect((await req("root", `/api/models/${encodeURIComponent(eu.json.id)}/teams`, { teams: ["ops"] })).json.teams).toEqual(["ops"]);
    expect((await req("root", "/api/models")).json.team_defaults).toEqual({});
    expect((await chat("alice", { deck_id: deck, message: "hi" })).json.model).toBe("env");
    expect(await ids("bob")).toEqual(["env", eu.json.id]);
  });

  it("meters every agent run per user, team and model, for admins", async () => {
    expect((await req("alice", "/api/admin/usage")).status).toBe(403);
    const u = (await req("root", "/api/admin/usage")).json;
    const runs = (rows: Json[], key: string, value: string) => rows.find((r) => r[key] === value);
    // alice: a deck turn, 2 draft turns, 2 more deck turns; carol one
    expect(runs(u.by_user, "user_id", "alice")).toMatchObject({ runs: 5 });
    expect(runs(u.by_user, "user_id", "alice")?.input_tokens).toBeGreaterThan(0);
    expect(runs(u.by_team, "team", "sales")?.runs).toBe(6); // alice and carol
    expect(runs(u.by_model, "model_id", "openai-compatible:eu-model")).toMatchObject({ runs: 1, input_tokens: 1, output_tokens: 1 });
    expect(u.total.runs).toBe(u.by_user.reduce((n: number, r: Json) => n + r.runs, 0));
    const row = (await app.db.query<Json>("select * from usage where user_id = 'carol'")).rows[0];
    expect(row).toMatchObject({ teams: ["sales"], model_id: "env", run: "chat", deck_id: deck });
    expect(row?.duration_ms).toBeGreaterThanOrEqual(0);

    const later = (await req("root", "/api/tools/usage_report", { since: new Date(Date.now() + 60_000).toISOString() })).json;
    expect(later.total).toEqual({ runs: 0, input_tokens: 0, output_tokens: 0, duration_ms: 0 });
    expect(later.by_user).toEqual([]);
  });
});
