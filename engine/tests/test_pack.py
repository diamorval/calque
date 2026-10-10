import json
from pathlib import Path

import pytest
import yaml

from calque_engine.api import call
from calque_engine.lint import _rules
from calque_engine.pack import PackError, load_pack


def test_neutral_pack_loads(neutral_pack):
    pack = load_pack(neutral_pack)
    assert pack.id == "neutral"
    assert pack.slides_for("cover") == [1]
    assert len(pack.color("accent")) == 6
    assert pack.font("display")


def test_empty_dir_lists_every_missing_file(tmp_path):
    with pytest.raises(PackError) as e:
        load_pack(tmp_path)
    assert e.value.problems == [
        "missing file: pack.yaml",
        "missing file: template.pptx",
        "missing file: template-map.yaml",
        "missing file: tokens.json",
    ]


def test_incomplete_pack_lists_what_is_missing(neutral_pack):
    manifest = yaml.safe_load((neutral_pack / "pack.yaml").read_text())
    del manifest["roles"]["cover"]
    del manifest["grid"]
    manifest["roles"]["closing"] = [99]
    manifest["docs"] = {"voice": "voice.md"}
    (neutral_pack / "pack.yaml").write_text(yaml.safe_dump(manifest))
    tokens = json.loads((neutral_pack / "tokens.json").read_text())
    del tokens["role"]["color"]["highlight"]
    (neutral_pack / "tokens.json").write_text(json.dumps(tokens))

    with pytest.raises(PackError) as e:
        load_pack(neutral_pack)
    problems = "\n".join(e.value.problems)
    assert "'grid' is a required property" in problems
    assert "'cover' is a required property" in problems
    assert "missing role role.color.highlight" in problems
    assert "roles.closing: slide 99 not in template (1..3)" in problems
    assert "docs.voice: missing file voice.md" in problems


def test_role_slide_in_never_clone_is_refused(neutral_pack):
    manifest = yaml.safe_load((neutral_pack / "pack.yaml").read_text())
    manifest["never_clone"] = [2]
    (neutral_pack / "pack.yaml").write_text(yaml.safe_dump(manifest))
    with pytest.raises(PackError, match="roles.content: slide 2 is in never_clone"):
        load_pack(neutral_pack)


def test_slop_rule_that_does_not_compile_is_refused(neutral_pack):
    manifest = yaml.safe_load((neutral_pack / "pack.yaml").read_text())
    ok = {"severity": "WARN", "lang": "any", "pattern": "(?-i:ACME)", "note": "fine"}
    bad = {"severity": "ERROR", "lang": "en", "pattern": "(unclosed", "note": "broken"}
    manifest["lint"] = {"slop_rules": [ok, bad]}
    (neutral_pack / "pack.yaml").write_text(yaml.safe_dump(manifest))
    with pytest.raises(PackError) as e:
        load_pack(neutral_pack)
    assert e.value.problems == [
        "lint.slop_rules[1] pattern '(unclosed': missing ), unterminated subpattern at position 0"
    ]


@pytest.mark.parametrize("approval", [True, False, ["external", "marketing"]])
def test_approval_on_every_deck_or_per_deck_type(neutral_pack, approval):
    manifest = yaml.safe_load((neutral_pack / "pack.yaml").read_text())
    manifest["approval"] = approval
    manifest["deck_kinds"] = ["internal", "external", "pitch"]
    (neutral_pack / "pack.yaml").write_text(yaml.safe_dump(manifest))
    assert load_pack(neutral_pack).id == "neutral"


def test_approval_deck_types_are_ids(neutral_pack):
    manifest = yaml.safe_load((neutral_pack / "pack.yaml").read_text())
    manifest["approval"] = ["External decks"]
    (neutral_pack / "pack.yaml").write_text(yaml.safe_dump(manifest))
    with pytest.raises(PackError, match="approval"):
        load_pack(neutral_pack)


def _subsidiary(parent: Path, root: Path, pid: str = "sub", **manifest) -> Path:
    """A copy of `parent` under `root` as pack `pid`, extending `parent`, without its docs."""
    d = root / pid
    d.mkdir(parents=True)
    for f in ("template.pptx", "template-map.yaml", "tokens.json"):
        (d / f).write_bytes((parent / f).read_bytes())
    m = yaml.safe_load((parent / "pack.yaml").read_text())
    m.update({"id": pid, "name": pid.title(), "extends": parent.name, "lint": {}}, **manifest)
    m.pop("docs", None)
    (d / "pack.yaml").write_text(yaml.safe_dump(m))
    return d


@pytest.fixture
def group(neutral_pack):
    """The neutral pack as a group pack: voice, storyline, exemplar (with images), a slop rule."""
    for name in ("voice", "storyline", "exemplar"):
        (neutral_pack / f"{name}.md").write_text(f"group {name}\n")
    (neutral_pack / "exemplar").mkdir()
    (neutral_pack / "exemplar" / "page.png").write_bytes(b"png")
    m = yaml.safe_load((neutral_pack / "pack.yaml").read_text())
    rule = {"severity": "ERROR", "lang": "any", "pattern": "zorglub", "note": "group banned word"}
    m["lint"] = {"slop_rules": [rule]}
    (neutral_pack / "pack.yaml").write_text(yaml.safe_dump(m))
    return neutral_pack


def test_subsidiary_inherits_docs_and_slop_rules(group):
    sub = _subsidiary(group, group.parent)
    (sub / "voice.md").write_text("subsidiary voice\n")
    pack = load_pack(sub)
    assert pack.parent is not None and pack.parent.id == "neutral"
    assert pack.docs["voice"] == sub / "voice.md"  # its own
    assert pack.docs["storyline"] == group / "storyline.md"  # inherited
    assert pack.docs["exemplar"] == group / "exemplar.md"
    assert pack.exemplar_dir == group / "exemplar"
    assert [r["note"] for r in pack.manifest["lint"]["slop_rules"]] == ["group banned word"]
    assert pack.template == sub / "template.pptx"  # template and tokens stay its own
    assert "group banned word" in [r.note for r in _rules(pack, "en")]


def test_subsidiary_overrides_slop_rules_and_exemplar(group):
    own = [{"severity": "WARN", "lang": "en", "pattern": "synergy", "note": "own rule"}]
    sub = _subsidiary(group, group.parent, lint={"slop_rules": own})
    (sub / "exemplar.md").write_text("own exemplar\n")
    pack = load_pack(sub)
    assert pack.manifest["lint"]["slop_rules"] == own
    assert pack.docs["exemplar"] == sub / "exemplar.md"
    assert pack.exemplar_dir is None  # its own exemplar has no images: none inherited


def test_extends_resolves_through_the_request_and_reports_problems(group, tmp_path):
    elsewhere = _subsidiary(group, tmp_path / "releases" / "sub")
    r = call({"op": "validate_pack", "pack": str(elsewhere)})
    assert r["issues"] == ["extends: no pack 'neutral'"]
    r = call({"op": "describe_pack", "pack": str(elsewhere), "packs": {"neutral": str(group)}})
    assert r["ok"] and r["extends"] == [{"id": "neutral", "dir": str(group)}]
    assert r["docs"]["voice"] == str(group / "voice.md")

    m = yaml.safe_load((group / "pack.yaml").read_text())
    (group / "pack.yaml").write_text(yaml.safe_dump({**m, "extends": "sub"}))
    with pytest.raises(PackError, match="cycle"):
        load_pack(_subsidiary(group, group.parent))
