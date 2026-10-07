// The e2e stack: a fake OIDC issuer, a fake OpenAI-compatible model, and the real server (engine,
// PGlite in memory) serving the built web app. Alice is in sales + calque-admins, Bob in ops.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "../../server/src/app.ts";
import { createHttp } from "../../server/src/http.ts";
import { sessions } from "../../server/src/session.ts";
import { fakeModel, fakeOidc, lastResult, toolsCalled } from "../../server/test/fakes.ts";
import { acmeDeck } from "../../server/test/helpers.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const port = Number(process.argv[2] ?? 4319);
const publicUrl = `http://localhost:${port}`;

/** A scripted agent: builds the acme deck on the active pack, applies comments, answers "ping". */
function script(b: Json) {
  const system = String(b.messages[0]?.content ?? "");
  const ask = String(b.messages.findLast((m: Json) => m.role === "user")?.content ?? "");
  const steps = toolsCalled(b);
  if (ask.startsWith("Apply every open comment")) {
    const deck_id = ask.match(/deck (\S+)\./)?.[1];
    if (steps === 0) return { tool: { name: "list_comments", args: { deck_id } } };
    if (steps === 1) {
      const comments = lastResult(b).comments as Json[];
      const ops = comments.filter((c) => c.shape_id).map((c) => ({ op: "set", slide: c.slide_id, shape_id: c.shape_id, value: c.text }));
      return { tool: { name: "patch_deck", args: { deck_id, ops, resolves: comments.map((c) => c.id), note: "apply comments" } } };
    }
    if (steps === 2) return { tool: { name: "lint_deck", args: { deck_id } } };
    return { content: `Applied the comments: ${lastResult(b).errors} lint error.` };
  }
  if (/ping/i.test(ask)) return { content: `pong from ${b.model}` };
  const pack = system.match(/Active pack: `([^`]+)`/)?.[1];
  if (!pack || system.includes("# Open deck")) return { content: "Noted." };
  if (steps === 0) return { tool: { name: "create_deck", args: { deck: { ...acmeDeck(), pack_id: pack } } } };
  if (steps === 1) return { tool: { name: "lint_deck", args: { deck_id: lastResult(b).deck_id } } };
  return { content: `Deck ready on ${pack}: ${lastResult(b).errors} lint error.` };
}

const idp = await fakeOidc();
const model = await fakeModel(script, port + 1); // e2e/models.spec.ts configures it by this URL
process.env.CALQUE_LLM_BASE_URL = model.url;
process.env.CALQUE_LLM_API_KEY = "good-key";
process.env.CALQUE_LLM_MODEL = "gateway-e2e";
const app = await createApp({ data: mkdtempSync(join(tmpdir(), "calque-e2e-")), db: "memory://", publicUrl });
const auth = { issuer: idp.issuer, audience: "calque", resource: new URL("/mcp", publicUrl), teamsClaim: "groups" };
const web = sessions({ issuer: idp.issuer, clientId: "calque-web", publicUrl, teamsClaim: "groups", secret: app.secret });
serve({ fetch: createHttp(app, auth, web).fetch, port, hostname: "localhost" }, () => {
  console.log(`e2e stack on ${publicUrl} (model ${model.url})`);
});
