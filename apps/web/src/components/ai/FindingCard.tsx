// One lint finding as a recommendation: severity, where, what, and a hand-off to the agent.
// Adapted from beautifului.dev (MIT): RecommendationCard, without a confidence meter (lint has no score).
import { Button } from "diametral-ds/button";
import { Card, CardContent, CardFooter, CardHeader } from "diametral-ds/card";
import { Tag } from "diametral-ds/tag";
import { Sparkles } from "lucide-react";
import { t } from "../../i18n.ts";
import type { Finding } from "../../lint.ts";

const TONE = { ERROR: "danger", WARN: "warning", NOTE: "neutral" } as const;

/** The chat message asking the agent to fix `f`. */
export const fixAsk = (f: Finding) =>
  f.slide === null
    ? t("Fix this lint finding on the deck ({check}): {message}", { check: f.check, message: f.message })
    : f.shape_id === null
      ? t("Fix this lint finding on slide {n} ({check}): {message}", { n: f.slide, check: f.check, message: f.message })
      : t("Fix this lint finding on slide {n}, shape {id} ({check}): {message}", { n: f.slide, id: f.shape_id, check: f.check, message: f.message });

export function FindingCard({ finding: f, onFix }: { finding: Finding; onFix?: () => void }) {
  return (
    <Card size="sm" role="listitem">
      <CardHeader className="flex flex-wrap items-center gap-2">
        <Tag tone={TONE[f.severity]}>{f.severity}</Tag>
        <span className="text-sm font-medium">
          {f.slide ? t("Slide {n}", { n: f.slide }) : t("Deck")}
          {f.shape_id !== null && ` · ${t("shape {id}", { id: f.shape_id })}`}
        </span>
        <span className="cq-mono ml-auto text-xs text-muted-foreground">{f.check}</span>
      </CardHeader>
      <CardContent className="text-sm">{f.message}</CardContent>
      {onFix && (
        <CardFooter className="justify-end">
          <Button size="sm" variant="outline" onClick={onFix}>
            <Sparkles /> {t("Fix with the agent")}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
