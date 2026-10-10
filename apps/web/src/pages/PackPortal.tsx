import { Alert, AlertDescription } from "diametral-ds/alert";
import { Button } from "diametral-ds/button";
import { Tag } from "diametral-ds/tag";
import { ArrowLeft, GitBranch } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { go } from "../nav.ts";
import { PageHead, Spinner } from "../ui.tsx";

/** GET /api/packs/:id (apps/server/src/portal.ts). */
interface Portal {
  id: string;
  name: string;
  version: string;
  pack_version: number;
  languages: string[];
  extends: string[];
  inherited: string[];
  approval: boolean;
  design_md: string | null;
  voice: string | null;
  storyline: string | null;
  exemplar: string | null;
  colors: { path: string; hex: string; description: string | null; role: boolean }[];
  fonts: { role: string; family: string; weight: unknown; fallback: string | null }[];
  font_files: string[];
  rules: { severity: string; lang: string; note: string }[];
  placeholders: string[];
  slides: { number: number; layout: string; description: string | null; roles: string[]; never_clone: boolean; image_url: string }[];
  exemplar_images: { name: string; url: string }[];
  icons: { name: string; url: string }[];
}

/** One part of the charter; `from`: the group pack it is inherited from. */
function Section(props: { title: string; from?: string | undefined; children: ReactNode }) {
  return (
    <section className="cq-shared cq-portal-section">
      <h2>
        {props.title}{" "}
        {props.from && (
          <Tag tone="info">
            <GitBranch /> {t("from {pack}", { pack: props.from })}
          </Tag>
        )}
      </h2>
      {props.children}
    </section>
  );
}

const Doc = ({ text }: { text: string }) => <pre className="cq-card cq-doc">{text.trim()}</pre>;

/** Brand packs > a pack: its charter, read-only, for anyone who sees the pack. */
export function PackPortal({ id }: { id: string }) {
  const [p, setP] = useState<Portal | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setP(null);
    api<Portal>(`/api/packs/${encodeURIComponent(id)}`).then(setP, (e: Error) => setError(e.message));
  }, [id]);

  const back = (
    <Button variant="ghost" onClick={(e) => go(e, "/settings/packs")}>
      <ArrowLeft /> {t("Brand packs")}
    </Button>
  );
  if (error)
    return (
      <div className="cq-page">
        <PageHead title={t("Brand pack")}>{back}</PageHead>
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  if (!p) return <Spinner label={t("Loading the charter")} />;

  const parent = p.extends[0];
  const from = (part: string) => (p.inherited.includes(part) ? parent : undefined);
  const swatch = (c: Portal["colors"][number]) => (
    <li key={c.path} title={c.description ?? c.path}>
      <svg className="cq-swatch" viewBox="0 0 1 1" aria-hidden>
        <rect width="1" height="1" fill={`#${c.hex}`} />
      </svg>
      <span className="cq-mono">{c.path.replace(/^(role\.color|color)\./, "")}</span>
      <span className="cq-mono cq-muted">#{c.hex}</span>
    </li>
  );
  return (
    <div className="cq-page" data-portal={p.id}>
      <PageHead
        title={p.name}
        description={
          <>
            <span className="cq-mono">
              {p.id} · v{p.version} · {t("release {n}", { n: p.pack_version })}
            </span>{" "}
            · {p.languages.join(", ")}
            {parent && (
              <>
                {" "}
                · {t("extends")}{" "}
                <a href={`/settings/packs/${parent}`} onClick={(e) => go(e, `/settings/packs/${parent}`)}>
                  {parent}
                </a>
              </>
            )}
            {p.approval && ` · ${t("decks need approval")}`}
          </>
        }
      >
        {back}
      </PageHead>

      <Section title={t("Palette")}>
        <ul className="cq-swatches" aria-label={t("Role colours")}>
          {p.colors.filter((c) => c.role).map(swatch)}
        </ul>
        {p.colors.some((c) => !c.role) && (
          <ul className="cq-swatches" aria-label={t("Full palette")}>
            {p.colors.filter((c) => !c.role).map(swatch)}
          </ul>
        )}
      </Section>

      <Section title={t("Fonts")}>
        <ul className="cq-swatches">
          {p.fonts.map((f) => (
            <li key={f.role}>
              <span className="cq-mono">{f.role}</span> {f.family}
              {f.weight != null && <span className="cq-muted"> {String(f.weight)}</span>}
              {f.fallback && <span className="cq-muted"> ({t("fallback {font}", { font: f.fallback })})</span>}
            </li>
          ))}
        </ul>
        {p.font_files.length > 0 && <p className="cq-hint">{t("Font files: {files}", { files: p.font_files.join(", ") })}</p>}
      </Section>

      {p.voice && (
        <Section title={t("Voice")} from={from("voice")}>
          <Doc text={p.voice} />
        </Section>
      )}
      {(p.rules.length > 0 || p.placeholders.length > 0) && (
        <Section title={t("Rules the lint enforces")} from={from("slop_rules")}>
          <ul className="cq-rules">
            {p.rules.map((r) => (
              <li key={`${r.severity}${r.note}`}>
                <Tag tone={r.severity === "ERROR" ? "danger" : "warning"}>{r.severity}</Tag> {r.note}
                {r.lang !== "any" && <span className="cq-muted"> ({r.lang})</span>}
              </li>
            ))}
          </ul>
          {p.placeholders.length > 0 && <p className="cq-hint">{t("Template placeholders that must never survive: {list}", { list: p.placeholders.join(" · ") })}</p>}
        </Section>
      )}
      {p.storyline && (
        <Section title={t("Storyline")} from={from("storyline")}>
          <Doc text={p.storyline} />
        </Section>
      )}
      {(p.exemplar || p.exemplar_images.length > 0) && (
        <Section title={t("Exemplar")} from={from("exemplar")}>
          {p.exemplar_images.length > 0 && (
            <ul className="cq-exemplar-grid">
              {p.exemplar_images.map((img) => (
                <li key={img.name}>
                  <a href={img.url} target="_blank" rel="noreferrer">
                    <img src={img.url} alt={img.name} loading="lazy" />
                  </a>
                </li>
              ))}
            </ul>
          )}
          {p.exemplar && <Doc text={p.exemplar} />}
        </Section>
      )}

      <Section title={t("Template slides")}>
        <ul className="cq-template-grid">
          {p.slides.map((s) => (
            <li key={s.number} className="cq-card cq-template" data-slide={s.number}>
              <img src={s.image_url} alt={t("Template slide {n}", { n: s.number })} loading="lazy" />
              <div>
                <strong>{t("Slide {n}", { n: s.number })}</strong>
                <span className="cq-hint">{s.description ?? s.layout}</span>
              </div>
              <div className="cq-tags">
                {s.roles.map((r) => (
                  <Tag key={r} tone="info">
                    {r.replace(/_/g, " ")}
                  </Tag>
                ))}
                {s.never_clone && <Tag tone="neutral">{t("never cloned")}</Tag>}
              </div>
            </li>
          ))}
        </ul>
      </Section>

      {p.icons.length > 0 && (
        <Section title={t("Icons")}>
          <ul className="cq-icon-grid">
            {p.icons.map((i) => (
              <li key={i.name} title={i.name}>
                <img src={i.url} alt={i.name} loading="lazy" />
                <span className="cq-hint">{i.name.replace(/\.\w+$/, "")}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {p.design_md && (
        <Section title="DESIGN.md">
          <details>
            <summary>{t("The full charter the agent reads")}</summary>
            <Doc text={p.design_md} />
          </details>
        </Section>
      )}
    </div>
  );
}
