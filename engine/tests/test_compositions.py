"""Every composition on every pack: boxes from the grid, nothing below the footer, one highlight,
native chart / table where the recipe says so."""

from pathlib import Path

import pytest
from pptx import Presentation

from calque_engine.build import build
from calque_engine.pack import load_pack

from .test_diagrams import PACKS, check, deck

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"]
TAKEAWAY = {"label": "What it says", "lines": ["South makes a third of North.", "Target cut."]}

# id -> (message_type, params, minimum drawn shapes, has an active element)
COMPOSITIONS = {
    "chart_takeaway": (
        "quantity",
        {
            "chart_type": "bar",
            "chart": {
                "categories": ["North", "East", "South", "West"],
                "series": [{"name": "Revenue", "values": [12.4, 8.1, 4.2, 6.6]}],
                "highlight": 2,
            },
            "takeaway": TAKEAWAY,
        },
        2,
        False,
    ),
    "flow_detail": (
        "process",
        {
            "steps": ["Frame", {"label": "Migrate", "sublabel": "8 weeks"}, "Test", "Switch"],
            "active": 1,
            "detail": {"label": "Migrate", "lines": ["42 pipelines in waves of 6, reversible."]},
        },
        12,
        True,
    ),
    "matrix_2x2": (
        "positioning",
        {
            "x_axis": ["Niche", "Global"],
            "y_axis": ["Follower", "Leader"],
            "quadrants": ["Specialists", "Leaders", "Locals", "Generalists"],
            "items": [
                {"label": "Northwind", "x": 0.8, "y": 0.75},
                {"label": "Us", "x": 0.62, "y": 0.86},
                {"label": "Contoso", "x": 0.2, "y": 0.35},
            ],
            "active": 1,
        },
        16,
        True,
    ),
    "kpi_sparkband": (
        "trend",
        {
            "figures": [
                {"value": "4.2 M", "label": "Q2 revenue"},
                {"value": "+38 %", "label": "vs Q1"},
                {"value": "77", "label": "signed clients"},
            ],
            "trend": {"categories": MONTHS, "values": [2.1, 2.4, 2.9, 3.3, 3.8, 4.2]},
        },
        4,
        False,
    ),
    "layers_rail": (
        "system",
        {
            "layers": [
                {"label": "Exposure", "sublabel": "APIs, dashboards"},
                {"label": "Services", "sublabel": "catalogue, quality"},
                {"label": "Processing", "sublabel": "batch, streaming"},
                {"label": "Foundation", "sublabel": "lakehouse, IAM"},
            ],
            "active": 1,
            "annotations": [
                {"layer": 1, "icon": "shield-check", "text": "Governance, carried by the core."},
                {"layer": 3, "text": "One identity layer for all tools."},
            ],
        },
        8,
        True,
    ),
    "comparison_table": (
        "pricing",
        {
            "header": ["Offer", "Scope", "Lead time", "Price / month"],
            "rows": [
                ["Starter", "1 domain, 5 users", "2 wk", "900"],
                ["Scale", "3 domains, 25 users", "4 wk", "2 400"],
                ["Enterprise", "Unlimited", "8 wk", "6 000"],
            ],
            "col_weights": [2, 4, 1.5, 2],
            "recommend": {"row": 1, "col": 3},
        },
        1,
        True,
    ),
    "funnel_rail": (
        "conversion",
        {
            "stages": [
                {"label": "Leads", "value": 1240},
                {"label": "Qualified", "value": 434},
                {"label": "Proposal", "value": 208},
                {"label": "Signed", "value": 77},
            ],
            "conversions": ["35 %", "48 %", "37 %"],
            "active": 3,
            "rail": {"label": "Where it leaks", "lines": ["Proposal to signature loses 63 %."]},
        },
        9,
        True,
    ),
}


@pytest.mark.parametrize("manifest", PACKS, ids=lambda p: p.parent.name)
@pytest.mark.parametrize("cid", sorted(COMPOSITIONS))
def test_composition_builds_on_grid(manifest, cid, tmp_path):
    pack = load_pack(manifest.parent)
    mtype, params, minimum, active = COMPOSITIONS[cid]
    out = tmp_path / f"{cid}.pptx"
    build(deck(pack, cid, mtype, {"kind": "composition", "id": cid, "params": params}), pack, out)
    shapes = check(pack, out, minimum, active)
    if cid in ("chart_takeaway", "kpi_sparkband"):
        assert sum(getattr(sh, "has_chart", False) for sh in shapes) == 1
    if cid == "comparison_table":
        assert sum(getattr(sh, "has_table", False) for sh in shapes) == 1


@pytest.mark.parametrize("manifest", PACKS, ids=lambda p: p.parent.name)
@pytest.mark.parametrize("cid", sorted(COMPOSITIONS))
def test_composition_with_source_stays_above_it(manifest, cid, tmp_path):
    """With `source`, the recipe draws above the source line, which stays above the footer."""
    pack = load_pack(manifest.parent)
    mtype, params, minimum, active = COMPOSITIONS[cid]
    src = {"kind": "composition", "id": cid, "params": {**params, "source": "Source: audit"}}
    out = tmp_path / f"{cid}.pptx"
    build(deck(pack, cid, mtype, src), pack, out)
    shapes = check(pack, out, minimum, active)
    (line,) = [sh for sh in shapes if sh.name == "Source"]
    drawn = [sh for sh in shapes if sh.shape_id > line.shape_id]  # drawn after the line
    assert drawn and all(sh.top + sh.height <= line.top + 1 for sh in drawn), cid


@pytest.mark.parametrize("manifest", PACKS, ids=lambda p: p.parent.name)
def test_variants(manifest, tmp_path):
    """Full-width chart, vertical flow, rail-less funnel, a table too long for the band."""
    pack = load_pack(manifest.parent)
    ct = dict(COMPOSITIONS["chart_takeaway"][1], split="full", takeaway=None)
    del ct["takeaway"]
    fd = dict(COMPOSITIONS["flow_detail"][1], orientation="vertical")
    fr = dict(COMPOSITIONS["funnel_rail"][1])
    del fr["rail"]
    tb = dict(COMPOSITIONS["comparison_table"][1], rows=[["a", "b", "c", "1"]] * 40)
    variants = [
        ("chart_takeaway", "quantity", ct, False),
        ("flow_detail", "process", fd, True),
        ("funnel_rail", "conversion", fr, True),
        ("comparison_table", "pricing", tb, True),
    ]
    for cid, mtype, params, active in variants:
        out = tmp_path / f"{cid}.pptx"
        src = {"kind": "composition", "id": cid, "params": params}
        build(deck(pack, cid, mtype, src), pack, out)
        check(pack, out, 1, active)


@pytest.mark.parametrize("manifest", PACKS, ids=lambda p: p.parent.name)
def test_all_compositions_in_one_deck(manifest, tmp_path):
    pack = load_pack(manifest.parent)
    data = deck(pack, "flow_detail", "process", {})
    data["slides"] = [
        {
            "id": cid,
            "message": "m",
            "message_type": mtype,
            "form": cid,
            "title": "Verdict",
            "source": {"kind": "composition", "id": cid, "params": params},
        }
        for cid, (mtype, params, _, _) in COMPOSITIONS.items()
    ]
    report = build(data, pack, Path(tmp_path) / "all.pptx")
    assert len(Presentation(str(report.path)).slides) == len(COMPOSITIONS)
