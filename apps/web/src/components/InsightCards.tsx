import { BarChart } from "diametral-ds/bar-chart";
import { Button } from "diametral-ds/button";
import { Card } from "diametral-ds/card";
import { DonutChart } from "diametral-ds/donut-chart";
import { Meter, MeterIndicator, MeterTrack } from "diametral-ds/meter";
import { Sparkline } from "diametral-ds/sparkline";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { day, num, t, tn } from "../i18n.ts";
import type { PackReport } from "../pages/Compliance.tsx";

type Insight = { id: string; label: string; value: string; text: string; chart: ReactNode };

const pct = (n: number, of: number) => num(of ? n / of : 0, { style: "percent", maximumFractionDigits: 0 });
const rate = (w: PackReport["trend"][number]) => (w.versions ? w.errors / w.versions : 0);
const rate1 = (n: number) => num(n, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** The handful of things worth saying about a pack's compliance report, each with its number and chart. */
export function insights(p: PackReport): Insight[] {
  const out: Insight[] = [];
  const linted = p.decks.filter((d) => d.errors !== null);
  if (linted.length) {
    const withErrors = linted.filter((d) => d.errors).length;
    const warnsOnly = linted.filter((d) => !d.errors && d.warns).length;
    const rows = [
      { k: "clean", n: linted.length - withErrors - warnsOnly },
      { k: "warns", n: warnsOnly },
      { k: "errors", n: withErrors },
    ];
    out.push({
      id: "clean",
      label: t("Lint clean"),
      value: pct(p.summary.clean, p.summary.linted),
      text: withErrors
        ? tn(withErrors, "{n} deck still has ERRORs on its latest version.", "{n} decks still have ERRORs on their latest version.")
        : t("No linted deck has an ERROR on its latest version."),
      chart: (
        <DonutChart
          className="h-40 w-full"
          data={rows.filter((r) => r.n > 0)}
          valueKey="n"
          nameKey="k"
          thickness={30}
          config={{
            clean: { label: t("Lint clean"), color: "var(--ds-success)" },
            warns: { label: t("WARNs"), color: "var(--ds-warning)" },
            errors: { label: t("ERRORs"), color: "var(--ds-danger)" },
          }}
        />
      ),
    });
  }
  const weeks = [...p.trend].reverse(); // the server sends the newest week first
  const last = weeks.at(-1);
  if (last) {
    const prev = weeks.at(-2);
    const [a, b] = [prev ? rate(prev) : 0, rate(last)];
    out.push({
      id: "trend",
      label: t("ERRORs per version"),
      value: rate1(b),
      text: !prev
        ? t("{n} ERRORs per version the week of {week}.", { n: rate1(b), week: day(last.week) })
        : b < a
          ? t("Down from {a} the week before.", { a: rate1(a) })
          : b > a
            ? t("Up from {a} the week before.", { a: rate1(a) })
            : t("Same as the week before."),
      // one week is a dot, not a trend
      chart: weeks.length > 1 ? <Sparkline className="text-chart-1" data={weeks.map(rate)} width={160} height={48} fill showDot aria-label={t("ERRORs per version")} /> : null,
    });
    out.push({
      id: "activity",
      label: t("Versions linted"),
      value: num(last.versions),
      text: tn(last.decks, "{n} deck worked on the week of {week}.", "{n} decks worked on the week of {week}.", { week: day(last.week) }),
      chart: <BarChart className="h-24 w-full" data={weeks} xAxisKey="week" grid={false} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} config={{ versions: { label: t("Versions linted") } }} />,
    });
  }
  const owners = p.by_owner.filter((o) => o.errors).sort((x, y) => y.errors - x.errors);
  if (owners[0]) {
    const top = owners[0];
    out.push({
      id: "owners",
      label: t("ERRORs by owner"),
      value: pct(top.errors, p.summary.errors),
      text: t("{name} owns {n} of the {total} ERRORs.", { name: top.name ?? top.owner, n: num(top.errors), total: num(p.summary.errors) }),
      chart: (
        <BarChart
          className="h-24 w-full"
          horizontal
          grid={false}
          data={owners.slice(0, 4).map((o) => ({ who: o.name ?? o.owner, errors: o.errors, s: "danger" }))}
          xAxisKey="who"
          statusKey="s"
          margin={{ top: 0, right: 8, bottom: 0, left: 0 }}
          config={{ errors: { label: t("ERRORs") } }}
        />
      ),
    });
  }
  if (p.approval && p.summary.decks) {
    const { approved, in_review } = p.approval;
    out.push({
      id: "approval",
      label: t("Approved"),
      value: pct(approved, p.summary.decks),
      text: tn(in_review, "{n} deck waiting for review.", "{n} decks waiting for review."),
      chart: (
        <Meter className="w-full" tone="success" value={approved} max={p.summary.decks} aria-label={t("Approved")}>
          <MeterTrack>
            <MeterIndicator />
          </MeterTrack>
        </Meter>
      ),
    });
  }
  return out;
}

/** Insight cards over a compliance report: all of them in a grid on wide screens, one at a time
with previous/next below `lg`. */
export function InsightCards({ report }: { report: PackReport }) {
  const cards = insights(report);
  const [page, setPage] = useState(0);
  if (!cards.length) return null;
  const at = Math.min(page, cards.length - 1);
  return (
    <section aria-label={t("Insights")} data-insights={report.pack_id}>
      <div className="grid gap-3 lg:grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
        {cards.map((c, i) => (
          <Card key={c.id} data-insight={c.id} className={`flex min-w-0 flex-col gap-2 p-4 ${i === at ? "" : "hidden lg:flex"}`}>
            <span className="text-xs uppercase tracking-wide text-muted-foreground">{c.label}</span>
            <strong className="text-3xl font-semibold tabular-nums">{c.value}</strong>
            <p className="m-0 text-sm">{c.text}</p>
            <div className="mt-auto flex min-h-24 items-end">{c.chart}</div>
          </Card>
        ))}
      </div>
      {cards.length > 1 && (
        <div className="mt-2 flex items-center justify-center gap-2 lg:hidden">
          <Button variant="ghost" size="icon" aria-label={t("Previous")} disabled={at === 0} onClick={() => setPage(at - 1)}>
            <ChevronLeft />
          </Button>
          <span className="text-sm tabular-nums" aria-live="polite">
            {at + 1} / {cards.length}
          </span>
          <Button variant="ghost" size="icon" aria-label={t("Next")} disabled={at === cards.length - 1} onClick={() => setPage(at + 1)}>
            <ChevronRight />
          </Button>
        </div>
      )}
    </section>
  );
}
