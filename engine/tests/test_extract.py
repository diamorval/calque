from calque_engine import tokens as tk
from calque_engine.extract import capacity, draft_tokens, extract

from .conftest import make_template


def test_extract_neutral_template(tmp_path):
    tmap = extract(make_template(tmp_path / "t.pptx"))
    assert [s["number"] for s in tmap["slides"]] == [1, 2, 3]
    assert set(tmap["theme"]["colors"]) >= {"dk1", "lt1", "accent1", "hlink"}
    assert tmap["theme"]["fonts"]["major"]
    title = next(sh for sh in tmap["slides"][1]["shapes"] if sh.get("text") == "Content title")
    assert isinstance(title["id"], int) and len(title["bbox"]) == 4


def test_draft_tokens_cover_every_required_role(tmp_path):
    values = tk.resolve(draft_tokens(extract(make_template(tmp_path / "t.pptx"))))
    assert tk.missing_roles(values) == []


def test_reviewed_keys_survive_reextraction(tmp_path):
    path = make_template(tmp_path / "t.pptx")
    first = extract(path)
    first["slides"][0]["slots"] = {"title": 2}
    first["slides"][0]["description"] = "Cover"
    again = extract(path, previous=first)
    assert again["slides"][0]["slots"] == {"title": 2}
    assert again["slides"][0]["description"] == "Cover"


def test_capacity():
    assert capacity(4.0, 1.0, 12) == {"chars_per_line": 48, "lines": 5}
