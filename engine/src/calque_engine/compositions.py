"""Grid-relative compositions (core/compositions.md): each recipe resolves its boxes against the
active pack's grid (`st.grid`), reuses the diagrams and `charts.add_chart`, and never crosses the
footer line."""

from __future__ import annotations

import re

from . import diagrams as dg
from . import draw as d
from .build import renderer
from .draw import Run
from .style import Style


def _p(s) -> dict:
    return s.source["params"]


def block(slide, st: Style, l, t, w, h, b: dict, first: str = "body"):
    """One idea group: a label-font caps label in muted, then its lines in the body role."""
    runs = [dg.tag(b["label"], size="label")] if b.get("label") else []
    for i, line in enumerate(b["lines"]):
        bullet = "•" if len(b["lines"]) > 1 and (runs or i) else None
        runs.append(Run(line, size=first if i == 0 else "body", bullet=bullet, space_before=8))
    return d.add_text(slide, st, l, t, w, h, runs)


def _split(st: Style, split: str) -> tuple[int, int]:
    """(n, k): an n-column grid with the main element on k columns. `3/1` wants a 4 grid."""
    return (4, 3) if split == "3/1" else (3, 2)


@renderer("composition:chart_takeaway")
def chart_takeaway(slide, st: Style, s) -> None:
    from .charts import add_chart

    p, g = _p(s), st.grid
    split = p.get("split") or ("2/1" if p.get("takeaway") else "full")
    if split == "full" or not p.get("takeaway"):
        add_chart(slide, st, p["chart_type"], p["chart"], g.margin, g.top, g.bw, 0.95 * g.bh)
        return
    n, k = _split(st, split)
    add_chart(
        slide, st, p["chart_type"], p["chart"], g.cols(n)[0], g.top, g.span(n, 0, k), 0.95 * g.bh
    )
    block(slide, st, g.cols(n)[k], g.y(0.07), g.cw(n), 0.85 * g.bh, p["takeaway"])


@renderer("composition:flow_detail")
def flow_detail(slide, st: Style, s) -> None:
    p, g = _p(s), st.grid
    flow = {"steps": p["steps"], "active": p["active"], "orientation": p.get("orientation")}
    if p.get("orientation") == "vertical":
        dg.flow(slide, st, flow, g.cols(3)[0], g.y(0.02), g.cw(3), 0.9 * g.bh)
        block(slide, st, g.cols(3)[1], g.y(0.07), g.span(3, 1, 2), 0.85 * g.bh, p["detail"])
        return
    dg.flow(slide, st, flow, g.margin, g.y(0.05), g.bw, 0.40 * g.bh)
    block(slide, st, g.cols(3)[0], g.y(0.58), g.span(3, 0, 2), 0.35 * g.bh, p["detail"])


@renderer("composition:matrix_2x2")
def matrix_2x2(slide, st: Style, s) -> None:
    g = st.grid
    # the diagram keeps 0.09·bw each side for the axis ends: the plot spans [x(0.09), x(0.91)]
    dg.matrix2x2(slide, st, _p(s), g.margin, g.top, g.bw, g.bh)


def _fit_pt(st: Style, text: str, role: str, size: str, w: float) -> float:
    """The role size, reduced only as far as the text needs to hold on one line of `w`."""
    pt = st.size(size)
    tw = st.text_width(text, st.font(role), pt)
    return max(st.size("caption"), pt * min(1.0, w / tw)) if tw else pt


@renderer("composition:kpi_sparkband")
def kpi_sparkband(slide, st: Style, s) -> None:
    from .charts import add_chart

    p, g = _p(s), st.grid
    figs = p["figures"]
    n = len(figs)
    for i, f in enumerate(figs):
        w = g.cw(n)
        pt = min(_fit_pt(st, f["value"], "display", "numeral", w * 0.95) for f in figs)
        d.add_text(
            slide,
            st,
            g.cols(n)[i],
            g.top,
            w,
            0.27 * g.bh,
            [
                Run(f["value"], size=pt, font="display"),
                Run(f["label"], size="caption", color="muted", space_before=2),
            ],
            anchor="bottom",
        )
    trend = p["trend"]
    params = {
        "categories": trend["categories"],
        "series": [{"name": " ", "values": trend["values"]}],
        "number_format": "#,##0"
        if all(float(v).is_integer() for v in trend["values"])
        else "#,##0.0",
    }
    add_chart(slide, st, "line", params, g.margin, g.y(0.42), g.bw, 0.55 * g.bh)


