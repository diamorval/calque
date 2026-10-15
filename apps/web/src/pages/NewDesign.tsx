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

/** A design template: an approved artboard of the pack's library. */
interface Template {
  entry_id: string;
  title: string;
  thumbnail_url: string;
}

/** A new design: pick its brand pack, then brief the agent (create-design), or start from one of
the pack's templates; once the design exists, open it. */
export function NewDesign() {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [pack, setPack] = useState<string>("");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!pack) return setTemplates([]);
    tool<{ entries: Template[] }>("library_list", { pack_id: pack, medium: "design" }).then((r) => setTemplates(r.entries), () => setTemplates([]));
  }, [pack]);
  useEffect(() => {
    tool<{ packs: Pack[] }>("list_packs").then((r) => {
      setPacks(r.packs);
      const pick = r.packs.length === 1 ? r.packs[0] : r.packs.find((p) => p.default);
      if (pick) setPack(pick.id);
    });
  }, []);

  // the server moved the draft conversation to the design it created: it follows the design
  function done(r: AgentResult) {
    if (r.deck_id) navigate(`/designs/${r.deck_id}`);
  }
  const start = (e: Template) =>
    tool<{ deck_id: string }>("library_insert", { entry_id: e.entry_id }).then(
      (r) => navigate(`/designs/${r.deck_id}`),
      (err: Error) => setError(err.message),
    );

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
            {error && <p role="alert">{error}</p>}
            {templates.length > 0 && (
              <section className="cq-templates" aria-label={t("Start from a template")}>
                <h2>{t("Or start from a template")}</h2>
                <ul>
                  {templates.map((e) => (
                    <li key={e.entry_id}>
                      <button type="button" onClick={() => void start(e)}>
                        <img src={e.thumbnail_url} alt="" loading="lazy" />
                        <span>{e.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
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
