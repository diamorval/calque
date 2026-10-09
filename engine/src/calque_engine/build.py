"""DeckSpec -> PPTX. Clones the pack template's slides, writes values by shape_id, draws charts,
diagrams and compositions on the pack's `content` slide, renumbers footers. Deterministic."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pptx import Presentation

from . import slides as sl
from .deckspec import DeckSpec, Issue, Slide, resolve_clone_slide, validate
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
    image_roots: list[str | Path] | None = None,
) -> BuildReport:
    """Build a deck. `base` is the imported PPTX a DeckSpec with `base` edits. Image values are
    paths relative to `image_roots` (default: the pack, and the base's folder)."""
    _load_renderers()
    raw = data.model_dump(exclude_none=True) if isinstance(data, DeckSpec) else data
    deck, warnings = validate(raw, pack)
    st = Style(pack)
    report = BuildReport(path=Path(out), warnings=list(warnings))

    template = Path(base) if base else pack.template
    if image_roots is None:
        image_roots = [pack.dir, *([template.parent] if base else [])]
    prs = Presentation(str(template))
    tmap = extract(template) if base else pack.template_map
    tmap_by_n = {s["number"]: s for s in tmap["slides"]}
    originals = list(prs.slides)
    used: set[int] = set()
    built = []

    for s in deck.slides:
        src = s.source
        if src["kind"] == "clone":
            from_base = src.get("from") == "base"
            if from_base and not base:
                raise ValueError(f"[{s.id}] clones from base but the deck has no base")
            n = src["slide"] if from_base else resolve_clone_slide(s, pack)
            if not 1 <= n <= len(originals):
                raise ValueError(f"[{s.id}] slide {n} not in {template.name} (1..{len(originals)})")
            if from_base and n not in used:
                # first use of an imported slide: edit it in place, so notes, animations and
                # transitions survive untouched
                new = originals[n - 1]
                used.add(n)
            else:
                new = sl.duplicate_slide(prs, originals[n - 1])
                if from_base and originals[n - 1].has_notes_slide:
                    new.notes_slide.notes_text_frame.text = originals[
                        n - 1
                    ].notes_slide.notes_text_frame.text
            _apply_clone(
                new, s, st, deck.language, report, tmap_by_n[n], image_roots, holes=not from_base
            )
        else:
            if base:
                raise ValueError(f"[{s.id}] drawn slides cannot be added to an imported deck yet")
            n = pack.slides_for("content")[0]
            new = sl.duplicate_slide(prs, originals[n - 1])
            _prepare_content(new, s, tmap_by_n[n].get("slots", {}), st)
            fn = RENDERERS.get(_render_key(s))
            if fn is None:
                raise NotImplementedError(f"[{s.id}] no renderer for {_render_key(s)}")
            fn(new, st, s)
        if s.notes:
            new.notes_slide.notes_text_frame.text = s.notes
        built.append((s, new, n))

    sl.keep_only(prs, [b[1] for b in built])
    for pos, (s, new, n) in enumerate(built, start=1):
        report.slides[s.id] = (pos, n)
        pn = tmap_by_n[n].get("page_number")
        if pn is not None:
            _renumber(new, pn, pos)
    prs.save(str(out))
    return report


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


def _renumber(slide, shape_id: int, pos: int) -> None:
    try:
        shape = sl.shape_by_id(slide, shape_id)
    except KeyError:
        return  # the spec deleted it
    from pptx.oxml.ns import qn

    if shape._element.find(".//" + qn("a:fld")) is not None:
        return  # a slidenum field: PowerPoint computes it
    sl.set_text(shape, str(pos))
