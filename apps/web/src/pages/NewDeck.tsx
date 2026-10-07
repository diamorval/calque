import {
  Field,
  FieldDescription,
  FieldLabel,
  PageHeader,
  PageHeaderHeading,
  PageHeaderTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@diametral/design-system/react";
import { useEffect, useState } from "react";
import { tool, type Pack } from "../api.ts";
import { Chat, saveChat, type AgentResult, type ChatMessage } from "../components/Chat.tsx";
import { navigate } from "../nav.ts";

const KEY = "chat:new";

/** A new deck: pick its brand pack, then brief the agent; once it creates the deck, open it. */
export function NewDeck() {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [pack, setPack] = useState<string | null>(null);
  useEffect(() => {
    tool<{ packs: Pack[] }>("list_packs").then((r) => {
      setPacks(r.packs);
      if (r.packs.length === 1) setPack(r.packs[0]?.id ?? null);
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
    <>
      <PageHeader>
        <PageHeaderHeading>
          <PageHeaderTitle>New deck</PageHeaderTitle>
        </PageHeaderHeading>
      </PageHeader>
      <div className="cq-stack">
        <Field>
          <FieldLabel id="pack-label">Brand pack</FieldLabel>
          <Select value={pack} onValueChange={(v) => setPack(v as string)}>
            <SelectTrigger aria-labelledby="pack-label">
              <SelectValue placeholder="Choose a brand pack" />
            </SelectTrigger>
            <SelectContent>
              {packs.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>The deck follows this company's template, colours, fonts and voice.</FieldDescription>
        </Field>
        <Chat storageKey={KEY} pack_id={pack ?? undefined} disabled={!pack} placeholder="What is the deck for, who is it for, what must it say?" onDone={done} />
      </div>
    </>
  );
}
