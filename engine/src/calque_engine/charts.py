"""Native, editable charts (python-pptx charts with an embedded workbook, never images), styled
purely from the pack's roles: primary series in `accent`, the one element the slide is about in
`highlight`, further series on the quiet `series.*` ramp. Body font in ink at caption size,
hairline axes in `rule`, value gridlines only (`gridline` role when the pack has one). No chart
title, no 3D, no shadow, no border; doughnut not pie; direct labels for one series, legend at the
bottom for 2+."""

from __future__ import annotations

from typing import Any

from pptx.chart.data import CategoryChartData, XyChartData
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_LEGEND_POSITION
from pptx.enum.chart import XL_MARKER_STYLE as MK
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

from .build import renderer
from .deckspec import Slide
from .style import Style

CHART_TYPES = {
    ("line", False): XL_CHART_TYPE.LINE,
    ("line", True): XL_CHART_TYPE.LINE_STACKED,
    ("bar", False): XL_CHART_TYPE.COLUMN_CLUSTERED,
    ("bar", True): XL_CHART_TYPE.COLUMN_STACKED,
    ("bar_horizontal", False): XL_CHART_TYPE.BAR_CLUSTERED,
    ("bar_horizontal", True): XL_CHART_TYPE.BAR_STACKED,
    ("doughnut", False): XL_CHART_TYPE.DOUGHNUT,
    ("scatter", False): XL_CHART_TYPE.XY_SCATTER,
}


def _number_format(params: dict[str, Any]) -> str:
    fmt = params.get("number_format") or "#,##0"
    unit = params.get("unit")
    return f'{fmt}" {unit}"' if unit and not params.get("number_format") else fmt


def _no_border(chart) -> None:
    """No fill, no line on the chart space: the chart sits on the slide, frameless."""
    cs = chart._chartSpace
    for el in cs.findall(qn("c:spPr")):
        cs.remove(el)
    sp = cs.makeelement(qn("c:spPr"), {})
    sp.append(sp.makeelement(qn("a:noFill"), {}))
    ln = sp.makeelement(qn("a:ln"), {})
    ln.append(ln.makeelement(qn("a:noFill"), {}))
    sp.append(ln)
    cs.find(qn("c:chart")).addnext(sp)
    rc = cs.find(qn("c:roundedCorners"))
    if rc is not None:
        rc.set("val", "0")


def _style_text(font, st: Style) -> None:
    font.name = st.font("body")
    font.size = Pt(st.size("caption"))
    font.color.rgb = st.rgb("ink")


def _style_axes(chart, st: Style, params: dict[str, Any], fmt: str) -> None:
    grid = "gridline" if st.has_color("gridline") else "rule"
    hair = Pt(st.stroke("hairline"))
    titles = {"category_axis": params.get("x_title"), "value_axis": params.get("y_title")}
    for name, title in titles.items():
        axis = getattr(chart, name)
        axis.format.line.color.rgb = st.rgb("rule")
        axis.format.line.width = hair
        _style_text(axis.tick_labels.font, st)
        axis.has_minor_gridlines = False
        axis.has_major_gridlines = name == "value_axis"
        if name == "value_axis":
            axis.major_gridlines.format.line.color.rgb = st.rgb(grid)
            axis.major_gridlines.format.line.width = hair
            axis.tick_labels.number_format = fmt
            axis.tick_labels.number_format_is_linked = False
        if title:
            axis.has_title = True
            axis.axis_title.text_frame.text = title
            _style_text(axis.axis_title.text_frame.paragraphs[0].runs[0].font, st)


def _fill(fmt, rgb) -> None:
    fmt.fill.solid()
    fmt.fill.fore_color.rgb = rgb


def _marker(m, rgb, size: int = 7) -> None:
    m.style = MK.CIRCLE
    m.size = size
    _fill(m.format, rgb)
    m.format.line.fill.background()


