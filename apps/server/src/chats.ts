import type { Message } from "@calque/llm";
import type { Db } from "./db.ts";
import type { Decks } from "./decks.ts";
import { Forbidden, type User } from "./packs.ts";

/** The web agent's conversations, kept on the server (S3) so they follow the deck to another PC and
to colleagues. One per deck, read by whoever may open the deck (viewer) and continued by its editors
(the agent changes the deck); and one new-deck draft per user, private, that moves to the deck the
agent creates from it. A conversation over MAX_CHAT bytes drops its oldest turns. Deleted with the
deck; a draft untouched for CALQUE_RETENTION_DAYS goes with the retention purge (retention.ts). */

export const MAX_CHAT = 1024 * 1024;

interface Row {
  messages: Message[];
  files: string[];
  updated_at: string;
}

const key = (user: User, deckId?: string) => (deckId ? `deck:${deckId}` : `draft:${user.id}`);

/** A conversation `deckId` (a viewer), or `user`'s new-deck draft: messages, attached file ids,
and whether `user` may continue it. */
export async function getChat(db: Db, decks: Decks, user: User, deckId?: string) {
  if (user.anonymous) throw new Forbidden("sign in to talk to the agent");
  const deck = deckId ? await decks.deck(user, deckId, "viewer") : undefined;
  const { rows } = await db.query<Row>("select messages, files, updated_at from chats where id = $1", [key(user, deckId)]);
  const r = rows[0];
  return {
    deck_id: deckId ?? null,
    messages: r?.messages ?? [],
    files: r?.files ?? [],
    updated_at: r?.updated_at ?? null,
    can_write: !deck || deck.role === "editor" || deck.role === "owner",
  };
}

/** Check that `user` may continue conversation `deckId` (an editor of the deck), or their draft. */
export async function writable(decks: Decks, user: User, deckId?: string) {
  if (user.anonymous) throw new Forbidden("sign in to talk to the agent");
  if (deckId) await decks.deck(user, deckId, "editor");
}

/** Oldest turns off (a turn: a user message and the agent's answer) until the JSON fits in `max`. */
export function trim(messages: Message[], max = MAX_CHAT): Message[] {
  let out = messages;
  while (out.length && JSON.stringify(out).length > max) {
    const next = out.findIndex((m, i) => i > 0 && m.role === "user");
    out = next > 0 ? out.slice(next) : [];
  }
  return out;
}

/** Add `turn` (the user's message and the agent's answer) and the `files` attached to conversation
`deckId` or `user`'s draft. Appends to what is stored now: two editors' turns both stay. */
export async function appendChat(db: Db, user: User, deckId: string | undefined, turn: Message[], files: string[]) {
  const id = key(user, deckId);
  const { rows } = await db.query<Row>("select messages, files from chats where id = $1", [id]);
  const messages = trim([...(rows[0]?.messages ?? []), ...turn]);
  const all = [...new Set([...(rows[0]?.files ?? []), ...files])];
  await db.query(
    `insert into chats (id, deck_id, owner, messages, files) values ($1, $2, $3, $4, $5)
     on conflict (id) do update set messages = $4, files = $5, updated_at = now()`,
    [id, deckId ?? null, user.id, JSON.stringify(messages), JSON.stringify(all)],
  );
}

/** Empty conversation `deckId` (an editor) or `user`'s draft: a new conversation starts. */
export async function clearChat(db: Db, decks: Decks, user: User, deckId?: string) {
  await writable(decks, user, deckId);
  await db.query("delete from chats where id = $1", [key(user, deckId)]);
  return { deck_id: deckId ?? null, cleared: true };
}

/** After a draft turn started at `since`: the first deck among `named` that it created for `user` (a
deck merely listed or opened does not count) gets the draft as its conversation, and the draft is
emptied. Returns that deck's id. */
export async function adoptDraft(db: Db, user: User, named: string[], since: Date): Promise<string | undefined> {
  for (const deckId of named) {
    const { rows } = await db.query<{ owner: string }>("select owner from decks where id = $1 and created_at >= $2", [deckId, since]);
    if (rows[0]?.owner !== user.id) continue;
    const draft = key(user);
    await db.query(
      `insert into chats (id, deck_id, owner, messages, files) select $2, $3, owner, messages, files from chats where id = $1
       on conflict (id) do nothing`,
      [draft, key(user, deckId), deckId],
    );
    await db.query("delete from chats where id = $1", [draft]);
    return deckId;
  }
  return undefined;
}

/** The deck ids a run's tool results name (create_deck, import_pptx…), first first. */
export function decksIn(messages: Message[]): string[] {
  return [...new Set([...JSON.stringify(messages).matchAll(/\\?"deck_id\\?":\s*\\?"([0-9a-f-]{36})\\?"/g)].map((m) => m[1] as string))];
}
