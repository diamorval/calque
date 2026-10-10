"""Deck linter: the mechanical half of brand conformance, every value read from the active pack.

Severities:
  ERROR  exact, no judgement involved: fails the run.
  WARN   needs eyes: an overflow estimate, a single-use colour on two shapes (a shape and its own
         label may legitimately be one element), anti-slop vocabulary, language typography, a
         chart without a source line (when the pack opts in with `lint.chart_source`).
  NOTE   sanctioned but worth surfacing: missing-value markers, slop in speaker notes.
"""

from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pptx import Presentation
from pptx.oxml.ns import qn
from pptx.util import Emu

from .build import SOURCE_NAME
from .core import SlopRule, slop_rules, typography_rules
from .extract import is_page_number
from .pack import Pack, load_pack
from .placeholders import missing_markers, placeholder_hits
from .slides import iter_shapes
from .style import Style

Severity = Literal["ERROR", "WARN", "NOTE"]
RANK = {"NOTE": 0, "WARN": 1, "ERROR": 2}
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
CANVAS_TOL = 0.02  # ignore hairline bleed from rounded EMU
LINE_FACTOR = 1.05  # line height as a multiple of font size
DEEP_NESTING = 2  # paragraph level 0 = bullet, 1 = sub-bullet, 2 = too deep
SOURCE_LINE = re.compile(r"^\s*sources?\b", re.I)  # a hand-written source line in an imported deck


@dataclass(frozen=True)
class Finding:
    severity: Severity
    slide: int | None  # 1-based; None = deck-level
    shape_id: int | None
    check: str
    message: str

    def __str__(self) -> str:
        where = f"s{self.slide}" if self.slide else "deck"
        sid = f"#{self.shape_id}" if self.shape_id is not None else ""
        return f"{where:>5} {sid:>6}  {self.severity:<5}  {self.check:<12} {self.message}"


def _snippet(text: str, n: int = 46) -> str:
    text = " ".join(text.split())
    return (text[: n - 1] + "…") if len(text) > n else text


def _owner(el) -> int | None:
    """shape_id of the nearest enclosing shape."""
    for node in (el, *el.iterancestors()):
        for nv in ("nvSpPr", "nvPicPr", "nvGrpSpPr", "nvGraphicFramePr", "nvCxnSpPr"):
            c = node.find(f"{P}{nv}/{P}cNvPr")
            if c is not None:
                return int(c.get("id"))
    return None


def _unused_default(el, own: str) -> bool:
    """True when `el` sits in a shape's list-style defaults and no run can inherit it: every run
    sets `own` (a child of `a:rPr`) itself and no paragraph draws a bullet. Google Slides exports
    nine such levels per shape; reporting them would bury the runs that really break the charter."""
    lst = next(el.iterancestors(f"{A}lstStyle"), None)
    if lst is None:
        return False
    body = lst.getparent()
    if body.find(f".//{A}buChar") is not None or body.find(f".//{A}buAutoNum") is not None:
        return False
    return all(r.find(f"{A}rPr/{A}{own}") is not None for r in body.findall(f".//{A}r"))


def _in_connector(el) -> bool:
    return any(a.tag == f"{P}cxnSp" for a in el.iterancestors())


def _rules(pack: Pack, language: str | None) -> list[SlopRule]:
    """Core rules + pack `lint.slop_rules`. A pack rule with a core rule's pattern may raise its
    severity, never lower it. Rules with a lang apply only when `language` matches."""
    rules = list(slop_rules())
    by_pat = {r.pattern.pattern: i for i, r in enumerate(rules)}
    for r in pack.manifest["lint"].get("slop_rules", []):
        rule = SlopRule(r["severity"], r["lang"], re.compile(r["pattern"], re.I | re.M), r["note"])
        i = by_pat.get(r["pattern"])
        if i is None:
            rules.append(rule)
        elif RANK[rule.severity] > RANK[rules[i].severity]:
            rules[i] = SlopRule(rule.severity, rules[i].lang, rules[i].pattern, rules[i].note)
    return _for_language(rules, language)


def _for_language(rules, language: str | None) -> list[SlopRule]:
    lang = (language or "").split("-")[0].lower()
    return [r for r in rules if r.lang == "any" or r.lang == lang]


