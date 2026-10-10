import zipfile
from pathlib import Path

from pptx import Presentation
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

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
    r = _text(f, "scan.key")
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


def _pdf(path: Path, pages: list[str]) -> None:
    """A PDF whose pages each draw one line of text in a standard font."""
    w = PdfWriter()
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    for line in pages:
        page = w.add_blank_page(width=300, height=200)
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): w._add_object(font)})}
        )
        stream = DecodedStreamObject()
        stream.set_data(f"BT /F1 12 Tf 20 100 Td ({line}) Tj ET".encode() if line else b"")
        page[NameObject("/Contents")] = w._add_object(stream)
    with open(path, "wb") as f:
        w.write(f)


def test_pdf(tmp_path: Path):
    _pdf(tmp_path / "f", ["Revenue grew 12% in 2024.", "", "North led growth."])
    r = _text(tmp_path / "f", "report.pdf")
    assert r == {
        "ok": True,
        "text": "# Page 1\nRevenue grew 12% in 2024.\n# Page 2\n# Page 3\nNorth led growth.",
        "truncated": False,
    }
    cut = call({"op": "text", "path": str(tmp_path / "f"), "name": "report.pdf", "limit": 10})
    assert cut["text"] == "# Page 1\nR" and cut["truncated"] is True

    (tmp_path / "bad").write_bytes(b"%PDF-1.7 not really")
    r = _text(tmp_path / "bad", "broken.pdf")
    assert r["ok"] is False and r["error"] == "ValueError"
