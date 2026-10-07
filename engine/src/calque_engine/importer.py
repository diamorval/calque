"""import_pptx: turn an existing deck into a DeckSpec that edits it in place (`base`)."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from pptx import Presentation

from .extract import extract
from .pack import Pack
from .slides import iter_shapes


def _title(slide) -> str:
    """The slide's title placeholder, else its topmost text shape."""
    if slide.shapes.title is not None and slide.shapes.title.text_frame.text.strip():
        return slide.shapes.title.text_frame.text.strip()
    texts = [
        sh
        for sh in iter_shapes(slide.shapes)
        if sh.has_text_frame and sh.text_frame.text.strip() and sh.top is not None
    ]
    if not texts:
        return ""
    return min(texts, key=lambda sh: (sh.top, sh.left)).text_frame.text.strip()


def import_pptx(
    pptx: str | Path, pack: Pack, dest: str | Path, language: str, base_id: str = "base.pptx"
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Copy `pptx` to `dest/base_id` and return (DeckSpec, template map of the imported deck).

    Each slide becomes a `clone` from the base with no values: the deck rebuilds identical.
    Edits are then patches (values by shape_id) on that DeckSpec."""
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    base = dest / base_id
    shutil.copyfile(pptx, base)
    prs = Presentation(str(base))
    slides = []
    for n, slide in enumerate(prs.slides, start=1):
        title = " ".join(_title(slide).split())
        slides.append(
            {
                "id": f"s{n}",
                "message": title or f"Slide {n}",
                "message_type": "imported",
                "form": "imported",
                "source": {"kind": "clone", "from": "base", "slide": n, "values": {}},
            }
        )
    deck = {
        "pack_id": pack.id,
        "language": language,
        "title": slides[0]["message"] if slides else Path(pptx).stem,
        "base": base_id,
        "slides": slides,
    }
    return deck, extract(base)
