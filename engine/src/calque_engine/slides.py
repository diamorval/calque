"""Slide-level PPTX operations: duplicate, delete, reorder, find shapes, write text run by run."""

from __future__ import annotations

import io
from copy import deepcopy
from typing import Any

from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.enum.text import PP_ALIGN
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.opc.packuri import PackURI
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


# --- slides ----------------------------------------------------------------------------------


def _copy_part(part, package):
    """Deep copy of a part and the parts it owns (a chart and its embedded workbook)."""
    tmpl = str(part.partname)
    stem, ext = tmpl.rsplit(".", 1)
    base = stem.rstrip("0123456789")
    new_name = package.next_partname(f"{base}%d.{ext}")
    new = type(part).load(PackURI(new_name), part.content_type, package, part.blob)
    for rId, rel in part.rels.items():
        if rel.is_external:
            new.rels.get_or_add_ext_rel(rel.reltype, rel.target_ref)
        else:
            target = rel.target_part
            if rel.reltype == RT.PACKAGE or "embeddings" in str(target.partname):
                target = _copy_part(target, package)
            new.rels._rels[rId] = type(rel)(
                new.rels._base_uri, rId, rel.reltype, rel._target_mode, target
            )
    return new


def duplicate_slide(prs, src):
    """Append a copy of `src` (same layout, shapes, background, images, charts)."""
    new = prs.slides.add_slide(src.slide_layout)
    sld = new._element
    # python-pptx caches the spTree element behind `slide.shapes`: refill it, don't replace it.
    tree = sld.cSld.spTree
    for child in list(tree):
        tree.remove(child)
    for child in src._element.cSld.spTree:
        tree.append(deepcopy(child))
    for child in list(sld.cSld):
        if child is not tree:
            sld.cSld.remove(child)
    for child in src._element.cSld:
        if child.tag != tree.tag:
            # bg comes before spTree, extLst after it
            (tree.addprevious if child.tag.endswith("}bg") else sld.cSld.append)(deepcopy(child))
    for child in list(sld):
        if child is not sld.cSld:
            sld.remove(child)
    for child in src._element:
        if child.tag != sld.cSld.tag:
            sld.append(deepcopy(child))
    for k, v in src._element.attrib.items():
        sld.set(k, v)

    remap: dict[str, str] = {}
    for rId, rel in src.part.rels.items():
        if rel.reltype in (RT.SLIDE_LAYOUT, RT.NOTES_SLIDE):
            continue
        if rel.is_external:
            remap[rId] = new.part.rels.get_or_add_ext_rel(rel.reltype, rel.target_ref)
            continue
        target = rel.target_part
        if rel.reltype == RT.CHART:
            target = _copy_part(target, new.part.package)
        remap[rId] = new.part.rels.get_or_add(rel.reltype, target)
    for el in sld.iter():
        for k, v in el.attrib.items():
            if k.startswith(f"{{{R_NS}}}") and v in remap:
                el.set(k, remap[v])
    return new


def delete_slide(prs, slide) -> None:
    lst = prs.slides._sldIdLst
    for sldId in list(lst):
        if prs.part.related_part(sldId.rId) is slide.part:
            prs.part.drop_rel(sldId.rId)
            lst.remove(sldId)
            return
    raise KeyError("slide not in presentation")


def keep_only(prs, slides: list) -> None:
    """Keep exactly `slides`, in that order; every other slide is dropped from the package."""
    keep = {id(s.part) for s in slides}
    for s in list(prs.slides):
        if id(s.part) not in keep:
            delete_slide(prs, s)
    lst = prs.slides._sldIdLst
    by_part = {id(prs.part.related_part(e.rId)): e for e in lst}
    for e in list(lst):
        lst.remove(e)
    for s in slides:
        lst.append(by_part[id(s.part)])


# --- shapes ----------------------------------------------------------------------------------


def iter_shapes(shapes):
    for sh in shapes:
        yield sh
        if sh.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from iter_shapes(sh.shapes)


def shape_by_id(slide, shape_id: int):
    for sh in iter_shapes(slide.shapes):
        if sh.shape_id == shape_id:
            return sh
    raise KeyError(f"shape_id {shape_id} not found on slide")


def delete_shape(shape) -> None:
    el = shape._element
    el.getparent().remove(el)


# --- text ------------------------------------------------------------------------------------


def _set_para(para, text: str):
    """Write one paragraph keeping its first run's formatting. `\\n` becomes `<a:br/>` inside the
    paragraph (never a literal vertical tab: OOXML escapes it to visible junk)."""
    runs = para.runs
    if not runs:
        para.text = text.replace("\n", " ")
        return para.runs[0].font if para.runs else None
    for br in para._p.findall(qn("a:br")):
        para._p.remove(br)
    segs = text.split("\n")
    runs[0].text = segs[0]
    for r in runs[1:]:
        r._r.getparent().remove(r._r)
    r0 = runs[0]._r
    for extra in reversed(segs[1:]):
        new_r = deepcopy(r0)
        new_r.find(qn("a:t")).text = extra
        r0.addnext(new_r)
        r0.addnext(r0.makeelement(qn("a:br"), {}))
    return runs[0].font


