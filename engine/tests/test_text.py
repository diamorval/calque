import zipfile
from pathlib import Path

from pptx import Presentation

from calque_engine.api import call

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
X = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'


def _text(path: Path, name: str) -> dict:
    return call({"op": "text", "path": str(path), "name": name})


def test_plain_and_unsupported(tmp_path: Path):
    f = tmp_path / "upload-1"
    f.write_text("# Brief\nNorth led growth.", encoding="utf-8")
    assert _text(f, "brief.md") == {
        "ok": True,
        "text": "# Brief\nNorth led growth.",
        "truncated": False,
    }
    r = _text(f, "scan.pdf")
    assert r["ok"] is False and "not supported yet" in r["message"]


def test_docx_xlsx_pptx(tmp_path: Path):
    docx = tmp_path / "d"
    with zipfile.ZipFile(docx, "w") as z:
        body = "<w:p><w:r><w:t>Deals close</w:t></w:r><w:r><w:t> in 4 steps.</w:t></w:r></w:p>"
        z.writestr("word/document.xml", f"<w:document {W}><w:body>{body}</w:body></w:document>")
    assert _text(docx, "notes.docx")["text"] == "Deals close in 4 steps."

    xlsx = tmp_path / "x"
    with zipfile.ZipFile(xlsx, "w") as z:
        z.writestr(
            "xl/sharedStrings.xml", f"<sst {X}><si><t>Region</t></si><si><t>North</t></si></sst>"
        )
        rows = (
            '<row><c t="s"><v>0</v></c><c><v>2024</v></c></row>'
            '<row><c t="s"><v>1</v></c><c><v>18</v></c></row>'
        )
        z.writestr(
            "xl/worksheets/sheet1.xml", f"<worksheet {X}><sheetData>{rows}</sheetData></worksheet>"
        )
    assert _text(xlsx, "figures.xlsx")["text"] == "# Sheet 1\nRegion,2024\nNorth,18"

    prs = Presentation()
    s = prs.slides.add_slide(prs.slide_layouts[0])
    s.shapes.title.text = "Old deck title"
    prs.save(tmp_path / "p")
    assert "Old deck title" in _text(tmp_path / "p", "old.pptx")["text"]
