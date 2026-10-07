"""Safe fixes for review_deck: the lint ERRORs that have one right answer, applied to a PPTX.

Fixed: theme fonts, off-pack fonts, off-palette colours (nearest palette colour), runs after
`endParaRPr`, bullets nested too deep, text off the canvas. Everything else (placeholders, slop,
overflow, page numbers, single-use colours) needs judgment or a rebuild and is left to the report.
"""

from __future__ import annotations

import re
import zipfile
from pathlib import Path
from typing import Any

from pptx import Presentation
from pptx.util import Emu

from . import tokens as tk
from .lint import DEEP_NESTING, A, _owner, _unused_default
from .pack import Pack
from .slides import iter_shapes

LATE = (f"{A}r", f"{A}br", f"{A}fld")
SAFE = ("theme", "font", "palette", "run-order", "nesting", "off-canvas")


def _rgb(h: str) -> tuple[int, int, int]:
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def nearest(hexv: str, palette: set[str]) -> str:
    r, g, b = _rgb(hexv)
    return min(
        sorted(palette),
        key=lambda p: sum((x - y) ** 2 for x, y in zip(_rgb(p), (r, g, b), strict=True)),
    )


def fix(pptx: str | Path, pack: Pack, out: str | Path) -> list[dict[str, Any]]:
    """Write `out` with every safe fix applied; return what changed (slide, shape_id, check, was,
    now). `out` may equal `pptx`."""
    fonts = {f.lower() for f in pack.fonts()}
    body = pack.font("body")
    palette = pack.palette()
    applied: list[dict[str, Any]] = []

    def log(slide, sid, check, was, now):
        applied.append({"slide": slide, "shape_id": sid, "check": check, "was": was, "now": now})

    prs = Presentation(str(pptx))
    w, h = prs.slide_width, prs.slide_height
    for num, slide in enumerate(prs.slides, start=1):
        root = slide._element
        for el in root.iter():
            face = el.get("typeface")
            if face and not face.startswith("+") and face.lower() not in fonts:
                if not _unused_default(el, "latin"):
                    log(num, _owner(el), "font", face, body)
                el.set("typeface", body)
        for el in root.iter(f"{A}srgbClr"):
            val = (el.get("val") or "").upper()
            if val not in palette:
                now = nearest(val, palette)
                if not _unused_default(el, "solidFill"):
                    log(num, _owner(el), "palette", f"#{val}", f"#{now}")
                el.set("val", now)
        for p in root.iter(f"{A}p"):
            end = p.find(f"{A}endParaRPr")
            late = [] if end is None else [e for e in end.itersiblings() if e.tag in LATE]
            if late:
                for e in late:
                    end.addprevious(e)
                log(num, _owner(p), "run-order", f"{len(late)} late run(s)", "moved before end")
        for shape in iter_shapes(slide.shapes):
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    if para.level >= DEEP_NESTING:
                        log(num, shape.shape_id, "nesting", f"level {para.level}", "level 1")
                        para.level = DEEP_NESTING - 1
            if not shape.has_text_frame or not shape.text_frame.text.strip():
                continue
            if None in (shape.left, shape.top, shape.width, shape.height):
                continue
            box = (shape.left, shape.top, shape.width, shape.height)
            width, height = min(shape.width, w), min(shape.height, h)
            left = min(max(shape.left, 0), w - width)
            top = min(max(shape.top, 0), h - height)
            if (left, top, width, height) != box:
                shape.left, shape.top, shape.width, shape.height = left, top, width, height
                log(
                    num,
                    shape.shape_id,
                    "off-canvas",
                    f"L{Emu(box[0]).inches:.2f} T{Emu(box[1]).inches:.2f}",
                    f"L{Emu(left).inches:.2f} T{Emu(top).inches:.2f}",
                )
    prs.save(str(out))
    _fix_theme(Path(out), pack, log)
    return applied


def _fix_theme(path: Path, pack: Pack, log) -> None:
    want = {
        "majorFont": tk.family(pack.tokens["theme.font.major"]),
        "minorFont": tk.family(pack.tokens["theme.font.minor"]),
    }
    fonts = {f.lower() for f in pack.fonts()}
    with zipfile.ZipFile(path) as z:
        items = [(i, z.read(i.filename)) for i in z.infolist()]
    changed = False
    for k, (info, data) in enumerate(items):
        if not re.match(r"ppt/theme/theme\d+\.xml$", info.filename):
            continue
        xml = data.decode("utf-8")
        for slot, face in want.items():
            m = re.search(rf'<a:{slot}><a:latin typeface="([^"]*)"', xml)
            if m and m.group(1).lower() not in fonts:
                xml = xml[: m.start(1)] + face + xml[m.end(1) :]
                log(None, None, "theme", f"{info.filename} {slot} {m.group(1)!r}", face)
                changed = True
        items[k] = (info, xml.encode("utf-8"))
    if changed:
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            for info, data in items:
                z.writestr(info, data)
