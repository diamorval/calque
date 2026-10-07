"""Native diagrams: flow, swimlane, layers, hub, matrix2x2, funnel, cycle, before_after.

Each `fn(slide, st, params, l, t, w, h)` draws one DeckSpec diagram (`params` = the source's
params dict) inside the frame with native, editable shapes, every value from the pack's roles:
boxes `surface` + `rule` hairline, a `wash.*` for an emphasis or foundation tier, links `muted`
at `stroke.link`, `highlight` only on the one `active` element as a stroke, numeral or arrow.
Geometry is a fraction of the frame, so it scales across canvases. Each is also registered as
the `diagram:<id>` renderer, drawn into the pack's body band.
"""

from __future__ import annotations

import math
from typing import Any

from . import draw as d
from .build import renderer
from .draw import Run
from .style import Style


def wash(st: Style, *prefer: str) -> str:
    """First wash role the pack has, else `surface`: emphasis tiers degrade gracefully."""
    for role in (*prefer, "wash.emphasis", "wash.subsection", "wash.summary"):
        if st.has_color(role):
            return role
    return "surface"


def box_text(label: str, sub: str | None, size: str = "label") -> list[Run]:
    out = [Run(label, size=size, bold=True)]
    if sub:
        out.append(Run(sub, size="caption", color="muted", space_before=2))
    return out


def tag(text: str, color: str = "muted", size: str = "caption", **kw) -> Run:
    """A label-font caps tag: lane names, axis ends, quadrants, panel heads."""
    return Run(str(text).upper(), size=size, color=color, font="label", **kw)


def node(slide, st: Style, l, t, w, h, text, active: bool = False, fill: str = "surface", **kw):
    """The diagram unit: surface box, rule hairline; the active one gets the highlight stroke."""
    return d.add_box(
        slide,
        st,
        l,
        t,
        w,
        h,
        fill=fill,
        line="highlight" if active else "rule",
        line_w="emphasis" if active else "hairline",
        text=text,
        **kw,
    )


def mark(slide, st: Style, icon: str | None, i: int, l, t, w, h, active: bool, align="left"):
    """Ordinal above / beside a step: the pack icon when it has one, else `01`, `02` ..."""
    color = "highlight" if active else "accent"
    if icon and icon in d.icon_names(st):
        s = min(h, 0.32)
        x = l + (w - s) / 2 if align == "center" else l
        return d.add_icon(slide, st, icon, x, t + (h - s) / 2, size=s, color=color)
    return d.add_text(
        slide,
        st,
        l,
        t,
        w,
        h,
        Run(f"{i + 1:02d}", size="label", color=color, font="label"),
        align=align,
        anchor="middle",
    )


def _edge(w: float, h: float, ux: float, uy: float) -> float:
    """Distance from a w×h box centre to its border along the unit vector (ux, uy)."""
    return min(w / 2 / abs(ux) if ux else math.inf, h / 2 / abs(uy) if uy else math.inf)


def _link(slide, st: Style, a, b, size_a, size_b, pad=0.06, **kw):
    """Arrow between two box centres, clipped to both box borders."""
    (x1, y1), (x2, y2) = a, b
    dist = math.hypot(x2 - x1, y2 - y1) or 1.0
    ux, uy = (x2 - x1) / dist, (y2 - y1) / dist
    s = _edge(*size_a, ux, uy) + pad
    e = _edge(*size_b, ux, uy) + pad
    if s + e >= dist:
        return None
    return d.add_arrow(slide, st, x1 + ux * s, y1 + uy * s, x2 - ux * e, y2 - uy * e, **kw)


def _mark_h(st: Style) -> float:
    return max(0.3, st.size("label") / 72 * 2.2)


# --- diagrams ----------------------------------------------------------------------------------


