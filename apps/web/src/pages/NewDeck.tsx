import { useEffect, useState } from "react";
import { tool, type Pack } from "../api.ts";
import { Chat, type AgentResult } from "../components/Chat.tsx";
import { t } from "../i18n.ts";
import { navigate } from "../nav.ts";

const BRIEFS = [
  "Quarterly review for the leadership team: results, wins, risks, next quarter's plan.",
  "Client pitch: their problem, our approach, three proof points, next steps.",
  "Project kickoff: goals, scope, timeline, team, how we work together.",
] as const;

/** A new deck: pick its brand pack, then brief the agent; once it creates the deck, open it. */
export function NewDeck() {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [pack, setPack] = useState<string>("");
  useEffect(() => {
    tool<{ packs: Pack[] }>("list_packs").then((r) => {
      setPacks(r.packs);
      // the only pack, else the workspace's default (Settings > Brand packs)
      const pick = r.packs.length === 1 ? r.packs[0] : r.packs.find((p) => p.default);
      if (pick) setPack(pick.id);
    });
  }, []);

  // the server moved the draft conversation to the deck it created: it follows the deck
  function done(r: AgentResult) {
    const created = r.deck_id ?? JSON.stringify(r.messages).match(/"deck_id":"([0-9a-f-]{36})"/)?.[1];
    if (created) navigate(`/d/${created}`);
  }

  return (
    <div className="cq-brief">
      <Chat
        pack_id={pack || undefined}
        disabled={!pack}
        placeholder={t("What is the deck for, who is it for, what must it say?")}
        suggestions={BRIEFS.map((b) => t(b))}
        empty={
          <div className="cq-brief-hero">
            <h1>{t("What are we presenting?")}</h1>
            <p>{t("Brief the agent: the audience, the goal, the key messages. It builds an editable deck on your brand pack, then you refine it together.")}</p>
          </div>
        }
        footer={
          <select className="cq-select cq-pack-pick" aria-label={t("Brand pack")} value={pack} onChange={(e) => setPack(e.target.value)}>
            <option value="" disabled>
              {t("Choose a brand pack")}
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
