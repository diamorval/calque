"""Template extractor: any template.pptx -> template-map + draft DTCG tokens.

Shapes are keyed by `shape_id` (the `<p:cNvPr id>`), never by name: names are copied when a
slide is duplicated and are unreliable. Reviewed keys in an existing map are preserved.
"""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path
from typing import Any

from lxml import etree
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.util import Emu

EMU_IN = 914400
NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
THEME_SLOTS = (
    "dk1",
    "lt1",
    "dk2",
    "lt2",
    *(f"accent{i}" for i in range(1, 7)),
    "hlink",
    "folHlink",
)
REVIEWED_SLIDE_KEYS = ("description", "slots", "fit", "notes")


def _in(v: int | Emu | None) -> float:
    return round((v or 0) / EMU_IN, 2)


def theme(prs) -> dict[str, Any]:
    part = prs.slide_master.part.part_related_by(
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"
    )
    root = etree.fromstring(part.blob)
    colors = {}
    for slot in THEME_SLOTS:
        el = root.find(f".//a:clrScheme/a:{slot}", NS)
        if el is None or not len(el):
            continue
        c = el[0]
        # sysClr carries a system name in val; the resolved colour is lastClr
        value = c.get("lastClr") if c.tag.endswith("}sysClr") else c.get("val")
        colors[slot] = (value or "").upper()
    fonts = {}
    for key, tag in (("major", "majorFont"), ("minor", "minorFont")):
        latin = root.find(f".//a:fontScheme/a:{tag}/a:latin", NS)
        if latin is not None:
            fonts[key] = latin.get("typeface")
    return {"colors": colors, "fonts": fonts}


def shape_kind(sh) -> str:
    st = sh.shape_type
    if st == MSO_SHAPE_TYPE.GROUP:
        return "group"
    if st == MSO_SHAPE_TYPE.PICTURE:
        return "picture"
    if getattr(sh, "has_table", False) and sh.has_table:
        return "table"
    if getattr(sh, "has_chart", False) and sh.has_chart:
        return "chart"
    if st == MSO_SHAPE_TYPE.LINE or sh.element.tag.endswith("}cxnSp"):
        return "line"
    if sh.has_text_frame and sh.text_frame.text.strip():
        return "text"
    return "shape"


def _first_run_style(sh) -> tuple[str | None, float | None]:
    for p in sh.text_frame.paragraphs:
        for r in p.runs:
            if r.text.strip():
                size = r.font.size.pt if r.font.size else None
                return r.font.name, size
    return None, None


def capacity(width_in: float, height_in: float, size_pt: float) -> dict[str, int]:
    # ponytail: average glyph ~0.5 em, line ~1.2 em; lint does real glyph metrics in Phase 2.
    chars = max(1, int(width_in * 72 / (size_pt * 0.5)))
    lines = max(1, round(height_in * 72 / (size_pt * 1.2)))
    return {"chars_per_line": chars, "lines": lines}


def is_page_number(sh, w_in: float, h_in: float) -> bool:
    if not sh.has_text_frame:
        return False
    if sh.element.find(".//a:fld[@type='slidenum']", NS) is not None:
        return True
    text = sh.text_frame.text.strip()
    return (
        bool(re.fullmatch(r"\d{1,3}", text))
        and _in(sh.top) > h_in * 0.85
        and _in(sh.left) > w_in * 0.8
    )


def _shape(sh, w_in: float, h_in: float) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": sh.shape_id,
        "kind": shape_kind(sh),
        "bbox": [_in(sh.left), _in(sh.top), _in(sh.width), _in(sh.height)],
    }
    if out["kind"] == "text":
        text = sh.text_frame.text.strip()
        out["text"] = text if len(text) <= 80 else text[:77] + "..."
        font, size = _first_run_style(sh)
        if font:
            out["font"] = font
        if size:
            out["size"] = size
            out["capacity"] = capacity(out["bbox"][2], out["bbox"][3], size)
    elif out["kind"] == "table":
        out["table"] = [len(sh.table.rows), len(sh.table.columns)]
    elif out["kind"] == "group":
        out["children"] = [_shape(c, w_in, h_in) for c in sh.shapes]
    return out


