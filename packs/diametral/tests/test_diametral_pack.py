"""Pack-specific checks. Brand values are allowed here, never in engine/ or core/."""

import re
from pathlib import Path

from calque_engine.extract import extract
from calque_engine.pack import load_pack

PACK = Path(__file__).resolve().parents[1]
# The reference map says "1149–1162 (13 shapes)": a 14-id range, 1154 does not exist.
KNOWN_DOC_GAPS = {(35, 1154)}


def documented_ids(md: str):
    """(slide range, id) for every shape id cited in bold in the plugin's template-map.md."""
    for sec in re.split(r"\n### ", md)[1:]:
        sec = sec.split("\n## ")[0]
        m = re.match(r"s(\d+)(?:[–-]s(\d+))?", sec)
        if not m:
            continue
        slides = range(int(m.group(1)), int(m.group(2) or m.group(1)) + 1)
        for span in re.findall(r"\*\*(.+?)\*\*(?!\s*pt)", sec):
            if span.startswith("s") or re.search(r"pt|in\b|×|\.\d|[A-Za-z]{3,}", span):
                continue
            for lo, hi in re.findall(r"(\d+)(?:[–-](\d+))?", span):
                for i in range(int(lo), int(hi or lo) + 1):
                    yield slides, i


def all_ids(shapes):
    for s in shapes:
        yield s["id"]
        yield from all_ids(s.get("children", []))


def test_pack_loads():
    pack = load_pack(PACK)
    assert pack.color("highlight") == "FF2A00"
    assert pack.font("display") == "Ufficio 300"
    assert pack.slides_for("closing") == [57]


def test_extraction_finds_documented_shape_ids():
    tmap = extract(PACK / "template.pptx")
    have = {s["number"]: set(all_ids(s["shapes"])) for s in tmap["slides"]}
    cited = list(documented_ids((PACK / "reference" / "template-map.md").read_text()))
    assert len(cited) > 400
    missing = [
        (slides[0], i)
        for slides, i in cited
        if not any(i in have[n] for n in slides) and (slides[0], i) not in KNOWN_DOC_GAPS
    ]
    assert missing == []


def test_page_number_and_canvas():
    tmap = extract(PACK / "template.pptx")
    assert tmap["canvas"] == {"width_in": 10.0, "height_in": 5.62}
    by_n = {s["number"]: s for s in tmap["slides"]}
    assert by_n[1]["page_number"] is None and by_n[57]["page_number"] is None
    assert by_n[11]["page_number"] == 4