def _hits(rule: SlopRule, text: str) -> list[str]:
    """Every distinct match of `rule` in `text`, in order, with a count when it repeats."""
    seen: dict[str, int] = {}
    for m in rule.pattern.finditer(text):
        hit = m.group(0).strip()
        if hit:
            seen[hit] = seen.get(hit, 0) + 1
    return [f"{h!r} x{n}" if n > 1 else repr(h) for h, n in seen.items()]


class _Linter:
    def __init__(self, pack: Pack, language, template_map, closing, template):
        self.pack, self.st, self.template = pack, Style(pack), template
        self.rules = _rules(pack, language)
        self.typography = _for_language(typography_rules(), language)
        self.chart_source = bool(pack.manifest["lint"].get("chart_source"))
        self.palette = pack.palette()
        self.fonts = {f.lower() for f in pack.fonts()}
        self.single = {pack.color_at(p) for p in pack.manifest["lint"].get("single_use_colors", [])}
        self.markers = missing_markers(pack)
        self.footer_top = pack.manifest["grid"]["footer_top_in"]
        self.source = template_map or {}
        self.closing = set(closing)
        tpl_pages = {s["number"]: s.get("page_number") for s in pack.template_map["slides"]}
        self.tpl_pages = tpl_pages
        self.out: list[Finding] = []

    def add(self, sev, num, sid, check, msg):
        self.out.append(Finding(sev, num, sid, check, msg))

    # --- deck-level ------------------------------------------------------------------------------

    def theme(self, path) -> None:
        """The theme's fontScheme must name pack faces, or any run losing its font reverts."""
        with zipfile.ZipFile(path) as z:
            for n in sorted(x for x in z.namelist() if re.match(r"ppt/theme/theme\d+\.xml$", x)):
                xml = z.read(n).decode("utf-8", "replace")
                for slot in ("majorFont", "minorFont"):
                    m = re.search(rf"<a:{slot}><a:latin typeface=\"([^\"]*)\"", xml)
                    face = m.group(1) if m else ""
                    if face.lower() not in self.fonts:
                        self.add(
                            "ERROR",
                            None,
                            None,
                            "theme",
                            f"{n} {slot} is {face or '(empty)'!r}, not a pack font",
                        )

    # --- per slide -------------------------------------------------------------------------------

    def slide(self, num: int, slide, w: float, h: float) -> None:
        root = slide._element
        self.fonts_check(num, root)
        self.palette_check(num, root)
        pages = self.page_ids(num, slide, w, h)
        if not self.template:
            self.text_check(num, slide)
            self.slop(num, slide, pages)
            if self.chart_source:
                self.source_check(num, slide)
        self.geometry(num, slide, w, h, pages)
        self.page_number(num, slide, pages)
        self.run_order(num, root)
        self.overflow(num, slide)

    def page_ids(self, num, slide, w, h) -> set[int]:
        """Page-number shapes: the template's (via `template_map`) plus any that look like one."""
        ids = {sh.shape_id for sh in slide.shapes if is_page_number(sh, w, h)}
        n = self.source.get(num, num if self.template else None)
        if self.tpl_pages.get(n):
            ids.add(self.tpl_pages[n])
        return ids

    def fonts_check(self, num, root) -> None:
        seen = set()
        for el in root.iter():
            face = el.get("typeface")
            if not face or face.startswith("+") or face.lower() in self.fonts:
                continue
            if _unused_default(el, "latin"):
                continue
            key = (_owner(el), face)
            if key not in seen:
                seen.add(key)
                self.add("ERROR", num, key[0], "font", f"uses {face!r}, not a pack font")

    def palette_check(self, num, root) -> None:
        """One finding per shape and hex. schemeClr references are fine by construction."""
        seen, single = set(), {}
        for el in root.iter(f"{A}srgbClr"):
            val = (el.get("val") or "").upper()
            if _unused_default(el, "solidFill"):
                continue
            if val not in self.palette:
                if self.template and _in_connector(el):
                    continue  # construction guides on documentation slides, never cloned
                key = (_owner(el), val)
                if key not in seen:
                    seen.add(key)
                    self.add("ERROR", num, key[0], "palette", f"uses #{val}, not in the palette")
            elif val in self.single:
                single.setdefault(val, set()).add(_owner(el))
        for val, owners in single.items():
            if len(owners) > 1:
                ids = sorted(o for o in owners if o is not None)
                self.add(
                    "WARN",
                    num,
                    ids[0] if ids else None,
                    "single-use",
                    f"#{val} on {len(owners)} shapes ({', '.join(map(str, ids))}): it marks ONE "
                    "element per slide. A shape and its own label count as one; two unrelated "
                    "elements do not.",
                )

    def text_check(self, num, slide) -> None:
        for shape in iter_shapes(slide.shapes):
            if not shape.has_text_frame or not shape.text_frame.text.strip():
                continue
            text = shape.text_frame.text
            for mk in self.markers:
                if mk in text:
                    self.add("NOTE", num, shape.shape_id, "gap", f"{mk} not filled")
            hits = placeholder_hits(text, self.pack)
            if hits:
                self.add(
                    "ERROR",
                    num,
                    shape.shape_id,
                    "placeholder",
                    f"template placeholder left in {_snippet(text)!r}",
                )

    def source_check(self, num, slide) -> None:
        """Pack opt-in (`lint.chart_source`): a native chart says where its numbers come from, in
        the build's source line or any text opening with "Source"."""
        shapes = list(iter_shapes(slide.shapes))
        charts = [sh for sh in shapes if getattr(sh, "has_chart", False)]
        if not charts or any(
            sh.has_text_frame
            and sh.text_frame.text.strip()
            and (sh.name == SOURCE_NAME or SOURCE_LINE.match(sh.text_frame.text))
            for sh in shapes
        ):
            return
        self.add(
            "WARN",
            num,
            charts[0].shape_id,
            "source",
            "chart without a source line: set the slide's `source` (who measured it, when)",
        )

    def is_footer(self, shape, pages: set[int]) -> bool:
        """The footer band's own furniture: the page number and a one-line running footer at the
        bottom right."""
        if shape.shape_id in pages:
            return True
        if not shape.has_text_frame or None in (shape.left, shape.top):
            return False
        text = shape.text_frame.text.strip()
        if Emu(shape.top).inches <= self.footer_top or "\n" in text:
            return False
        return Emu(shape.left).inches > self.st.grid.width * 0.75 and len(text) <= 60

    def slop(self, num, slide, pages) -> None:
        texts = []
        for shape in iter_shapes(slide.shapes):
            if shape.has_text_frame:
                text = shape.text_frame.text
            elif getattr(shape, "has_table", False) and shape.has_table:
                text = "\n".join(c.text for row in shape.table.rows for c in row.cells)
            else:
                continue
            if text.strip() and not self.is_footer(shape, pages):
                texts.append((shape, text, False))
        if slide.has_notes_slide:
            nt = slide.notes_slide.notes_text_frame
            if nt is not None and nt.text.strip():
                texts.append((slide.notes_slide.notes_placeholder, nt.text, True))
        # A `closing` clone keeps its signature line ("thank you", charter punctuation and all).
        closing = num in self.closing
        for shape, text, in_notes in texts:
            skip = closing and not in_notes
            for check, rules in (("slop", self.rules), ("typography", self.typography)):
                for r in () if skip else rules:
                    for hit in _hits(r, text):
                        self.add(
                            "NOTE" if in_notes else r.severity,  # notes are not projected
                            num,
                            None if in_notes else shape.shape_id,
                            check,
                            f"{'speaker notes ' if in_notes else ''}{hit}: {r.note}",
                        )
            if in_notes or not shape.has_text_frame:
                continue
            for para in shape.text_frame.paragraphs:
                if para.level >= DEEP_NESTING and para.text.strip():
                    self.add(
                        "ERROR",
                        num,
                        shape.shape_id,
                        "nesting",
                        f"bullet nested {para.level + 1} deep: {_snippet(para.text)!r} "
                        "(flatten, or split the slide)",
                    )
                    break

    def geometry(self, num, slide, w, h, pages) -> None:
        """Text stays on canvas and clear of the footer band. Pictures and decoration are exempt."""
        for shape in iter_shapes(slide.shapes):
            if not shape.has_text_frame or not shape.text_frame.text.strip():
                continue
            if None in (shape.left, shape.top, shape.width, shape.height):
                continue
            left, top = Emu(shape.left).inches, Emu(shape.top).inches
            right, bottom = left + Emu(shape.width).inches, top + Emu(shape.height).inches
            if (
                left < -CANVAS_TOL
                or top < -CANVAS_TOL
                or right > w + CANVAS_TOL
                or bottom > h + CANVAS_TOL
            ):
                self.add(
                    "ERROR",
                    num,
                    shape.shape_id,
                    "off-canvas",
                    f"spans L{left:.2f} T{top:.2f} R{right:.2f} B{bottom:.2f} "
                    f"(canvas {w:.2f}x{h:.2f})",
                )
            elif top > self.footer_top + 0.05 and not self.is_footer(shape, pages):
                self.add(
                    "WARN",
                    num,
                    shape.shape_id,
                    "footer-band",
                    f"starts at T{top:.2f}, below the footer line T{self.footer_top}",
                )

    def page_number(self, num, slide, pages) -> None:
        """A literal page number must read the slide's position; a slidenum field is exempt."""
        for shape in iter_shapes(slide.shapes):
            if shape.shape_id not in pages or not shape.has_text_frame:
                continue
            if shape.text_frame._txBody.find(f".//{A}fld") is not None:
                continue
            text = shape.text_frame.text.strip()
            if text.isdigit() and int(text) != num:
                self.add(
                    "ERROR",
                    num,
                    shape.shape_id,
                    "page-number",
                    f"reads {text!r} on slide {num}: renumber after reordering",
                )

    def run_order(self, num, root) -> None:
        """PowerPoint drops any run, break or field after `endParaRPr`: text that never renders."""
        for p in root.iter(f"{A}p"):
            end = p.find(f"{A}endParaRPr")
            if end is None:
                continue
            late = [e for e in end.itersiblings() if e.tag in (f"{A}r", f"{A}br", f"{A}fld")]
            if late:
                text = "".join(t.text or "" for e in late for t in e.iter(f"{A}t"))
                self.add(
                    "ERROR",
                    num,
                    _owner(p),
                    "run-order",
                    f"{len(late)} run(s) after endParaRPr, PowerPoint drops them: "
                    f"{_snippet(text)!r}",
                )

    # --- overflow (estimated) --------------------------------------------------------------------

    def width(self, text, name, size, bold) -> float:
        """Width at a fractional size: measure at 100 pt and scale (whole-pt fonts inflate)."""
        return self.st.text_width(text, name, 100, bold) * size / 100

    def runs(self, tf):
        """[(paragraph, [(text, font, size, bold)], end size)], sizes autofit-scaled. A run with no
        size takes the paragraph's endParaRPr size, else the shape's commonest size, else 12."""
        body = tf._txBody.find(qn("a:bodyPr"))
        fit = body.find(qn("a:normAutofit")) if body is not None else None
        scale = int(fit.get("fontScale", 100000)) / 100000 if fit is not None else 1.0
        explicit = [r.font.size.pt for p in tf.paragraphs for r in p.runs if r.font.size]
        fallback = max(set(explicit), key=explicit.count) if explicit else 12.0
        body_font = self.pack.font("body")
        out = []
        for para in tf.paragraphs:
            end = para._p.find(qn("a:endParaRPr"))
            end_sz = end.get("sz") if end is not None else None
            default = int(end_sz) / 100 if end_sz else fallback
            runs = [
                (
                    r.text,
                    r.font.name or body_font,
                    (r.font.size.pt if r.font.size else default) * scale,
                    bool(r.font.bold),
                )
                for r in para.runs
            ]
            out.append((para, runs, default * scale))
        while out and not any(t.strip() for t, *_ in out[-1][1]):
            out.pop()  # trailing empty paragraphs take no room
        return out

    def lines(self, runs, box_w) -> int:
        """Greedy word wrap; a word wider than the box overhangs on its own line."""
        n, used = 1, 0.0
        for text, name, size, bold in runs:
            for word in re.findall(r"\S+\s*", text):
                w = self.width(word.rstrip(), name, size, bold)
                if used and used + w > box_w * 1.02:
                    n, used = n + 1, 0.0
                used += self.width(word, name, size, bold)
        return n

    def overflow(self, num, slide) -> None:
        for shape in iter_shapes(slide.shapes):
            if not shape.has_text_frame or shape.width is None or shape.height is None:
                continue
            tf = shape.text_frame
            if not tf.text.strip():
                continue
            box_w = Emu(shape.width - (tf.margin_left or 0) - (tf.margin_right or 0)).inches
            box_h = Emu(shape.height - (tf.margin_top or 0) - (tf.margin_bottom or 0)).inches
            if box_w <= 0 or box_h <= 0:
                continue
            paras = self.runs(tf)
            if tf.word_wrap is False:  # wrap="none": the risk is sideways
                widest = max((sum(self.width(*r) for r in runs) for _, runs, _ in paras), default=0)
                # ponytail: 25% slack calibrated on one exemplar deck; recalibrate on more decks.
                if widest > box_w * 1.25:
                    self.add(
                        "WARN",
                        num,
                        shape.shape_id,
                        "overflow",
                        f"runs {widest:.2f}in wide in a non-wrapping box of {box_w:.2f}in: "
                        f"{_snippet(tf.text)!r}",
                    )
                continue
            total, count = 0.0, 0
            for para, runs, end_size in paras:
                size = max((s for _, _, s, _ in runs), default=end_size)
                spacing = para.line_spacing if isinstance(para.line_spacing, float) else None
                line_h = size * (spacing or LINE_FACTOR) / 72
                k = self.lines(runs, box_w) if any(t for t, *_ in runs) else 1
                total += line_h * k
                count += k
            # One line cannot overflow downwards (boxes are sized to the glyphs); 10% slack for
            # ascent/descent trimming.
            if count > 1 and total > box_h * 1.1 + 0.02:
                self.add(
                    "WARN",
                    num,
                    shape.shape_id,
                    "overflow",
                    f"needs ~{total:.2f}in of height in a {box_h:.2f}in box: {_snippet(tf.text)!r}",
                )