def extract(template: str | Path, previous: dict[str, Any] | None = None) -> dict[str, Any]:
    prs = Presentation(str(template))
    w_in, h_in = _in(prs.slide_width), _in(prs.slide_height)
    prev = {s["number"]: s for s in (previous or {}).get("slides", [])}
    slides = []
    for i, slide in enumerate(prs.slides, start=1):
        entry: dict[str, Any] = {"number": i, "layout": slide.slide_layout.name}
        page = [sh.shape_id for sh in slide.shapes if is_page_number(sh, w_in, h_in)]
        entry["page_number"] = page[0] if page else None
        entry["shapes"] = [_shape(sh, w_in, h_in) for sh in slide.shapes]
        for key in REVIEWED_SLIDE_KEYS:
            if key in prev.get(i, {}):
                entry[key] = prev[i][key]
        slides.append(entry)
    return {
        "canvas": {"width_in": w_in, "height_in": h_in},
        "theme": theme(prs),
        "slides": slides,
    }


def _text_shapes(slides):
    for s in slides:
        stack = list(s["shapes"])
        while stack:
            sh = stack.pop()
            stack.extend(sh.get("children", []))
            if sh["kind"] == "text" and sh.get("size"):
                yield s, sh


def draft_tokens(tmap: dict[str, Any]) -> dict[str, Any]:
    """A first tokens.json from the template theme and observed type sizes. Meant for review."""
    th = tmap["theme"]
    h_in = tmap["canvas"]["height_in"]
    shapes = list(_text_shapes(tmap["slides"]))
    sizes = Counter(round(sh["size"]) for _, sh in shapes)
    body = sizes.most_common(1)[0][0] if sizes else 12
    tops = Counter(round(sh["size"]) for _, sh in shapes if sh["bbox"][1] < h_in * 0.15)
    title = tops.most_common(1)[0][0] if tops else round(body * 2)
    biggest = max(sizes) if sizes else title * 3
    cover = max((sh["size"] for s, sh in shapes if s["number"] == 1), default=title * 2)

    def color(slot: str) -> dict[str, str]:
        return {"$value": f"{{theme.{slot}}}"}

    return {
        "theme": {
            "$type": "color",
            **{slot: {"$value": f"#{hexv.lower()}"} for slot, hexv in th["colors"].items()},
            "font": {
                "$type": "fontFamily",
                **{k: {"$value": v} for k, v in th["fonts"].items()},
            },
        },
        "role": {
            "color": {
                "$type": "color",
                "ink": color("dk1"),
                "background": color("lt1"),
                "accent": color("accent1"),
                "highlight": color("accent2"),
                "muted": color("dk2"),
                "rule": color("lt2"),
                "surface": color("lt1"),
                "series": {"1": color("accent3"), "2": color("accent4"), "3": color("accent5")},
                "status": {
                    "positive": color("accent6"),
                    "warning": color("accent4"),
                    "info": color("accent5"),
                },
            },
            "font": {
                "$type": "fontFamily",
                "display": {"$value": "{theme.font.major}"},
                "body": {"$value": "{theme.font.minor}"},
                "label": {"$value": "{theme.font.minor}"},
            },
            "fontWeight": {
                "$type": "fontWeight",
                "display": {"$value": 400},
                "body": {"$value": 400},
                "label": {"$value": 400},
            },
            "size": {
                "$type": "dimension",
                **{
                    k: {"$value": f"{v}pt"}
                    for k, v in {
                        "cover_title": round(cover),
                        "divider_title": round(cover * 0.85),
                        "title": title,
                        "body": body,
                        "label": max(8, round(body * 0.75)),
                        "caption": max(8, round(body * 0.75)),
                        "numeral": round(biggest * 0.6),
                        "numeral_xl": round(biggest),
                    }.items()
                },
            },
            "stroke": {
                "$type": "dimension",
                "hairline": {"$value": "0.75pt"},
                "link": {"$value": "1pt"},
                "emphasis": {"$value": "1.5pt"},
            },
        },
    }