def flow(slide, st: Style, params: dict, l, t, w, h) -> dict[str, list]:
    """Process: N steps + N-1 arrows. `orientation: vertical` stacks them (ordinals on the left)."""
    steps = [d.item(s) for s in params["steps"]]
    active, numbered = params.get("active"), params.get("numbered", True)
    n = len(steps)
    boxes, arrows, marks = [], [], []
    mh = _mark_h(st)
    if params.get("orientation") == "vertical":
        mw = mh * 1.6 if numbered or any(s[2] for s in steps) else 0.0
        gap = max(st.grid.gutter, 0.22)
        bh = min((h - gap * (n - 1)) / n, 1.1)
        top = t + (h - (n * bh + (n - 1) * gap)) / 2
        for i, (label, sub, icon) in enumerate(steps):
            y = top + i * (bh + gap)
            boxes.append(node(slide, st, l + mw, y, w - mw, bh, box_text(label, sub), i == active))
            if mw:
                marks.append(mark(slide, st, icon, i, l, y, mw, bh, i == active))
            if i:
                cx = l + mw + (w - mw) / 2
                arrows.append(d.add_arrow(slide, st, cx, y - gap + 0.04, cx, y - 0.04))
        return {"boxes": boxes, "arrows": arrows, "marks": marks}

    gap = max(st.grid.gutter, 0.06 * w / max(n - 1, 1)) if n > 4 else st.grid.gutter
    gap = max(gap, 0.2)
    cw = (w - gap * (n - 1)) / n
    has_marks = numbered or any(s[2] for s in steps)
    bh = min(h - (mh if has_marks else 0), max(0.85, 0.45 * h), 1.6)
    group = bh + (mh if has_marks else 0)
    top = t + (h - group) / 2
    by = top + (mh if has_marks else 0)
    for i, (label, sub, icon) in enumerate(steps):
        x = l + i * (cw + gap)
        boxes.append(node(slide, st, x, by, cw, bh, box_text(label, sub), i == active))
        if has_marks:
            marks.append(mark(slide, st, icon, i, x, top, cw, mh * 0.85, i == active))
        if i:
            ym = by + bh / 2
            arrows.append(d.add_arrow(slide, st, x - gap + 0.04, ym, x - 0.04, ym))
    return {"boxes": boxes, "arrows": arrows, "marks": marks}


def swimlane(slide, st: Style, params: dict, l, t, w, h) -> dict[str, list]:
    """Lanes of steps sharing one column grid; `active` = [lane, step]."""
    lanes = params["lanes"]
    active = tuple(params["active"]) if params.get("active") is not None else None
    n_cols = max(len(lane["steps"]) for lane in lanes)
    lane_h = h / len(lanes)
    label_w = max(0.16 * w, 1.1)
    gap = max(st.grid.gutter, 0.25)
    cw = (w - label_w - gap * (n_cols - 1)) / n_cols
    bh = min(lane_h * 0.68, 0.95)
    rules, labels, boxes, arrows = [], [], [], []
    for li, lane in enumerate(lanes):
        y = t + li * lane_h
        if li:
            rules.append(d.add_line(slide, st, l, y, l + w, y, color="rule", weight="hairline"))
        labels.append(
            d.add_text(slide, st, l, y, label_w - 0.1, lane_h, tag(lane["label"]), anchor="middle")
        )
        by = y + (lane_h - bh) / 2
        for si, it in enumerate(lane["steps"]):
            label, sub, _ = d.item(it)
            x = l + label_w + si * (cw + gap)
            boxes.append(node(slide, st, x, by, cw, bh, box_text(label, sub), active == (li, si)))
            if si:
                ym = by + bh / 2
                arrows.append(d.add_arrow(slide, st, x - gap + 0.04, ym, x - 0.04, ym))
    return {"rules": rules, "labels": labels, "boxes": boxes, "arrows": arrows}


def layers(slide, st: Style, params: dict, l, t, w, h) -> dict[str, list]:
    """Stacked tiers, top = closest to the user; the foundation (last) tier takes a wash."""
    items = [d.item(x) for x in params["layers"]]
    active, n = params.get("active"), len(items)
    gap = min(0.1, h * 0.03)
    bh = min((h - gap * (n - 1)) / n, 1.2)
    top = t + (h - (n * bh + (n - 1) * gap)) / 2
    boxes = []
    for i, (label, sub, _) in enumerate(items):
        fill = wash(st) if i == n - 1 else "surface"
        boxes.append(
            node(slide, st, l, top + i * (bh + gap), w, bh, box_text(label, sub), i == active, fill)
        )
    return {"boxes": boxes}


def hub(slide, st: Style, params: dict, l, t, w, h) -> dict[str, Any]:
    """One centre (wash tier), spokes on an ellipse, muted links tucked under the boxes."""
    spokes = [d.item(x) for x in params["spokes"]]
    active, n = params.get("active"), len(spokes)
    sw, sh = min(0.2 * w, 2.4), min(0.17 * h, 0.8)
    rx, ry = w / 2 - sw / 2, h / 2 - sh / 2
    cx, cy = l + w / 2, t + h / 2
    cw_, ch_ = min(0.24 * w, 2.8), min(0.26 * h, 1.1)
    angles = [math.radians(-90 + 360 * i / n) for i in range(n)]
    centres = [(cx + rx * math.cos(a), cy + ry * math.sin(a)) for a in angles]
    links = [
        _link(slide, st, (cx, cy), c, (cw_, ch_), (sw, sh), pad=0.0, arrow=None) for c in centres
    ]
    sats = [
        node(slide, st, x - sw / 2, y - sh / 2, sw, sh, box_text(lab, sub), i == active)
        for i, ((x, y), (lab, sub, _)) in enumerate(zip(centres, spokes, strict=True))
    ]
    label, sub, _ = d.item(params["center"])
    centre = d.add_box(
        slide,
        st,
        cx - cw_ / 2,
        cy - ch_ / 2,
        cw_,
        ch_,
        fill=wash(st),
        line="accent",
        line_w="link",
        text=box_text(label, sub, size="body"),
    )
    return {"centre": centre, "links": [x for x in links if x is not None], "satellites": sats}


