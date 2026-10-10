// The web app's agent: a tool-calling loop over the Calque MCP server, the same door Claude uses.
// It holds no business logic (rule 1) and no provider SDK (rule 2): knowledge comes from the server's
// core:// and pack:// resources and prompts, every action is an MCP tool call.
import type { Client } from "@modelcontextprotocol/client";
import { runTools, type Message, type ModelConfig, type Step, type ToolDef } from "@calque/llm";

export type { Message } from "@calque/llm";

/** The MCP prompts (core/workflows) the agent can run. */
export type Workflow = "build-presentation" | "storyline" | "draft-slides" | "edit-slides" | "review-deck";

export interface ChatInput {
  client: Client;
  model: ModelConfig;
  messages: Message[];
  workflow?: Workflow | undefined;
  pack_id?: string | undefined;
  /** The deck the user has open: the chat edits it rather than building a new one. */
  deck_id?: string | undefined;
  /** Files the user attached, as the server prepared them: an image's `ref`, a document's `text`. */
  files?: Attachment[] | undefined;
  /** after each step: the tools called, a failed one with its `error` */
  onStep?: ((step: Step) => void) | undefined;
}

const ROLE = `You are Calque's slide co-editor, inside its web app. You work with the user on a deck that
must follow their company's brand pack.

- You never write PPTX: you write a DeckSpec (create_deck's input schema is the DeckSpec JSON Schema)
  and change decks only through the tools. The engine draws the slides.
- Follow the workflow below step by step. When you need the user, stop and ask ONE question, with
  your recommended answer; a clear brief needs no question. Beyond about 6 slides, show the deck
  plan and wait for the user's go before create_deck.
- Before delivering, lint_deck must report 0 ERROR: fix every ERROR with patch_deck and lint again.
- Read the pack resources the workflow names with read_resource (pack://<id>/template-map holds the
  role slides and the shape_ids of their slots).
- Answer in the user's language; the deck language is the DeckSpec's.`;

export interface Attachment {
  file_id: string;
  name: string;
  type: string;
  ref?: string;
  text?: string;
  truncated?: boolean;
  error?: string;
}

/** The attached files, for the workflow's Ingest step: documents inline, images by reference. */
function attachments(files: Attachment[]): string {
  if (!files.length) return "";
  const one = (f: Attachment) => {
    if (f.ref) return `<file name="${f.name}" type="${f.type}">Image: place it in a clone value as "image": "${f.ref}".</file>`;
    if (f.error) return `<file name="${f.name}" type="${f.type}">Could not be read: ${f.error}</file>`;
    return `<file name="${f.name}" type="${f.type}"${f.truncated ? ' truncated="true"' : ""}>\n${f.text}\n</file>`;
  };
  return `# Attached files\n\nThe user attached these files: they are the supplied documents and images to ingest first.\n\n${files.map(one).join("\n\n")}`;
}

const text = (r: { contents: unknown[] }) =>
  r.contents.map((c) => (c as { text?: string }).text ?? "").join("\n");

/** The system prompt: role, the workflow (MCP prompt) and the always-needed knowledge, inlined. */
export async function instructions(client: Client, workflow: Workflow, pack_id?: string, deck_id?: string, files: Attachment[] = []): Promise<string> {
  const prompt = await client.getPrompt({ name: workflow, arguments: pack_id ? { pack_id } : {} });
  const steps = prompt.messages.map((m) => (m.content as { text?: string }).text ?? "").join("\n\n");
  const uris = ["core://doctrine", "core://forms", "core://compositions", "core://anti-slop"];
  if (pack_id) uris.push(`pack://${pack_id}/DESIGN.md`, `pack://${pack_id}/voice`, `pack://${pack_id}/manifest`);
  const knowledge = await Promise.all(
    uris.map(async (uri) => `<resource uri="${uri}">\n${text(await client.readResource({ uri }))}\n</resource>`),
  );
  const deck = deck_id
    ? `# Open deck\n\nThe user has deck \`${deck_id}\` open next to this chat: open_deck it before changing it, change it with patch_deck or add_slides (never a new deck), and pass the comment ids a patch answers in \`resolves\`.`
    : "";
  return [ROLE, "# Workflow", steps, deck, attachments(files), "# Knowledge", ...knowledge].filter(Boolean).join("\n\n");
}

/** The server's tools the model may call (not the UI-only ones), plus read_resource. */
async function tools(client: Client): Promise<ToolDef[]> {
  const listed = (await client.listTools()).tools.filter((t) => {
    const ui = (t._meta as { ui?: { visibility?: string[] } } | undefined)?.ui;
    return !ui?.visibility || ui.visibility.includes("model");
  });
  return [
    ...listed.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
      // a failed call goes back to the model as an error result (the full JSON), so it can correct itself
      execute: async (args: Record<string, unknown>) => {
        const r = await client.callTool({ name: t.name, arguments: args });
        if (r.isError) throw new Error(JSON.stringify(r.structuredContent ?? r.content));
        return r.structuredContent ?? r.content;
      },
    })),
    {
      name: "read_resource",
      description: "Read a Calque resource: core://<name> (doctrine, compositions, anti-slop, forms, pack-contract, workflows/<name>) or pack://<id>/<name> (DESIGN.md, voice, exemplar, storyline, template-map, tokens, manifest).",
      inputSchema: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"], additionalProperties: false },
      execute: async ({ uri }) => text(await client.readResource({ uri: String(uri) })),
    },
  ];
}

/** One user turn: runs until the model answers in text. Returns the new messages to append. */
export async function chat(i: ChatInput): Promise<{ text: string; messages: Message[] }> {
  return runTools({
    model: i.model,
    instructions: await instructions(i.client, i.workflow ?? (i.deck_id ? "edit-slides" : "build-presentation"), i.pack_id, i.deck_id, i.files),
    messages: i.messages,
    tools: await tools(i.client),
    ...(i.onStep ? { onStep: i.onStep } : {}),
  });
}

/** Apply a deck's open comments (each anchored on a slide id and shape_id) with patch_deck. */
export async function applyComments(i: Omit<ChatInput, "messages" | "workflow"> & { deck_id: string }) {
  const ask = `Apply every open comment on deck ${i.deck_id}. list_comments, open_deck to see the slides and shape_ids,
then one patch_deck per comment (or one for all) passing the comment ids in \`resolves\`. A comment you cannot
apply safely: leave it open and say why. Finish with lint_deck at 0 ERROR, then list what changed.`;
  return chat({ ...i, workflow: "edit-slides", messages: [{ role: "user", content: ask }] });
}