@renderer("composition:layers_rail")
def layers_rail(slide, st: Style, s) -> None:
    p, g = _p(s), st.grid
    anns = p.get("annotations") or []
    lw = g.span(3, 0, 2) if anns else g.bw
    out = dg.layers(slide, st, p, g.cols(3)[0], g.y(0.05), lw, 0.92 * g.bh)
    rail_x = g.cols(3)[2] + 0.05 * g.cw(3)
    rail_w = 0.95 * g.cw(3)
    icons = d.icon_names(st)
    for a in anns:
        b = out["boxes"][min(a["layer"], len(out["boxes"]) - 1)]
        top, h = b.top / 914400, b.height / 914400
        x = rail_x
        if a.get("icon") in icons:
            sz = min(0.32, h * 0.6)
            d.add_icon(slide, st, a["icon"], x, top + (h - sz) / 2, size=sz, color="accent")
            x += sz + 0.12
        x0 = (b.left + b.width) / 914400
        d.add_line(
            slide,
            st,
            x0,
            top + h / 2,
            rail_x - 0.06,
            top + h / 2,
            color="rule",
            weight="hairline",
            dash="dash",
        )
        d.add_text(
            slide, st, x, top, rail_x + rail_w - x, h, Run(a["text"], size="body"), anchor="middle"
        )


_NUM = re.compile(
    r"^[\s+\-−~≈<>]*[\d.,\s]+\s*[%€$£kKMx]*\.?$|^[\d.,\s]*\s*[€$£]\s*[\d.,\s]+[kKM]?$"
)


@renderer("composition:comparison_table")
def comparison_table(slide, st: Style, s) -> None:
    p, g = _p(s), st.grid
    rows = [list(p["header"]), *p["rows"]]
    ncols = len(rows[0])
    rows = [(r + [""] * ncols)[:ncols] for r in rows]
    avail = 0.95 * g.bh
    size = "body"
    row_h = min(avail / len(rows), max(0.42, st.size("body") / 72 * 2.6))
    if row_h < st.size("body") / 72 * 2.0:
        size = "caption"
    min_h = st.size("caption") / 72 * 2.0
    if row_h < min_h:  # overflow guard: cut rows, never shrink type below caption
        row_h = min_h
        rows = rows[: max(2, int(avail / min_h))]
    align = p.get("align") or [
        "right" if all(_NUM.match(r[c] or "0") for r in rows[1:]) else "left" for c in range(ncols)
    ]
    rec = p.get("recommend") or {}
    emphasis = None
    if rec.get("row") is not None:
        emphasis = (rec["row"] + 1, rec.get("col") or 0)
    elif rec.get("col") is not None:
        emphasis = (0, rec["col"])
    if emphasis and emphasis[0] >= len(rows):
        emphasis = None
    d.add_table(
        slide,
        st,
        g.margin,
        g.y(0.05),
        g.bw,
        rows,
        col_weights=p.get("col_weights"),
        size=size,
        row_h=row_h,
        align=align,
        emphasis=emphasis,
    )


@renderer("composition:funnel_rail")
def funnel_rail(slide, st: Style, s) -> None:
    p, g = _p(s), st.grid
    stages = p["stages"]
    conv = p.get("conversions") or []
    off = 1 if len(conv) == len(stages) - 1 else 0  # stage-to-stage rates start at stage 2
    items = []
    for i, stg in enumerate(stages):
        j = i - off
        sub = conv[j] if 0 <= j < len(conv) else None
        items.append({"label": stg["label"], **({"sublabel": sub} if sub else {})})
    params = {"stages": items, "values": [x["value"] for x in stages], "active": p.get("active")}
    if p.get("rail"):
        dg.funnel(slide, st, params, g.cols(3)[0], g.top, g.span(3, 0, 2), g.bh)
        block(slide, st, g.cols(3)[2], g.y(0.10), g.cw(3), 0.80 * g.bh, p["rail"])
    else:
        dg.funnel(slide, st, params, g.margin, g.top, g.bw, g.bh)