def set_text(
    shape,
    lines: str | list[str],
    color: RGBColor | None = None,
    bold: bool | None = None,
    size: float | None = None,
) -> None:
    """Replace a shape's text run by run, keeping fonts and sizes. A list = one paragraph each."""
    if isinstance(lines, str):
        lines = [lines]
    tf = shape.text_frame
    paras = tf.paragraphs
    while len(paras) < len(lines):
        paras[-1]._p.addnext(deepcopy(paras[-1]._p))
        paras = tf.paragraphs
    for extra in paras[len(lines) :]:
        extra._p.getparent().remove(extra._p)
    for para, line in zip(tf.paragraphs, lines, strict=True):
        f = _set_para(para, line)
        for r in para.runs:
            if color is not None:
                r.font.color.rgb = color
            if bold is not None:
                r.font.bold = bold
            if size is not None:
                r.font.size = Pt(size)
        if f is None:
            continue


def shape_text(shape) -> str:
    return shape.text_frame.text if shape.has_text_frame else ""


def fit_box(shape, style, pad: float = 0.07, shrink: bool = False) -> None:
    """Grow a label box's width so its text stays on one line, keeping an edge that sits on a
    vertical grid rule, otherwise growing from its alignment side."""
    tf = shape.text_frame
    widest = 0.0
    for para in tf.paragraphs:
        widest = max(
            widest,
            sum(
                style.text_width(
                    r.text, r.font.name, r.font.size.pt if r.font.size else 18, bool(r.font.bold)
                )
                for r in para.runs
            ),
        )
    if widest <= 0:
        return
    tf.word_wrap = False
    margins = Emu(tf.margin_left or 0).inches + Emu(tf.margin_right or 0).inches
    new_w = widest + margins + 2 * pad
    old_w = Emu(shape.width).inches
    if not shrink:
        new_w = max(new_w, old_w)
    left = Emu(shape.left).inches
    pinned = _pinned_edge(shape, left, left + old_w)
    grow = pinned or {PP_ALIGN.CENTER: "center", PP_ALIGN.RIGHT: "right"}.get(
        tf.paragraphs[0].alignment, "left"
    )
    if grow == "center":
        left -= (new_w - old_w) / 2
    elif grow == "right":
        left -= new_w - old_w
    shape.left, shape.width = Inches(left), Inches(new_w)


def _pinned_edge(shape, left: float, right: float, tol: float = 0.02) -> str | None:
    slide = shape.part.slide
    for sh in iter_shapes(slide.shapes):
        if sh is shape or sh.width is None or sh.height is None:
            continue
        if Emu(sh.width).inches < 0.01 and Emu(sh.height).inches > 1:
            x = Emu(sh.left).inches
            if abs(right - x) <= tol:
                return "right"
            if abs(left - x) <= tol:
                return "left"
    return None


# --- pictures and tables ---------------------------------------------------------------------


def crop_to_fill(data: bytes, aspect: float) -> tuple[bytes, str]:
    """Centre-crop image bytes to `aspect` (w/h). Returns (bytes, ext)."""
    from PIL import Image

    img = Image.open(io.BytesIO(data))
    fmt = img.format if img.format in ("JPEG", "PNG") else "PNG"
    iw, ih = img.size
    if iw / ih > aspect:
        cw = round(ih * aspect)
        img = img.crop(((iw - cw) // 2, 0, (iw - cw) // 2 + cw, ih))
    elif iw / ih < aspect:
        ch = round(iw / aspect)
        img = img.crop((0, (ih - ch) // 2, iw, (ih - ch) // 2 + ch))
    if fmt == "JPEG" and img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return buf.getvalue(), fmt.lower().replace("jpeg", "jpg")


def replace_image(shape, data: bytes) -> None:
    """Swap the image of a picture (or picture-filled shape) in place, cropped to fill its frame."""
    blip = shape._element.find(".//" + qn("a:blip"))
    if blip is None:
        raise ValueError(f"shape {shape.shape_id} holds no image")
    cropped, _ = crop_to_fill(data, shape.width / shape.height)
    _, rId = shape.part.get_or_add_image_part(io.BytesIO(cropped))
    blip.set(qn("r:embed"), rId)
    src = shape._element.find(".//" + qn("a:srcRect"))
    if src is not None:
        src.getparent().remove(src)


def fill_table(shape, rows: list[list[str]]) -> None:
    table = shape.table
    for r, row in enumerate(rows[: len(table.rows)]):
        for c, val in enumerate(row[: len(table.columns)]):
            cell = table.cell(r, c)
            if cell.text_frame.paragraphs[0].runs:
                set_text(cell, val)
            else:
                cell.text = val


def apply_value(shape, value: Any, style) -> None:
    """Write one DeckSpec ShapeValue (not null) into a shape."""
    if isinstance(value, (str, list)):
        set_text(shape, value)
        return
    if "image" in value:
        replace_image(shape, _read_image(value["image"]))
    if "table" in value:
        fill_table(shape, value["table"])
    if "text" in value:
        size = value.get("size")
        set_text(
            shape,
            value["text"],
            color=style.rgb(value["color"]) if value.get("color") else None,
            bold=value.get("bold"),
            size=(style.size(size) if isinstance(size, str) else size),
        )
    elif value.get("color") and shape.has_text_frame:
        for p in shape.text_frame.paragraphs:
            for r in p.runs:
                r.font.color.rgb = style.rgb(value["color"])
    if value.get("fit"):
        fit_box(shape, style)
    if "width_frac" in value:
        shape.width = int(shape.width * value["width_frac"])


def _read_image(ref: str) -> bytes:
    with open(ref, "rb") as f:
        return f.read()
