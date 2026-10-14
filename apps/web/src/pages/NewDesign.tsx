import { useEffect, useState } from "react";
import { tool, type Pack } from "../api.ts";
import { Chat, type AgentResult } from "../components/Chat.tsx";
import { t } from "../i18n.ts";
import { navigate } from "../nav.ts";

const BRIEFS = [
  "A LinkedIn post and a story announcing our new offer, with one key figure.",
  "A 728x90 and a 300x250 display ad for our webinar next month.",
  "An A4 poster for the office: our three values, one line each.",
] as const;

/** The design a reply created, from its tool results. */
const createdDesign = (r: AgentResult) => JSON.stringify(r.messages).match(/\\?"design_id\\?":\s*\\?"([0-9a-f-]{36})/)?.[1];

/** A new design: pick its brand pack, then brief the agent (create-design); once it creates the design, open it. */
export function NewDesign() {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [pack, setPack] = useState<string>("");
  useEffect(() => {
    tool<{ packs: Pack[] }>("list_packs").then((r) => {
      setPacks(r.packs);
      const pick = r.packs.length === 1 ? r.packs[0] : r.packs.find((p) => p.default);
      if (pick) setPack(pick.id);
    });
  }, []);

  // the draft conversation made the design: start the next brief from a clean draft
  async function done(r: AgentResult) {
    const id = createdDesign(r);
    if (!id) return;
    await tool("clear_chat", {}).catch(() => undefined);
    navigate(`/designs/${id}`);
  }

  return (
    <div className="cq-brief">
      <Chat
        pack_id={pack || undefined}
        disabled={!pack}
        workflow="create-design"
        placeholder={t("What is it for, where will it run, what must it say?")}
        suggestions={BRIEFS.map((b) => t(b))}
        empty={
          <div className="cq-brief-hero">
            <h1>{t("What are we designing?")}</h1>
            <p>{t("Brief the agent: the channel, the audience, the message. It lays out the design on your brand pack in every format you need, checks it, then you refine it together.")}</p>
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
        onDone={(r) => void done(r)}
      />
    </div>
  );
}