def add_chart(slide, st: Style, chart_type: str, params: dict[str, Any], l, t, w, h):
    """Draw a native chart from DeckSpec ChartParams in the box (inches); returns the frame."""
    stacked = bool(params.get("stacked")) and chart_type in ("line", "bar", "bar_horizontal")
    xl = CHART_TYPES[(chart_type, stacked)]
    fmt = _number_format(params)
    hl = params.get("highlight")
    hs = params.get("highlight_series")

    if chart_type == "scatter":
        points = params["points"]
        data = XyChartData()
        s = data.add_series(params.get("y_title") or "")
        for p in points:
            s.add_data_point(p["x"], p["y"])
        n_series = 1
    else:
        series = params["series"]
        if chart_type == "doughnut":
            series = series[:1]  # a share of one whole
        data = CategoryChartData(number_format=fmt)
        cats = list(params["categories"])
        flip = chart_type == "bar_horizontal"  # a horizontal bar plots bottom-up: list it reversed
        if flip:
            cats.reverse()
            hl = None if hl is None else len(cats) - 1 - hl
        data.categories = cats
        for s in series:
            data.add_series(s["name"], s["values"][::-1] if flip else s["values"])
        n_series = len(series)

    frame = slide.shapes.add_chart(xl, Inches(l), Inches(t), Inches(w), Inches(h), data)
    chart = frame.chart
    chart.has_title = False
    _style_text(chart.font, st)
    _no_border(chart)
    plot = chart.plots[0]
    colors = st.series(n_series)
    hi = st.rgb("highlight")
    # the highlighted point lives in the highlighted series, else in the primary one
    hl_series = hs if hs is not None else 0

    chart.has_legend = n_series > 1
    if chart.has_legend:
        chart.legend.position = XL_LEGEND_POSITION.BOTTOM
        chart.legend.include_in_layout = False
        _style_text(chart.legend.font, st)

    if chart_type == "doughnut":
        n = len(params["categories"])
        ramp = st.series(n)
        ser = plot.series[0]
        for i in range(n):
            pt = ser.points[i]
            _fill(pt.format, hi if i == hl else ramp[i])
            pt.format.line.color.rgb = st.rgb("background")
        hole = plot._element.find(qn("c:holeSize"))
        if hole is not None:
            hole.set("val", "60")
        plot.has_data_labels = True
        dl = plot.data_labels
        dl.show_category_name = True
        dl.show_percentage = True
        dl.show_value = False
        dl.number_format = "0%"
        dl.number_format_is_linked = False
        dl.position = XL_LABEL_POSITION.OUTSIDE_END
        _style_text(dl.font, st)
        return frame

    _style_axes(chart, st, params, fmt)

    if chart_type == "scatter":
        ser = plot.series[0]
        ser.format.line.fill.background()  # points only, never a joining line
        _marker(ser.marker, colors[0])
        for i, p in enumerate(points):
            pt = ser.points[i]
            if i == hl:
                _marker(pt.marker, hi, 9)
            pt.data_label.has_text_frame = True
            pt.data_label.text_frame.text = p["label"]
            pt.data_label.position = XL_LABEL_POSITION.RIGHT
            _style_text(pt.data_label.text_frame.paragraphs[0].runs[0].font, st)
        return frame

    for si, ser in enumerate(plot.series):
        rgb = hi if si == hs else colors[si]
        if chart_type == "line":
            ser.smooth = False
            ser.format.line.color.rgb = rgb
            ser.format.line.width = Pt(st.stroke("emphasis" if si == hs else "link"))
            ser.marker.style = MK.NONE
            if si == hl_series and hl is not None:
                _marker(ser.points[hl].marker, hi)
        else:
            _fill(ser.format, rgb)
            if si == hl_series and hl is not None:
                _fill(ser.points[hl].format, hi)
    if chart_type != "line":
        plot.gap_width = 60
        if stacked:
            plot.overlap = 100

    if n_series == 1 or (chart_type != "line" and not stacked):
        plot.has_data_labels = True
        dl = plot.data_labels
        dl.number_format = fmt
        dl.number_format_is_linked = False
        dl.position = (
            XL_LABEL_POSITION.ABOVE if chart_type == "line" else XL_LABEL_POSITION.OUTSIDE_END
        )
        _style_text(dl.font, st)
    return frame


@renderer("chart")
def render_chart(slide, st: Style, s: Slide) -> None:
    g = st.grid
    add_chart(slide, st, s.source["type"], s.source["params"], g.margin, g.top, g.bw, g.bh)
