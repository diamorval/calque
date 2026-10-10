import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { Card } from "diametral-ds/card";
import { StatCard, StatCardLabel, StatCardValue } from "diametral-ds/stat-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "diametral-ds/table";
import { Tag } from "diametral-ds/tag";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { day, num, t, tn } from "../i18n.ts";
import { go } from "../nav.ts";
import { ago, PageHead, Spinner } from "../ui.tsx";

type Tally = { decks: number; errors: number; warns: number };
/** GET /api/compliance (apps/server/src/compliance.ts), one entry per pack the caller manages. */
interface PackReport {
  pack_id: string;
  name: string;
  summary: Tally & { linted: number; clean: number };
  by_owner: (Tally & { owner: string; name: string | null })[];
  by_team: (Tally & { team: string })[];
  approval: Record<"draft" | "in_review" | "approved", number> | null;
  trend: { week: string; versions: number; decks: number; errors: number; warns: number }[];
  decks: {
    id: string;
    title: string;
    owner: string;
    owner_name: string | null;
    teams: string[];
    version: number;
    updated_at: string;
    errors: number | null;
    warns: number | null;
    approval?: string;
  }[];
}

const APPROVAL = { draft: "Draft", in_review: "In review", approved: "Approved" } as const;
const approvalLabel = (k: string | undefined) => (k && k in APPROVAL ? t(APPROVAL[k as keyof typeof APPROVAL]) : k);

const Count = ({ n, tone }: { n: number | null; tone: "danger" | "warning" }) =>
  n === null ? <span className="cq-muted">{t("not linted yet")}</span> : n ? <Tag tone={tone}>{n}</Tag> : <span className="cq-muted">0</span>;

/** A small table of rows. */
function Grid(props: { head: string[]; rows: ReactNode[][] }) {
  return (
    <Card className="cq-table-card">
      <Table>
        <TableHeader>
          <TableRow>
            {props.head.map((h) => (
              <TableHead key={h}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.rows.map((r, i) => (
            <TableRow key={i}>
              {r.map((c, j) => (
                <TableCell key={j}>{c}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

/** Brand packs > Compliance: for the packs one owns (all of them, for an admin), who made which
deck and how far it is from the charter: lint ERRORs and WARNs on its latest version. */
export function Compliance() {
  const [report, setReport] = useState<PackReport[] | null>(null);
  const [pack, setPack] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ packs: PackReport[] }>("/api/compliance");
      setReport(r.packs);
      setPack((p) => p ?? r.packs.find((x) => x.summary.decks)?.pack_id ?? r.packs[0]?.pack_id ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const p = report?.find((r) => r.pack_id === pack);
  const pending = p ? p.summary.decks - p.summary.linted : 0;
  return (
    <div className="cq-page">
      <PageHead title={t("Brand compliance")} description={t("Decks made on the packs you manage, and the lint ERRORs and WARNs of their latest version. Counts and titles only.")}>
        <Button variant="ghost" onClick={(e) => go(e, "/settings/packs")}>
          <ArrowLeft /> {t("Brand packs")}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          <RefreshCw /> {t("Refresh")}
        </Button>
      </PageHead>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {busy && <Spinner label={t("Linting decks not linted yet")} />}
      {report && (
        <select className="cq-select" aria-label={t("Pack")} value={pack ?? ""} onChange={(e) => setPack(e.target.value)}>
          {report.map((r) => (
            <option key={r.pack_id} value={r.pack_id}>
              {r.name} ({tn(r.summary.decks, "{n} deck", "{n} decks")})
            </option>
          ))}
        </select>
      )}
      {p && (
        <>
          <div className="cq-stats" data-compliance={p.pack_id}>
            {[
              [t("Decks"), num(p.summary.decks)],
              [t("Lint clean"), `${num(p.summary.clean)} / ${num(p.summary.linted)}`],
              [t("ERRORs"), num(p.summary.errors)],
              [t("WARNs"), num(p.summary.warns)],
              ...(p.approval ? Object.entries(p.approval).map(([k, n]) => [approvalLabel(k), num(n)]) : []),
            ].map(([label, value]) => (
              <StatCard key={String(label)}>
                <StatCardLabel>{label}</StatCardLabel>
                <StatCardValue>{value}</StatCardValue>
              </StatCard>
            ))}
          </div>
          {pending > 0 && <p className="cq-hint">{tn(pending, "{n} deck not linted yet: refresh to lint the next ones.", "{n} decks not linted yet: refresh to lint the next ones.")}</p>}
          {p.decks.length > 0 && (
            <>
              <Grid
                head={[t("Deck"), t("Owner"), t("Teams"), t("Version"), t("Updated"), t("ERRORs"), t("WARNs"), ...(p.approval ? [t("Approval")] : [])]}
                rows={p.decks.map((d) => [
                  <strong key="t">{d.title}</strong>,
                  d.owner_name ?? d.owner,
                  d.teams.join(", "),
                  `v${d.version}`,
                  ago(d.updated_at),
                  <Count key="e" n={d.errors} tone="danger" />,
                  <Count key="w" n={d.warns} tone="warning" />,
                  ...(p.approval ? [approvalLabel(d.approval)] : []),
                ])}
              />
              <div className="cq-columns">
                <Grid head={[t("Owner"), t("Decks"), t("ERRORs"), t("WARNs")]} rows={p.by_owner.map((o) => [o.name ?? o.owner, o.decks, o.errors, o.warns])} />
                <Grid head={[t("Team"), t("Decks"), t("ERRORs"), t("WARNs")]} rows={p.by_team.map((t) => [t.team, t.decks, t.errors, t.warns])} />
              </div>
              {p.trend.length > 0 && (
                <Grid
                  head={[t("Week of"), t("Versions linted"), t("Decks"), t("ERRORs"), t("WARNs"), t("ERRORs per version")]}
                  rows={p.trend.map((w) => [day(w.week), w.versions, w.decks, w.errors, w.warns, num(w.errors / w.versions, { minimumFractionDigits: 1, maximumFractionDigits: 1 })])}
                />
              )}
            </>
          )}
          {!p.decks.length && <p className="cq-hint">{t("No deck on this pack yet.")}</p>}
        </>
      )}
    </div>
  );
}
