"""DeckSpec -> PPTX. Clones the pack template's slides, writes values by shape_id, draws charts,
diagrams and compositions on the pack's `content` slide, renumbers footers. Deterministic."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pptx import Presentation
from pptx.oxml.ns import qn
from pptx.util import Emu

from . import draw as d
from . import slides as sl
from . import tags
from .deckspec import DeckSpec, Issue, Slide, resolve_clone_slide, validate
from .draw import Run
from .extract import extract
from .pack import Pack
from .placeholders import missing_markers, placeholder_hits
from .style import Style

# kind -> renderer(slide, style, spec slide). Filled by the charts / diagrams / compositions
# modules on import (see _load_renderers).
Renderer = Callable[[Any, Style, Slide], None]
RENDERERS: dict[str, Renderer] = {}


def renderer(key: str):
    """Register a renderer for `chart`, `diagram:<id>` or `composition:<id>`."""

    def deco(fn: Renderer) -> Renderer:
        RENDERERS[key] = fn
        return fn

    return deco


def _load_renderers() -> None:
    from . import charts, compositions, diagrams  # noqa: F401  (registration side effect)


@dataclass
class Hole:
    slide: str
    shape_id: int
    was: str


@dataclass
class BuildReport:
    path: Path
    warnings: list[Issue] = field(default_factory=list)
    holes: list[Hole] = field(default_factory=list)
    # spec slide id -> (output position 1-based, source slide number)
    slides: dict[str, tuple[int, int]] = field(default_factory=dict)


def _render_key(s: Slide) -> str:
    src = s.source
    if src["kind"] == "chart":
        return "chart"
    return f"{src['kind']}:{src['id']}"


def build(
    data: dict[str, Any] | DeckSpec,
    pack: Pack,
    out: str | Path,
    base: str | Path | None = None,
    check: bool = True,
    image_roots: list[str | Path] | None = None,
    author: str | None = None,
) -> BuildReport:
    """Build a deck. `base` is the imported PPTX a DeckSpec with `base` edits: its slides are
    edited in place, template clones and drawn slides are copied in from the pack template.
    `check=False` skips the doctrine rules (schema only), for internal reference builds. Image
    values are paths relative to `image_roots` (default: the pack, and the base's folder).
    `author` goes in the document properties (else they name no one)."""
    _load_renderers()
    raw = data.model_dump(exclude_none=True) if isinstance(data, DeckSpec) else data
    if check:
        deck, warnings = validate(raw, pack)
    else:
        deck, warnings = DeckSpec.model_validate(raw), []
    st = Style(pack)
    report = BuildReport(path=Path(out), warnings=list(warnings))

    if image_roots is None:
        image_roots = [pack.dir, *([Path(base).parent] if base else [])]
    prs = Presentation(str(base or pack.template))
    base_map = {s["number"]: s for s in extract(base)["slides"]} if base else {}
    pack_map = {s["number"]: s for s in pack.template_map["slides"]}
    originals = list(prs.slides)
    used: set[int] = set()
    built = []
    # the pack template's slides; a base deck opens the template only if it needs it
    tpl: list | None = None if base else originals

    def from_template(n: int):
        nonlocal tpl
        if tpl is None:
            tpl = list(Presentation(str(pack.template)).slides)
        slides = tpl
        if not 1 <= n <= len(slides):
            raise ValueError(f"slide {n} not in the pack template (1..{len(slides)})")
        return sl.duplicate_slide(prs, slides[n - 1])

    for s in deck.slides:
        src = s.source
        if src["kind"] == "clone":
            from_base = src.get("from") == "base"
            if from_base and not base:
                raise ValueError(f"[{s.id}] clones from base but the deck has no base")
            n = src["slide"] if from_base else resolve_clone_slide(s, pack)
            if from_base:
                if not 1 <= n <= len(originals):
                    raise ValueError(
                        f"[{s.id}] slide {n} not in {Path(base).name} (1..{len(originals)})"
                    )
                if n not in used:
                    # first use of an imported slide: edit it in place, so notes, animations and
                    # transitions survive untouched
                    new = originals[n - 1]
                    used.add(n)
                else:
                    new = sl.duplicate_slide(prs, originals[n - 1])
                    if originals[n - 1].has_notes_slide:
                        new.notes_slide.notes_text_frame.text = originals[
                            n - 1
                        ].notes_slide.notes_text_frame.text
                tslide = base_map[n]
            else:
                try:
                    new = from_template(n)
                except ValueError as e:
                    raise ValueError(f"[{s.id}] {e}") from None
                tslide = pack_map[n]
            _apply_clone(
                new, s, st, deck.language, report, tslide, image_roots, holes=not from_base
            )
        else:
            n = pack.slides_for("content")[0]
            new = from_template(n)
            tslide = pack_map[n]
            slots = tslide.get("slots", {})
            _prepare_content(new, s, slots, st)
            fn = RENDERERS.get(_render_key(s))
            if fn is None:
                raise NotImplementedError(f"[{s.id}] no renderer for {_render_key(s)}")
            with _source_line(new, st, slots, s.source.get("params", {}).get("source")):
                fn(new, st, s)
        if s.notes:
            new.notes_slide.notes_text_frame.text = s.notes
        tags.mark(new, s.model_dump(exclude_none=True), drawn=src["kind"] != "clone")
        built.append((s, new, n, tslide))

    sl.keep_only(prs, [b[1] for b in built])
    for pos, (s, new, n, tslide) in enumerate(built, start=1):
        report.slides[s.id] = (pos, n)
        pn = tslide.get("page_number")
        if pn is not None:
            _renumber(new, pn, pos)
    _own_properties(prs, deck.title, author)
    prs.save(str(out))
    return report


# presentation parts holding the template's edit history (who changed what, when)
HISTORY_RELS = ("/changesInfo", "/revisionInfo")


def _own_properties(prs, title: str, author: str | None) -> None:
    """The deck's document properties, not the template's: no template authors, no python-pptx
    defaults, no revision history parts (dropped with their relationship, so with their content
    type on save)."""
    core = prs.core_properties
    for child in list(core._element):
        core._element.remove(child)
    now = datetime.now(UTC).replace(tzinfo=None, microsecond=0)
    core.title = title
    core.author = author or ""
    core.last_modified_by = author or ""
    core.revision = 1
    core.created = now
    core.modified = now
    rels = prs.part.rels
    for rid in [r for r, rel in rels.items() if rel.reltype.endswith(HISTORY_RELS)]:
        rels.pop(rid)


def _apply_clone(
    slide,
    s: Slide,
    st: Style,
    language: str,
    report: BuildReport,
    tslide: dict[str, Any],
    image_roots: list[str | Path],
    holes: bool = True,
) -> None:
    values: dict[str, Any] = s.source.get("values", {})
    fit = set(tslide.get("fit", []))
    for key, value in values.items():
        shape = sl.shape_by_id(slide, int(key))
        if value is None:
            sl.delete_shape(shape)
            continue
        sl.apply_value(shape, value, st, image_roots)
        if int(key) in fit and not (isinstance(value, dict) and "fit" in value):
            sl.fit_box(shape, st)
    if holes:
        _fill_holes(slide, s, st, language, report, set(map(int, values)))


def _fill_holes(slide, s: Slide, st: Style, language: str, report: BuildReport, done: set[int]):
    """Unfilled placeholder text becomes the pack's missing-value marker, in the deck language."""
    marker = st.missing(language)
    markers = missing_markers(st.pack)
    for shape in sl.iter_shapes(slide.shapes):
        if shape.shape_id in done or not shape.has_text_frame:
            continue
        text = shape.text_frame.text
        if text.strip() in markers or not placeholder_hits(text, st.pack):
            continue
        report.holes.append(Hole(s.id, shape.shape_id, text.strip()))
        sl.set_text(shape, marker)


def _prepare_content(slide, s: Slide, slots: dict[str, int], st: Style) -> None:
    """The content slide is the canvas: verdict in the title slot, body slot removed."""
    if "title" not in slots:
        raise KeyError(f"pack {st.pack.id!r}: its content slide declares no `title` slot")
    sl.set_text(sl.shape_by_id(slide, slots["title"]), s.title or s.message)
    for name in ("body",):
        if name in slots:
            sl.delete_shape(sl.shape_by_id(slide, slots[name]))
    if "eyebrow" in slots:
        eb = sl.shape_by_id(slide, slots["eyebrow"])
        if s.eyebrow:
            sl.set_text(eb, s.eyebrow)
        else:
            sl.delete_shape(eb)


SOURCE_NAME = "Source"  # shape name of the source line; lint looks for it
SOURCE_GAP_IN = 0.08  # between the drawing and the source line under it


@contextmanager
def _source_line(slide, st: Style, slots: dict[str, int], text: str | None) -> Iterator[None]:
    """The line saying where a slide's figures come from. It goes in the content slide's `source`
    slot when the pack maps one, else at `grid.source` (pack.yaml), else on the last caption line
    above the footer line. The drawing rendered inside the block stops short of it."""
    slot = sl.shape_by_id(slide, slots["source"]) if "source" in slots else None
    if not text:
        if slot is not None:
            sl.delete_shape(slot)
        yield
        return
    g = st.grid
    if slot is not None:
        sl.set_text(slot, text)
        shape, top = slot, Emu(slot.top).inches
    else:
        h = st.size("caption") * 1.4 / 72
        pos = st.pack.manifest["grid"].get("source") or {}
        top = pos.get("top_in", g.bottom - h)
        left = pos.get("left_in", g.margin)
        width = pos.get("width_in", g.width - g.margin - left)
        run = Run(text, size="caption", color="muted")
        shape = d.add_text(slide, st, left, top, width, h, run, anchor="bottom")
    shape.name = SOURCE_NAME
    bottom = g.bottom
    if top < bottom:
        g.bottom = top - SOURCE_GAP_IN
    try:
        yield
    finally:
        g.bottom = bottom


# One GUID for every slide number field, as PowerPoint writes them.
SLIDENUM_ID = "{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}"


def _renumber(slide, shape_id: int, pos: int) -> None:
    """Make the page number a slidenum field (its cached text is `pos`), so it stays right when
    slides are reordered in PowerPoint."""
    try:
        shape = sl.shape_by_id(slide, shape_id)
    except KeyError:
        return  # the spec deleted it
    if not shape.has_text_frame:
        return
    fld = shape._element.find(".//" + qn("a:fld"))
    if fld is not None:  # already a field: PowerPoint computes it, refresh its cached text
        t = fld.find(qn("a:t"))
        if fld.get("type") == "slidenum" and t is not None:
            t.text = str(pos)
        return
    sl.set_text(shape, str(pos))
    r = shape.text_frame.paragraphs[0].runs[0]._r
    fld = r.makeelement(qn("a:fld"), {"id": SLIDENUM_ID, "type": "slidenum"})
    fld.extend(list(r))  # a:rPr then a:t, the order a:fld wants
    r.addprevious(fld)
    r.getparent().remove(r)
