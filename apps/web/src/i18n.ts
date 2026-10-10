// The web app's languages, in-house: the English text is the key, `fr` (i18n/fr.ts) its French, `en`
// the few English texts that differ from their key (a short label: "New (short)" -> "New"). The
// language is the user's choice, kept in localStorage, else the browser's (French if it says fr).
// Dates and numbers follow the chosen language too, never the browser's, so a page reads in one.
import type { SlideUiStrings } from "@calque/slide-ui";
import { useSyncExternalStore } from "react";
import { en, fr, type Key } from "./i18n/fr.ts";

export type Lang = "en" | "fr";
export const LANGS: Record<Lang, string> = { en: "English", fr: "Français" }; // each in its own language
const KEY = "cq-lang";

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "en" || saved === "fr") return saved;
  } catch {
    // storage blocked: follow the browser
  }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

let lang: Lang = initial();
const listeners = new Set<() => void>();
const mark = () => {
  if (typeof document !== "undefined") document.documentElement.lang = lang;
};
mark();

export const getLang = () => lang;

/** Switch the UI language; it lasts across visits (if storage allows). */
export function setLang(next: Lang) {
  lang = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // the choice lasts for this page only
  }
  mark();
  for (const l of listeners) l();
}

/** The language, re-rendering on a switch. The app's root uses it, so every page follows. */
export function useLang(): Lang {
  return useSyncExternalStore(
    (on) => {
      listeners.add(on);
      return () => listeners.delete(on);
    },
    getLang,
    getLang,
  );
}

type Vars = Record<string, string | number>;
const fill = (text: string, vars?: Vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text);

/** `key` in the current language, `{name}` filled from `vars`. */
export function t(key: Key, vars?: Vars): string {
  return fill(lang === "fr" ? fr[key] : (en[key] ?? key), vars);
}

/** One of two forms by `n`, the language's plural rule deciding ("0 erreur" but "0 errors"); `{n}` is n. */
export function tn(n: number, one: Key, other: Key, vars?: Vars): string {
  return t(new Intl.PluralRules(lang).select(n) === "one" ? one : other, { n, ...vars });
}

/** A number in the UI language. */
export const num = (n: number, opts?: Intl.NumberFormatOptions) => new Intl.NumberFormat(lang, opts).format(n);

/** A date and time in the UI language. */
export const dateTime = (iso: string) => new Date(iso).toLocaleString(lang, { dateStyle: "medium", timeStyle: "short" });

/** A day in the UI language ("2026-10-05" -> "5 oct. 2026"). */
export const day = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString(lang, { dateStyle: "medium" });

/** A day spelled out in the UI language ("October 5, 2026", "5 octobre 2026"), local time. */
export const longDay = (iso: string) => new Date(iso).toLocaleDateString(lang, { day: "numeric", month: "long", year: "numeric" });

/** "3 minutes ago", "yesterday", "il y a 3 minutes"… in the UI language. */
export function ago(iso: string, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  let v = (new Date(iso).getTime() - now) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [["second", 60], ["minute", 60], ["hour", 24], ["day", 7], ["week", 4.35], ["month", 12], ["year", Infinity]];
  for (const [unit, size] of steps) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit);
    v /= size;
  }
  return iso;
}

/** The deck UI's words (packages/slide-ui), in the UI language. */
export function slideUiStrings(): SlideUiStrings {
  return {
    approval: { draft: t("Draft"), in_review: t("In review"), approved: t("Approved") },
    emptyDeck: t("Empty deck."),
    stage: t("Slide"),
    slide: (n) => t("Slide {n}", { n }),
    previousSlide: t("Previous slide"),
    nextSlide: t("Next slide"),
    clickToComment: t("Click an element to comment on it"),
    outlineShapes: t("Outline every shape"),
    shapes: t("Shapes"),
    wholeSlide: t("whole slide"),
    commentWholeSlide: t("Comment on the whole slide"),
    commentOn: (slide, shape) => (shape === null ? t("Comment on slide {slide}", { slide }) : t("Comment on slide {slide}, shape {shape}", { slide, shape })),
    askShape: (label) => t("What should change in this {label}?", { label }),
    askSlide: t("What should change on this slide?"),
    comment: t("Comment"),
    sidePanel: t("Side panel"),
    agent: t("Agent"),
    comments: t("Comments"),
    noOpenComment: t("No open comment"),
    noOpenCommentHint: t("Click an element on the slide, say what should change, then let the agent apply it."),
    repliesTo: (id) => t("Replies to comment {id}", { id }),
    selectComment: (id) => t("Select comment {id}", { id }),
    select: t("Select"),
    replyTo: (id) => t("Reply to comment {id}", { id }),
    reply: t("Reply"),
    resolveComment: (id) => t("Resolve comment {id}", { id }),
    resolve: t("Resolve"),
    replyPlaceholder: t("Reply…"),
    send: t("Send"),
    resolvedComments: (n) => tn(n, "{n} resolved comment", "{n} resolved comments"),
    reopenComment: (id) => t("Reopen comment {id}", { id }),
    reopen: t("Reopen"),
    applySelected: (n) => t("Apply {n} selected", { n }),
    applyAll: (n) => tn(n, "Apply {n} comment", "Apply {n} comments"),
    applySelectedHint: t("The agent edits the deck for the selected comments only."),
    applyAllHint: t("The agent edits the deck, then resolves each comment."),
    slides: t("Slides"),
    commentCount: (n) => tn(n, "{n} comment", "{n} comments"),
    shape: (id, role) => t("Shape {id} ({role})", { id, role }),
    required: t("Required"),
    requiredHint: t("A required comment blocks the deck's approval until it is resolved"),
  };
}
