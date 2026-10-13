import { expect, test } from "vitest";
import type { PackReport } from "../pages/Compliance.tsx";
import { setLang } from "../i18n.ts";
import { insights } from "./InsightCards.tsx";

const deck = (errors: number | null, warns: number | null, owner: string) =>
  ({ id: owner + errors, title: "d", owner, owner_name: null, teams: [], version: 1, updated_at: "2026-10-01", errors, warns });

test("insights derive from the compliance report", () => {
  setLang("en");
  const p: PackReport = {
    pack_id: "x",
    name: "X",
    summary: { decks: 4, linted: 3, clean: 2, errors: 3, warns: 1 },
    by_owner: [{ owner: "a", name: "Ann", decks: 2, errors: 3, warns: 0 }, { owner: "b", name: null, decks: 2, errors: 0, warns: 1 }],
    by_team: [],
    approval: { draft: 1, in_review: 2, approved: 1 },
    trend: [
      { week: "2026-10-05", versions: 4, decks: 2, errors: 2, warns: 0 },
      { week: "2026-09-28", versions: 2, decks: 1, errors: 4, warns: 1 },
    ],
    decks: [deck(3, 0, "a"), deck(0, 1, "b"), deck(0, 0, "b"), deck(null, null, "a")],
  };
  const byId = Object.fromEntries(insights(p).map((c) => [c.id, c]));
  expect(Object.keys(byId)).toEqual(["clean", "trend", "activity", "owners", "approval"]);
  expect(byId.clean?.text).toBe("1 deck still has ERRORs on its latest version.");
  expect(byId.trend?.text).toMatch(/^Down from 2\.0/); // 4/2 the week before, 2/4 now
  expect(byId.owners?.text).toBe("Ann owns 3 of the 3 ERRORs.");
  expect(byId.approval?.text).toBe("2 decks waiting for review.");
});
