"""Charts are native, role-styled and carry the highlight, for every pack."""

from pathlib import Path

import pytest
from pptx import Presentation
from pptx.enum.chart import XL_CHART_TYPE
from pptx.oxml.ns import qn

from calque_engine.build import build
from calque_engine.pack import load_pack
from calque_engine.style import Style

REPO = Path(__file__).resolve().parents[2]
PACKS = sorted((REPO / "packs").glob("*/pack.yaml"))

CATS = ["North", "South", "East", "West"]
CASES = {
    "line": (
        "trend",
        {
            "categories": CATS,
            "series": [
                {"name": "A", "values": [1, 3, 2, 5]},
                {"name": "B", "values": [2, 2, 4, 3]},
            ],
            "highlight_series": 1,
            "unit": "k",
            "y_title": "Volume",
        },
        XL_CHART_TYPE.LINE,
    ),
    "bar": (
        "quantity",
        {"categories": CATS, "series": [{"name": "A", "values": [4, 7, 3, 5]}], "highlight": 1},
        XL_CHART_TYPE.COLUMN_CLUSTERED,
    ),
    "bar_horizontal": (
        "ranking",
        {"categories": CATS, "series": [{"name": "A", "values": [9, 7, 4, 2]}], "highlight": 0},
        XL_CHART_TYPE.BAR_CLUSTERED,
    ),
    "doughnut": (
        "share",
        {"categories": CATS, "series": [{"name": "A", "values": [40, 30, 20, 10]}], "highlight": 2},
        XL_CHART_TYPE.DOUGHNUT,
    ),
    "scatter": (
        "quantity",
        {
            "points": [
                {"label": "P1", "x": 1, "y": 2},
                {"label": "P2", "x": 3, "y": 5},
                {"label": "P3", "x": 4, "y": 1},
            ],
            "highlight": 1,
            "x_title": "Cost",
            "y_title": "Value",
        },
        XL_CHART_TYPE.XY_SCATTER,
    ),
}


def deck(pack_id: str, chart_type: str) -> dict:
    message_type, params, _ = CASES[chart_type]
    return {
        "pack_id": pack_id,
        "language": "en",
        "title": "Charts",
        "slides": [
            {
                "id": "cover",
                "message": "Charts",
                "message_type": "cover",
                "form": "cover",
                "source": {"kind": "clone", "role": "cover"},
            },
            {
                "id": "chart",
                "message": "North leads",
                "message_type": message_type,
                "form": chart_type,
                "title": "North leads",
                "source": {"kind": "chart", "type": chart_type, "params": params},
            },
        ],
    }


def build_chart(manifest: Path, chart_type: str, tmp_path: Path):
    pack = load_pack(manifest.parent)
    out = tmp_path / f"{chart_type}.pptx"
    build(deck(pack.id, chart_type), pack, out)
    charts = [sh.chart for sh in Presentation(str(out)).slides[1].shapes if sh.has_chart]
    assert len(charts) == 1
    return Style(pack), charts[0]


@pytest.mark.parametrize("chart_type", list(CASES))
@pytest.mark.parametrize("manifest", PACKS, ids=lambda p: p.parent.name)
def test_native_chart_with_highlight(manifest, chart_type, tmp_path):
    st, chart = build_chart(manifest, chart_type, tmp_path)
    _, params, xl = CASES[chart_type]
    assert chart.chart_type == xl
    hi = st.rgb("highlight")
    ser = chart.plots[0].series
    if chart_type == "line":
        assert ser[params["highlight_series"]].format.line.color.rgb == hi
        assert ser[0].format.line.color.rgb == st.rgb("accent")
    elif chart_type == "scatter":
        assert ser[0].points[params["highlight"]].marker.format.fill.fore_color.rgb == hi
    else:
        idx = params["highlight"]
        if chart_type == "bar_horizontal":  # listed bottom-up so the first category reads on top
            idx = len(params["categories"]) - 1 - idx
        assert ser[0].points[idx].format.fill.fore_color.rgb == hi
        if chart_type != "doughnut":
            assert ser[0].format.fill.fore_color.rgb == st.rgb("accent")


@pytest.mark.parametrize("manifest", PACKS, ids=lambda p: p.parent.name)
def test_chart_has_no_title_and_legend_only_for_several_series(manifest, tmp_path):
    for chart_type in ("bar", "line"):
        _, chart = build_chart(manifest, chart_type, tmp_path)
        assert not chart.has_title
        atd = chart._chartSpace.find(qn("c:chart")).find(qn("c:autoTitleDeleted"))
        assert atd is not None and atd.get("val") == "1"
        assert chart.has_legend == (len(chart.plots[0].series) > 1)
