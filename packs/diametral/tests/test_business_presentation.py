"""A real client-style template (fonts set on each run, not in the theme) imports and publishes:
the same checks as the server's publish step (template lint, then a cover/content/closing test
deck that builds and lints clean)."""

import json
import shutil
from pathlib import Path

import pytest
import yaml

from calque_engine.api import op_build, op_extract, op_lint

TEMPLATE = Path(__file__).resolve().parents[1] / "reference" / "business-presentation.pptx"


@pytest.fixture(scope="module")
def drafted(tmp_path_factory):
    d = tmp_path_factory.mktemp("bp")
    shutil.copy(TEMPLATE, d / "template.pptx")
    r = op_extract(str(d / "template.pptx"), "bp", "BP")
    (d / "pack.yaml").write_text(yaml.safe_dump(r["manifest"], allow_unicode=True))
    (d / "template-map.yaml").write_text(yaml.safe_dump(r["template_map"], allow_unicode=True))
    (d / "tokens.json").write_text(json.dumps(r["tokens"]))
    return d, r


def errors(findings):
    return [f for f in findings if f["severity"] == "ERROR"]


def test_run_fonts_are_declared_and_the_template_lints_clean(drafted):
    d, r = drafted
    assert r["template_map"]["theme"]["fonts"] == {"major": "Arial", "minor": "Arial"}
    assert {"Geist", "Geist Light"} <= set(r["manifest"]["lint"]["extra_fonts"])
    assert errors(op_lint(str(d), str(d / "template.pptx"), template=True)["findings"]) == []


def test_roles_find_summaries_and_dividers(drafted):
    roles = drafted[1]["manifest"]["roles"]
    assert roles["cover"] == [1] and roles["closing"] == [27]
    assert {2, 28} <= set(roles["summary"])
    assert {3, 11, 18, 24} <= set(roles["divider"])
    assert 2 not in roles["content"]
    # a summary's entries are real copy, not placeholders
    assert "Our next steps" not in drafted[1]["manifest"]["lint"]["placeholders"]


def test_a_test_deck_builds_and_lints_clean(drafted):
    d, r = drafted
    roles, slides = r["manifest"]["roles"], {s["number"]: s for s in r["template_map"]["slides"]}

    def slide(role):
        title = slides[roles[role][0]].get("slots", {}).get("title")
        values = {str(title): f"Test {role}"} if title else {}
        kind = "narrative" if role == "content" else role
        source = {"kind": "clone", "role": role, "values": values}
        return {
            "id": role,
            "message": f"Test {role}",
            "message_type": kind,
            "form": role,
            "source": source,
        }

    deck = {
        "pack_id": "bp",
        "language": "en",
        "title": "Test",
        "slides": [slide(r) for r in ("cover", "content", "closing")],
    }
    out = d / "test.pptx"
    built = op_build(str(d), deck, str(out))
    sources = {str(s["position"]): s["source"] for s in built["slides"].values()}
    assert errors(op_lint(str(d), str(out), language="en", sources=sources)["findings"]) == []
