import json

import pytest
import yaml

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