def lint(
    pptx_path: str | Path,
    pack: Pack,
    language: str | None = None,
    template_map: dict[int, int] | None = None,
    exempt_closing_slides: set[int] | None = None,
    template: bool = False,
) -> list[Finding]:
    """Lint a deck against `pack`.

    template_map: 1-based slide position -> source template slide number (the values of
        `BuildReport.slides`). Gives the template's page-number shape ids and which slides were
        cloned from the `closing` role, whose text is exempt from the slop rules (the pack's
        signature line).
    exempt_closing_slides: positions to treat as `closing` clones when no map is at hand.
    template: lint the template itself: placeholders, gaps and slop are its job, skip them;
        off-palette construction guides (connectors) are tolerated.
    """
    closing = set(exempt_closing_slides or ())
    roles = set(pack.slides_for("closing"))
    if template_map:
        closing |= {pos for pos, n in template_map.items() if n in roles}
    if template:
        closing |= roles
    prs = Presentation(str(pptx_path))
    if not template_map and not template:
        closing |= _unchanged_closings(prs, pack, roles)
    lt = _Linter(pack, language, template_map, closing, template)
    lt.theme(pptx_path)
    w, h = Emu(prs.slide_width).inches, Emu(prs.slide_height).inches
    for i, slide in enumerate(prs.slides, start=1):
        lt.slide(i, slide, w, h)
    return lt.out


