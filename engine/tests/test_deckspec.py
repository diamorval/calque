"""DeckSpec validation against the shared fixtures in packages/deckspec/fixtures (vitest too)."""

import json
from pathlib import Path

import pytest
import yaml

from calque_engine.deckspec import DeckSpecError, validate
from calque_engine.pack import load_pack

FIXTURES = Path(__file__).resolve().parents[2] / "packages/deckspec/fixtures"


def cases(kind: str):
    return sorted(FIXTURES.joinpath(kind).glob("*.json"), key=lambda p: p.name)


def expectation(path: Path) -> str:
    return path.with_suffix(".expect.txt").read_text().strip()


@pytest.mark.parametrize("path", cases("valid"), ids=lambda p: p.stem)
def test_valid_fixture_passes(path, neutral_pack):
    validate(json.loads(path.read_text()), load_pack(neutral_pack))


@pytest.mark.parametrize("path", cases("invalid-schema"), ids=lambda p: p.stem)
def test_invalid_schema_fixture_fails(path, neutral_pack):
    with pytest.raises(DeckSpecError) as e:
        validate(json.loads(path.read_text()), load_pack(neutral_pack))
    assert expectation(path) in str(e.value)


@pytest.mark.parametrize("path", cases("invalid-rules"), ids=lambda p: p.stem)
def test_invalid_rules_fixture_fails(path, neutral_pack):
    with pytest.raises(DeckSpecError) as e:
        validate(json.loads(path.read_text()), load_pack(neutral_pack))
    messages = [i.message for i in e.value.issues if i.severity == "ERROR"]
    assert any(expectation(path) in m for m in messages), messages


def test_never_clone_slide_is_refused(neutral_pack):
    manifest = yaml.safe_load((neutral_pack / "pack.yaml").read_text())
    manifest["roles"]["closing"] = [1]
    manifest["never_clone"] = [3]
    (neutral_pack / "pack.yaml").write_text(yaml.safe_dump(manifest))
    spec = json.loads((FIXTURES / "valid/clone-slide-values.json").read_text())
    with pytest.raises(DeckSpecError, match="slide 3 is documentation: never clone it"):
        validate(spec, load_pack(neutral_pack))


def test_fixture_sets_are_not_empty():
    assert len(cases("valid")) >= 8
    assert len(cases("invalid-schema")) >= 8
    assert len(cases("invalid-rules")) >= 10
