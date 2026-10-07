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


def test_draft_manifest_makes_a_valid_pack(tmp_path):
    import json

    import yaml

    from calque_engine.extract import draft_manifest
    from calque_engine.pack import load_pack

    d = tmp_path / "p"
    d.mkdir()
    tmap = extract(make_template(d / "template.pptx"))
    manifest = draft_manifest(tmap, "p", "P")
    assert manifest["roles"] == {"cover": [1], "content": [2], "closing": [3]}
    assert tmap["slides"][0]["slots"]["title"]
    assert "Deck title" in manifest["lint"]["placeholders"]
    (d / "pack.yaml").write_text(yaml.safe_dump(manifest, allow_unicode=True))
    (d / "template-map.yaml").write_text(yaml.safe_dump(tmap, sort_keys=False))
    (d / "tokens.json").write_text(json.dumps(draft_tokens(tmap)))
    assert load_pack(d).id == "p"