def _texts(shapes) -> list[str]:
    out = []
    for sh in shapes:
        if sh.shape_type == 6:
            out += _texts(sh.shapes)
        elif sh.has_text_frame and sh.text_frame.text.strip():
            out.append(" ".join(sh.text_frame.text.split()))
    return out


def _unchanged_closings(prs, pack: Pack, roles: set[int]) -> set[int]:
    """Without a build map: a slide whose text is exactly a `closing` template slide's text is
    that signature clone (its line is the pack's own, exempt from slop)."""
    tmpl = Presentation(str(pack.template))
    signatures = [sorted(_texts(tmpl.slides[n - 1].shapes)) for n in roles]
    return {
        i
        for i, slide in enumerate(prs.slides, start=1)
        if (t := sorted(_texts(slide.shapes))) and t in signatures
    }


def main_lint(pptx: str | Path, pack_dir: str | Path, language: str | None) -> int:
    """CLI hook: print findings and a summary; 1 on any ERROR."""
    findings = lint(pptx, load_pack(pack_dir), language)
    for f in findings:
        print(f)
    count = {s: sum(f.severity == s for f in findings) for s in RANK}
    print(f"--- {count['ERROR']} error(s), {count['WARN']} warning(s), {count['NOTE']} note(s)")
    return 1 if count["ERROR"] else 0
