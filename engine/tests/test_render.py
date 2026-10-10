"""PPTX -> PNG per slide + shape map, incremental, for every pack."""

import re
import shutil
from pathlib import Path

import pytest
from PIL import Image

from calque_engine.api import call
from calque_engine.build import build
from calque_engine.pack import load_pack
from calque_engine.render import font_swaps, render

REPO = Path(__file__).resolve().parents[2]
PACKS = sorted((REPO / "packs").glob("*/pack.yaml"))
HAVE_TOOLS = (
    shutil.which("soffice")
    or Path("/Applications/LibreOffice.app/Contents/MacOS/soffice").is_file()
) and shutil.which("pdftoppm")

pytestmark = pytest.mark.skipif(not HAVE_TOOLS, reason="LibreOffice / pdftoppm not installed")


def _deck(pack, content_title: str) -> dict:
    slots = {s["number"]: s.get("slots", {}) for s in pack.template_map["slides"]}

    def clone(sid, role, message_type, text):
        title = slots[pack.slides_for(role)[0]].get("title")
        values = {str(title): text} if title else {}
        return {
            "id": sid,
            "message": text,
            "message_type": message_type,
            "form": role,
            "source": {"kind": "clone", "role": role, "values": values},
        }

    return {
        "pack_id": pack.id,
        "language": next(iter(pack.manifest["missing_value"])),
        "title": "Render test",
        "slides": [
            clone("cover", "cover", "cover", "A cover title"),
            clone("body", "content", "narrative", content_title),
            clone("end", "closing", "closing", "Thank you"),
        ],
    }


@pytest.mark.parametrize("manifest", PACKS, ids=lambda p: p.parent.name)
def test_render_shape_map_and_incremental(manifest, tmp_path):
    pack = load_pack(manifest.parent)
    deck = tmp_path / "deck.pptx"
    report = build(_deck(pack, "First content title"), pack, deck)
    sources = {pos: n for pos, n in report.slides.values()}

    out = tmp_path / "render"
    res = render(deck, out, pack, sources=sources)
    assert res.rendered == [1, 2, 3] and res.cached == []
    assert [p.name for p in res.pngs] == ["slide-1.png", "slide-2.png", "slide-3.png"]
    canvas = pack.template_map["canvas"]
    aspect = canvas["width_in"] / canvas["height_in"]
    for png, s in zip(res.pngs, res.slides, strict=True):
        with Image.open(png) as im:
            assert im.size == (s["width_px"], s["height_px"])
        assert s["width_px"] / s["height_px"] == pytest.approx(aspect, rel=0.01)
        for sh in s["shapes"]:
            x, y, w, h = sh["bbox_px"]
            assert 0 <= x and 0 <= y and w >= 0 and h >= 0
            assert x + w <= s["width_px"] and y + h <= s["height_px"], sh

    body = res.slides[report.slides["body"][0] - 1]
    title_id = pack.template_map["slides"][report.slides["body"][1] - 1]["slots"]["title"]
    assert {sh["shape_id"]: sh["role"] for sh in body["shapes"]}[title_id] == "title"

    build(_deck(pack, "Second content title"), pack, deck)
    res = render(deck, out, pack, sources=sources)
    assert res.rendered == [report.slides["body"][0]]
    assert res.cached == [1, 3]

    assert render(deck, out, pack, only={1}).rendered == [1]


def test_missing_pack_fonts_fall_back(neutral_pack, tmp_path):
    pack = load_pack(neutral_pack)
    assert font_swaps(pack)  # the neutral pack ships no font files
    deck = tmp_path / "deck.pptx"
    build(_deck(pack, "A title"), pack, deck)
    assert len(render(deck, tmp_path / "out", pack).pngs) == 3


def test_export_pdf_one_page_per_slide(neutral_pack, tmp_path):
    pack = load_pack(neutral_pack)
    deck = tmp_path / "deck.pptx"
    build(_deck(pack, "A title"), pack, deck)
    out = tmp_path / "x" / "deck.pdf"
    res = call({"op": "pdf", "pack": str(neutral_pack), "pptx": str(deck), "out": str(out)})
    assert res == {"ok": True, "path": str(out)}
    data = out.read_bytes()
    assert data.startswith(b"%PDF")
    assert len(re.findall(rb"/Type\s*/Page[^s]", data)) == 3
