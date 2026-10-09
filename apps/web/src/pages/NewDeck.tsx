import { useEffect, useState } from "react";
import { tool, type Pack } from "../api.ts";
import { Chat, saveChat, type AgentResult, type ChatMessage } from "../components/Chat.tsx";
import { navigate } from "../nav.ts";

const KEY = "chat:new";
const BRIEFS = [
  "Quarterly review for the leadership team: results, wins, risks, next quarter's plan.",
  "Client pitch: their problem, our approach, three proof points, next steps.",
  "Project kickoff: goals, scope, timeline, team, how we work together.",
];

/** A new deck: pick its brand pack, then brief the agent; once it creates the deck, open it. */
export function NewDeck() {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [pack, setPack] = useState<string>("");
  useEffect(() => {
    tool<{ packs: Pack[] }>("list_packs").then((r) => {
      setPacks(r.packs);
      if (r.packs.length === 1) setPack(r.packs[0]?.id ?? "");
    });
  }, []);

  function done(r: AgentResult, conversation: ChatMessage[]) {
    const created = JSON.stringify(r.messages).match(/"deck_id":"([0-9a-f-]{36})"/)?.[1];
    if (!created) return;
    // the conversation follows the deck
    saveChat(`chat:${created}`, conversation);
    saveChat(KEY, []);
    navigate(`/d/${created}`);
  }

  return (
    <div className="cq-brief">
      <Chat
        storageKey={KEY}
        pack_id={pack || undefined}
        disabled={!pack}
        placeholder="What is the deck for, who is it for, what must it say?"
        suggestions={BRIEFS}
        empty={
          <div className="cq-brief-hero">
            <h1>What are we presenting?</h1>
            <p>Brief the agent: the audience, the goal, the key messages. It builds an editable deck on your brand pack, then you refine it together.</p>
          </div>
        }
        footer={
          <select className="cq-select cq-pack-pick" aria-label="Brand pack" value={pack} onChange={(e) => setPack(e.target.value)}>
            <option value="" disabled>
              Choose a brand pack
            </option>
            {packs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        }
        onDone={done}
      />
    </div>
  );
}
