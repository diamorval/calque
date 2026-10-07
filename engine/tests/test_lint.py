"""Generic lint checks, run on every pack in packs/: the template lints clean, and each fault
injected into a cleanly built deck is caught by the right check."""

from pathlib import Path

import pytest
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.util import Inches, Pt

from calque_engine.build import build
from calque_engine.lint import lint
from calque_engine.pack import load_pack

REPO = Path(__file__).resolve().parents[2]
PACKS = sorted(p.parent for p in (REPO / "packs").glob("*/pack.yaml"))
POS = 2  # the content slide of the clean deck


def errors(findings):
    return [str(f) for f in findings if f.severity == "ERROR"]


@pytest.fixture(scope="module", params=PACKS, ids=lambda p: p.name)
def clean(request, tmp_path_factory):
    """(pack, path, slide position -> template slide) of a small deck built from the pack."""
    pack = load_pack(request.param)
    slots = {s["number"]: s.get("slots", {}) for s in pack.template_map["slides"]}

    def clone(sid, form, mtype, role, title):
        slot = slots[pack.slides_for(role)[0]].get("title")
        values = {str(slot): title} if slot else {}
        src = {"kind": "clone", "role": role, "values": values}
        return {"id": sid, "message": title, "message_type": mtype, "form": form, "source": src}

    spec = {
        "pack_id": pack.id,
        "language": "en",
        "title": "Review",
        "slides": [
            clone("s1", "cover", "cover", "cover", "Quarterly review"),
            clone("s2", "content", "narrative", "content", "Margins rose in three plants"),
            clone("s3", "closing", "closing", "closing", "Closing"),
        ],
    }
    out = tmp_path_factory.mktemp(pack.id) / "clean.pptx"
    report = build(spec, pack, out)
    return pack, out, dict(report.slides.values())


def test_template_lints_clean(clean):
    pack = clean[0]
    assert errors(lint(pack.template, pack, template=True)) == []


def test_clean_deck_has_no_error(clean):
    pack, path, tmap = clean
    assert errors(lint(path, pack, "en", tmap)) == []


def _box(slide, pack, left, top, width, height, text, size=None):
    tb = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
    tb.text_frame.word_wrap = True
    run = tb.text_frame.paragraphs[0].add_run()
    run.text = text
    run.font.name = pack.font("body")
    if size:
        run.font.size = Pt(size)
    return run


def _off_palette(pack):
    return next(h for h in (f"{i:02X}" * 3 for i in range(1, 255)) if h not in pack.palette())


def f_palette(s, pack, w, h):
    _box(s, pack, 1, 2, 3, 0.4, "colour").font.color.rgb = RGBColor.from_string(_off_palette(pack))


def f_font(s, pack, w, h):
    _box(s, pack, 1, 2, 3, 0.4, "face").font.name = "Nonexistent Sans"


def f_single_use(s, pack, w, h):
    paths = pack.manifest["lint"].get("single_use_colors")
    if not paths:
        pytest.skip("pack declares no single-use colour")
    for left in (1, 4):
        _box(s, pack, left, 2, 1, 0.4, "active").font.color.rgb = RGBColor.from_string(
            pack.color_at(paths[0])
        )


def f_placeholder(s, pack, w, h):
    _box(s, pack, 1, 2, 4, 0.4, pack.manifest["lint"]["placeholders"][0])


def f_page_number(s, pack, w, h):
    _box(s, pack, w * 0.92, h * 0.92, 0.4, 0.3, "9")


def f_off_canvas(s, pack, w, h):
    _box(s, pack, w - 0.5, 2, 2, 0.4, "outside")


def f_footer_band(s, pack, w, h):
    _box(s, pack, 1, pack.manifest["grid"]["footer_top_in"] + 0.1, 2, 0.05, "low")


def f_slop(s, pack, w, h):
    _box(s, pack, 1, 2, 6, 0.6, "In today's fast-paced world, margins rose")


def f_overflow(s, pack, w, h):
    _box(s, pack, 1, 2, 1, 0.3, "A sentence far too long for this narrow box to hold.", 14)


def f_notes(s, pack, w, h):
    s.notes_slide.notes_text_frame.text = "Let's dive in."


FAULTS = {
    "palette": f_palette,
    "font": f_font,
    "single-use": f_single_use,
    "placeholder": f_placeholder,
    "page-number": f_page_number,
    "off-canvas": f_off_canvas,
    "footer-band": f_footer_band,
    "slop": f_slop,
    "overflow": f_overflow,
    "notes": f_notes,
}


@pytest.mark.parametrize("fault", FAULTS)
def test_fault_detected(clean, fault, tmp_path):
    pack, path, tmap = clean
    prs = Presentation(str(path))
    w, h = prs.slide_width / 914400, prs.slide_height / 914400
    FAULTS[fault](prs.slides[POS - 1], pack, w, h)
    bad = tmp_path / f"{fault}.pptx"
    prs.save(str(bad))
    found = lint(bad, pack, "en", tmap)
    before = {(f.check, f.severity) for f in lint(path, pack, "en", tmap) if f.slide == POS}
    new = {(f.check, f.severity) for f in found if f.slide == POS} - before
    expected = ("slop", "NOTE") if fault == "notes" else (fault, None)
    assert any(c == expected[0] and expected[1] in (None, s) for c, s in new), found
