"""Slide tags: the engine's marks inside the PPTX, so a deck edited in PowerPoint can come back.

PowerPoint keeps slide tags (`p:custDataLst/p:tags`, the mechanism add-ins use) through edits,
reordering, duplication and copy/paste between decks. Every built slide carries its DeckSpec slide
id; a drawn slide also carries the spec it was drawn from, so a re-import can redraw it.
"""

from __future__ import annotations

import json
from typing import Any

from lxml import etree
from pptx.opc.constants import CONTENT_TYPE as CT
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.opc.package import Part
from pptx.oxml.ns import qn

SLIDE_ID = "CALQUE_SLIDE"
SPEC = "CALQUE_SPEC"
PREFIX = "CALQUE_"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"


def _tags_el(slide):
    cdl = slide._element.cSld.find(qn("p:custDataLst"))
    return None if cdl is None else cdl.find(qn("p:tags"))


def read(slide) -> dict[str, str]:
    """Every tag of a slide (ours and other add-ins')."""
    el = _tags_el(slide)
    if el is None:
        return {}
    try:
        part = slide.part.related_part(el.get(qn("r:id")))
        root = etree.fromstring(part.blob)
    except (KeyError, etree.XMLSyntaxError):
        return {}
    return {t.get("name"): t.get("val", "") for t in root.findall(qn("p:tag"))}


def write(slide, values: dict[str, str]) -> None:
    """Set our tags on a slide, keeping other add-ins' tags. Always a fresh tags part, so a part
    shared by duplicated slides is never edited under another slide."""
    merged = {k: v for k, v in read(slide).items() if not k.upper().startswith(PREFIX)}
    merged.update(values)
    root = etree.Element(qn("p:tagLst"), nsmap={"p": P_NS})
    for k, v in merged.items():
        etree.SubElement(root, qn("p:tag"), name=k, val=v)
    package = slide.part.package
    part = Part(
        package.next_partname("/ppt/tags/tag%d.xml"),
        CT.PML_TAGS,
        package,
        etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True),
    )
    cSld = slide._element.cSld
    old = _tags_el(slide)
    if old is not None:
        rId = old.get(qn("r:id"))
        old.getparent().remove(old)
        slide.part.drop_rel(rId)
    cdl = cSld.find(qn("p:custDataLst"))
    if cdl is None:
        cdl = cSld.makeelement(qn("p:custDataLst"), {})
        # CT_CommonSlideData: bg?, spTree, custDataLst?, controls?, extLst?
        cSld.spTree.addnext(cdl)
    tags = cdl.makeelement(qn("p:tags"), {})
    tags.set(qn("r:id"), slide.part.relate_to(part, RT.TAGS))
    cdl.append(tags)


def mark(slide, spec_slide: dict[str, Any], drawn: bool) -> None:
    values = {SLIDE_ID: spec_slide["id"]}
    if drawn:
        values[SPEC] = json.dumps(spec_slide, ensure_ascii=False, separators=(",", ":"))
    write(slide, values)


def marks(slide) -> tuple[str | None, dict[str, Any] | None]:
    """(slide id, drawn spec) the engine left on a slide, or (None, None)."""
    t = read(slide)
    spec = None
    if t.get(SPEC):
        try:
            spec = json.loads(t[SPEC])
        except ValueError:
            spec = None
    if not isinstance(spec, dict):
        spec = None
    return t.get(SLIDE_ID) or None, spec
