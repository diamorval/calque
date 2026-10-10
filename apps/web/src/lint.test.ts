import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "./i18n.ts";
import { bySeverity, type Finding, lintSummary } from "./lint.ts";

const f = (severity: Finding["severity"], slide: number | null = 1): Finding => ({ severity, slide, shape_id: null, check: "x", message: "m" });

describe("lintSummary", () => {
  beforeEach(() => setLang("en"));

  it("reads clean only with no finding at all", () => {
    expect(lintSummary([])).toEqual({ label: "Lint clean", tone: "success" });
  });

  it("counts warnings even with no error", () => {
    expect(lintSummary([f("WARN"), f("WARN")])).toEqual({ label: "0 errors · 2 warnings", tone: "warning" });
  });

  it("leads with errors and adds notes when there are some", () => {
    expect(lintSummary([f("ERROR"), f("WARN"), f("NOTE")])).toEqual({ label: "1 error · 1 warning · 1 note", tone: "danger" });
  });

  it("speaks the UI language, with its own plural rule", () => {
    setLang("fr");
    expect(lintSummary([])).toEqual({ label: "Conforme", tone: "success" });
    expect(lintSummary([f("WARN"), f("WARN")]).label).toBe("0 erreur · 2 alertes");
  });

  it("lists errors first, deck-level before slides", () => {
    const list = bySeverity([f("WARN", 3), f("NOTE", 1), f("ERROR", 4), f("WARN", null)]);
    expect(list.map((x) => `${x.severity}${x.slide ?? "-"}`)).toEqual(["ERROR4", "WARN-", "WARN3", "NOTE1"]);
  });
});