def matrix2x2(slide, st: Style, params: dict, l, t, w, h) -> dict[str, list]:
    """Positioning matrix: two crossing rule axes (the visible grid), quadrant tags in the
    corners, item dots in accent, the active one in highlight. The plot keeps `0.09·w` on each
    side for the axis end labels."""
    lab_h = st.size("caption") / 72 * 2.0
    side = 0.09 * w
    pl, pt_, pw, ph = l + side, t + lab_h, w - 2 * side, h - 2 * lab_h
    cx, cy = pl + pw / 2, pt_ + ph / 2
    axes = [
        d.add_line(slide, st, cx, pt_, cx, pt_ + ph, color="rule", weight="hairline"),
        d.add_line(slide, st, pl, cy, pl + pw, cy, color="rule", weight="hairline"),
    ]
    xa, ya = params["x_axis"], params["y_axis"]
    labels = [
        d.add_text(slide, st, l, cy - lab_h / 2, side - 0.08, lab_h, tag(xa[0]), "right", "middle"),
        d.add_text(slide, st, pl + pw + 0.08, cy - lab_h / 2, side - 0.08, lab_h, tag(xa[1])),
        d.add_text(slide, st, cx - pw / 4, t, pw / 2, lab_h, tag(ya[1]), "center", "bottom"),
        d.add_text(slide, st, cx - pw / 4, pt_ + ph, pw / 2, lab_h, tag(ya[0]), "center", "top"),
    ]
    labels[1].text_frame.vertical_anchor = d.ANCHOR["middle"]
    qh, pad = lab_h, 0.1
    corners = [(pl, pt_), (cx, pt_), (pl, pt_ + ph - qh), (cx, pt_ + ph - qh)]
    quads = [
        d.add_text(
            slide,
            st,
            x + pad,
            y + (pad if i < 2 else -pad),
            pw / 2 - 2 * pad,
            qh,
            tag(q, size="label"),
            "right" if i % 2 else "left",
        )
        for i, (q, (x, y)) in enumerate(zip(params["quadrants"], corners, strict=True))
    ]
    active = params.get("active")
    dots, tags = [], []
    dd = max(0.11, 0.012 * w)
    tw = min(0.22 * pw, 2.4)
    for i, it in enumerate(params.get("items") or []):
        px, py = pl + it["x"] * pw, pt_ + (1 - it["y"]) * ph
        on = i == active
        dots.append(
            d.add_dot(
                slide, st, px, py, d=dd * (1.3 if on else 1), color="highlight" if on else "accent"
            )
        )
        right = it["x"] <= 0.75
        x = px + dd if right else px - dd - tw
        run = Run(it["label"], size="caption" if not on else "label", bold=on)
        tags.append(
            d.add_text(
                slide, st, x, py - lab_h / 2, tw, lab_h, run, "left" if right else "right", "middle"
            )
        )
    return {"axes": axes, "labels": labels, "quadrants": quads, "dots": dots, "tags": tags}


def _num(v: float) -> str:
    return f"{v:,.0f}".replace(",", " ") if float(v).is_integer() else f"{v:,.1f}"


def funnel(slide, st: Style, params: dict, l, t, w, h) -> dict[str, list]:
    """Centred bars whose widths encode `values` (else a linear taper); value and sublabel on a
    column to the right. Bars sit on a wash; the active stage gets the highlight stroke and
    numeral."""
    stages = [d.item(s) for s in params["stages"]]
    values, active, n = params.get("values"), params.get("active"), len(stages)
    has_side = bool(values) or any(s[1] for s in stages)
    side = min(0.28 * w, 2.6) if has_side else 0.0
    fw = w - side - (0.2 if side else 0)
    gap = min(0.12, h * 0.03)
    bh = min((h - gap * (n - 1)) / n, 1.0)
    top = t + (h - (n * bh + (n - 1) * gap)) / 2
    vmax = max(values) if values else None
    fill = wash(st)
    bars, texts = [], []
    for i, (label, sub, _) in enumerate(stages):
        frac = values[i] / vmax if vmax else 1.0 - 0.6 * i / max(n - 1, 1)
        bw = max(fw * frac, 0.22 * fw)
        y = top + i * (bh + gap)
        on = i == active
        bars.append(
            d.add_box(
                slide,
                st,
                l + (fw - bw) / 2,
                y,
                bw,
                bh,
                fill=fill,
                line="highlight" if on else ("rule" if fill == "surface" else None),
                line_w="emphasis" if on else "hairline",
                text=Run(label, size="label", bold=True),
            )
        )
        if has_side:
            runs = []
            if values:
                runs.append(
                    Run(
                        _num(values[i]),
                        size="body",
                        bold=True,
                        color="highlight" if on else "accent",
                    )
                )
            if sub:
                runs.append(Run(sub, size="caption", color="muted"))
            texts.append(d.add_text(slide, st, l + w - side, y, side, bh, runs, anchor="middle"))
    return {"bars": bars, "texts": texts}


