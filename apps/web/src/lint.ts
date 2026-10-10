/** A lint finding as `lint_deck` returns it; `slide` is 1-based, null for the whole deck. */
export type Finding = { severity: "ERROR" | "WARN" | "NOTE"; slide: number | null; shape_id: number | null; check: string; message: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The editor's lint badge: "Lint clean" only when there is nothing at all to look at. */
export function lintSummary(findings: Finding[]): { label: string; tone: "success" | "warning" | "danger" } {
  if (!findings.length) return { label: "Lint clean", tone: "success" };
  const n = (s: Finding["severity"]) => findings.filter((f) => f.severity === s).length;
  const notes = n("NOTE");
  const label = [plural(n("ERROR"), "error"), plural(n("WARN"), "warning"), ...(notes ? [plural(notes, "note")] : [])].join(" · ");
  return { label, tone: n("ERROR") ? "danger" : "warning" };
}

const RANK = { ERROR: 0, WARN: 1, NOTE: 2 };

/** Errors first, then warnings, then notes; deck-level before slide 1, then by slide. */
export const bySeverity = (findings: Finding[]) =>
  [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity] || (a.slide ?? 0) - (b.slide ?? 0));
