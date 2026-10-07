// Phase 4 verifies on real models: the same brief built by each model to 0 lint ERROR, then 5 typical
// comments applied to 0 lint ERROR. Needs real keys, so it is not in CI.
//   ANTHROPIC_API_KEY=… OPENAI_API_KEY=… node apps/server/eval/agent.ts anthropic:claude-sonnet-5-5 openai:gpt-5
//   (the CALQUE_LLM_* gateway counts as `env`; keys: ANTHROPIC/OPENAI/MISTRAL_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyComments, chat, type Message } from "@calque/agent";
import type { ModelConfig, ProviderId } from "@calque/llm";
import { createApp } from "../src/app.ts";
import { connect } from "../src/http.ts";
import { TOOLS } from "../src/tools.ts";

const KEYS: Partial<Record<ProviderId, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  gemini: "GOOGLE_GENERATIVE_AI_API_KEY",
};
const PACK = process.env.EVAL_PACK ?? "diametral";
const BRIEF =
  process.env.EVAL_BRIEF ??
  `Build a 6-slide deck in French for our steering committee: our support desk cut ticket backlog from 1,200 to 300
in 6 months (Jan 1,200; Feb 1,050; Mar 800; Apr 600; May 420; Jun 300) by triaging in three steps (sort, route,
resolve) and moving 40% of tickets to self-service. Ask for a decision: extend the model to the IT team in Q1.`;
const USER = { id: "eval", teams: [], local: true };

const app = await createApp({ data: mkdtempSync(join(tmpdir(), "calque-eval-")), db: "memory://" });
const rows: string[] = [];
for (const arg of process.argv.slice(2)) {
  const model: ModelConfig =
    arg === "env"
      ? await app.models.resolve("env")
      : (() => {
          const [provider, ...name] = arg.split(":") as [ProviderId, ...string[]];
          const key = KEYS[provider];
          return { provider, model: name.join(":"), apiKey: key ? process.env[key] : undefined };
        })();
  const client = await connect(app, USER);
  const t0 = Date.now();
  try {
    // the agent may ask questions or show its plan first: answer "go" a few times
    let messages: Message[] = [{ role: "user", content: BRIEF }];
    let deck: string | undefined;
    for (let turn = 0; turn < 4 && !deck; turn++) {
      const r = await chat({ client, model, pack_id: PACK, messages, onStep: (s) => s.toolCalls.forEach((c) => console.error(`  ${arg} → ${c.toolName}`)) });
      messages = [...messages, ...r.messages, { role: "user", content: "Go with your recommendations; build it now." }];
      deck = (await app.db.query<{ id: string }>("select id from decks where owner = $1 order by created_at desc limit 1", [USER.id])).rows[0]?.id;
      if (!deck) console.error(`  ${arg} asks: ${r.text.slice(0, 300)}`);
    }
    if (!deck) throw new Error("no deck after 4 turns");
    const built = await TOOLS.lint_deck.run(app, USER, { deck_id: deck });

    const spec = (await TOOLS.open_deck.run(app, USER, { deck_id: deck, render: false })).spec as { slides: { id: string; source: { kind: string } }[] };
    const ids = spec.slides.map((s) => s.id);
    const drawn = spec.slides.find((s, i) => i > 0 && s.source.kind !== "clone")?.id;
    const comments: [string | undefined, string][] = [
      [ids[0], "Put the title in the accent colour"],
      [ids[1], "Reword this title: shorter, a verdict"],
      [ids.at(-2), "Move this slide right after the cover"],
      [drawn, "June is 280, not 300: update the figure"],
      [ids.at(-3), "Delete this slide"],
    ];
    for (const [slide_id, text] of comments) if (slide_id) await TOOLS.add_comment.run(app, USER, { deck_id: deck, slide_id, text });
    const applied = await applyComments({ client, model, deck_id: deck });
    const after = await TOOLS.lint_deck.run(app, USER, { deck_id: deck });
    const open = (await TOOLS.list_comments.run(app, USER, { deck_id: deck, status: "open" })).comments as unknown[];
    rows.push(`${arg}\tbuild: ${built.errors} ERROR\tcomments: ${comments.length - open.length}/${comments.length} applied, ${after.errors} ERROR\t${Math.round((Date.now() - t0) / 1000)} s\t${app.publicUrl}/decks/${deck}`);
    console.error(applied.text);
  } catch (e) {
    rows.push(`${arg}\tFAILED: ${(e as Error).message}`);
  } finally {
    await client.close();
  }
}
console.log(rows.join("\n"));
await app.db.close();