def cycle(slide, st: Style, params: dict, l, t, w, h) -> dict[str, list]:
    """Recurring loop: 3-6 boxes on an ellipse, muted arrows running clockwise."""
    steps = [d.item(s) for s in params["steps"]]
    active, n = params.get("active"), len(steps)
    bw, bh = min(0.22 * w, 2.6), min(0.18 * h, 0.85)
    rx, ry = w / 2 - bw / 2, h / 2 - bh / 2
    rx = min(rx, 1.9 * ry * (w / h) / 1.6)
    cx, cy = l + w / 2, t + h / 2
    angles = [math.radians(-90 + 360 * i / n) for i in range(n)]
    centres = [(cx + rx * math.cos(a), cy + ry * math.sin(a)) for a in angles]
    boxes = [
        node(slide, st, x - bw / 2, y - bh / 2, bw, bh, box_text(lab, sub), i == active)
        for i, ((x, y), (lab, sub, _)) in enumerate(zip(centres, steps, strict=True))
    ]
    arrows = [
        _link(slide, st, centres[i], centres[(i + 1) % n], (bw, bh), (bw, bh), pad=0.08)
        for i in range(n)
    ]
    return {"boxes": boxes, "arrows": [a for a in arrows if a is not None]}


def before_after(slide, st: Style, params: dict, l, t, w, h) -> dict[str, Any]:
    """Two panels and one arrow; the after panel carries the emphasis wash."""
    mid = max(0.9, 0.12 * w)
    pw = (w - mid) / 2
    head_h = st.size("label") / 72 * 2.2
    n_lines = max(len(params["before"]["lines"]), len(params["after"]["lines"]), 1)
    # panels sized to their copy (with air), never a tall empty frame; the pair sits centred
    ph = min(h - head_h, max(0.5 * h, n_lines * st.size("body") / 72 * 1.9 + 0.8))
    t, h = t + (h - head_h - ph) / 2, ph + head_h
    panels, heads = [], []
    for i, (panel, x) in enumerate(((params["before"], l), (params["after"], l + w - pw))):
        heads.append(d.add_text(slide, st, x, t, pw, head_h, tag(panel["title"], size="label")))
        lines = [Run(ln, size="body", bullet="•", space_before=4) for ln in panel["lines"]]
        panels.append(
            d.add_box(
                slide,
                st,
                x,
                t + head_h,
                pw,
                h - head_h,
                fill=wash(st) if i else "surface",
                text=lines or None,
                align="left",
                anchor="top",
                pad=min(0.25, 0.04 * pw + 0.05),
            )
        )
    ym = t + head_h + (h - head_h) / 2
    arrow = d.add_arrow(slide, st, l + pw + 0.15, ym, l + w - pw - 0.15, ym, weight="emphasis")
    label = None
    if params.get("arrow_label"):
        label = d.add_text(
            slide,
            st,
            l + pw,
            ym - head_h - 0.04,
            mid,
            head_h,
            tag(params["arrow_label"]),
            "center",
            "bottom",
        )
    return {"panels": panels, "headers": heads, "arrow": arrow, "label": label}


DIAGRAMS = {
    "flow": flow,
    "swimlane": swimlane,
    "layers": layers,
    "hub": hub,
    "matrix2x2": matrix2x2,
    "funnel": funnel,
    "cycle": cycle,
    "before_after": before_after,
}


def _register(key: str, fn) -> None:
    @renderer(f"diagram:{key}")
    def _render(slide, st: Style, s) -> None:
        g = st.grid
        # a little air under the title, the frame never reaches the footer line
        fn(slide, st, s.source["params"], g.margin, g.y(0.04), g.bw, g.bh * 0.92)


for _k, _fn in DIAGRAMS.items():
    _register(_k, _fn)
