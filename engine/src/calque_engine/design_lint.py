"""Design lint: what the measured layout and the pack say about a rendered artboard.

ERROR  text overflowing its box or the canvas, more lines than max_lines, text under the
       format's minimum size, contrast under WCAG AA for large text (3:1), slop vocabulary.
WARN   contrast under AA for body text (4.5:1), text in the format's safe margin, a size that
       overrides the type scale, a single-use colour (e.g. highlight) used more than once,
       language typography.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from .core import typography_rules
from .design import Format, walk
from .design_render import Theme, text_px
from .lint import _for_language, _hits, _rules
from .pack import Pack


@dataclass(frozen=True)
class DesignFinding:
    severity: Literal["ERROR", "WARN"]
    artboard: str
    node: str | None
    check: str
    message: str


def _lum(hex_: str) -> float:
    def ch(i: int) -> float:
        c = int(hex_[i : i + 2], 16) / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5)


def contrast(a: str, b: str) -> float:
    la, lb = sorted((_lum(a), _lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def _role(p: Any) -> str:
    return p["color"] if isinstance(p, dict) else p


def lint_artboard(
    pack: Pack,
    language: str,
    board: dict[str, Any],
    nodes: list[dict[str, Any]],
    boxes: dict[str, Any],
    th: Theme,
    fmt: Format,
) -> list[DesignFinding]:
    out: list[DesignFinding] = []
    bid = board["id"]
    add = lambda sev, nid, check, msg: out.append(DesignFinding(sev, bid, nid, check, msg))  # noqa: E731
    slop = _rules(pack, language)
    typo = _for_language(typography_rules(), language)
    single = {
        p.removeprefix("role.color.")
        for p in pack.manifest["lint"].get("single_use_colors", [])
        if p.startswith("role.color.")
    }
    uses: dict[str, list[str]] = {}
    sx, sy = fmt.safe_xy

    # the background behind each node: its nearest ancestor with an opaque fill, else the board's
    bg: dict[str, str] = {}

    def backgrounds(ns: list[dict[str, Any]], behind: str) -> None:
        for n in ns:
            own = n.get("fill")
            here = (
                _role(own) if own and n["type"] == "frame" and not isinstance(own, dict) else behind
            )
            bg[n["id"]] = behind
            backgrounds(n.get("children", []), here)

    backgrounds(nodes, _role(board.get("fill", "background")))

    for n, _ in walk(nodes):
        nid, b = n["id"], boxes.get(n["id"])
        for key in ("fill", "color"):
            if n.get(key):
                uses.setdefault(_role(n[key]), []).append(nid)
        if n.get("stroke"):
            uses.setdefault(n["stroke"]["color"], []).append(nid)
        if n["type"] == "frame" and b is not None:
            fixed = [k for k, o in (("width", "overflow_x"), ("height", "overflow_y")) if b.get(o)]
            if any(isinstance(n.get(k), (int, float)) for k in fixed):
                add("ERROR", nid, "overflow", "content overflows the frame: it is cut or spills")
        if n["type"] != "text" or b is None:
            continue
        size = text_px(n, th, fmt)
        if size < fmt.min_text:
            add(
                "ERROR",
                nid,
                "min_text",
                f"{size:g}px text: under {fmt.min_text:g}px on {fmt.label}",
            )
        if n.get("size"):
            add("WARN", nid, "type_scale", f"size {n['size']:g}px overrides the {n['style']} style")
        # an auto-height text box always fits its lines (descenders may poke out): only a fixed
        # height can be too small, and any width when a word is longer than the box
        fixed_h = isinstance(n.get("height"), (int, float))
        if b.get("overflow_x") or (fixed_h and b.get("overflow_y")):
            add("ERROR", nid, "overflow", "text overflows its box: shorten it or give it more room")
        if n.get("max_lines") and b.get("line_count", 0) > n["max_lines"]:
            add(
                "ERROR",
                nid,
                "max_lines",
                f"{b['line_count']} lines, max_lines is {n['max_lines']}: shorten it",
            )
        if (
            b["x"] < -0.5
            or b["y"] < -0.5
            or b["x"] + b["w"] > fmt.width + 0.5
            or b["y"] + b["h"] > fmt.height + 0.5
        ):
            add("ERROR", nid, "off_canvas", "text runs off the canvas")
        elif (
            b["x"] < sx - 0.5
            or b["y"] < sy - 0.5
            or b["x"] + b["w"] > fmt.width - sx + 0.5
            or b["y"] + b["h"] > fmt.height - sy + 0.5
        ):
            add(
                "WARN", nid, "safe_area", f"text inside the safe margin of {fmt.label} ({fmt.safe})"
            )
        fg_role, back = _role(n.get("color", "ink")), bg[nid]
        ratio = contrast(th.color(fg_role), th.color(back))
        large = size >= 24 or (n.get("bold") and size >= 18.66)
        if ratio < 3 or (ratio < 4.5 and not large):
            sev = "ERROR" if ratio < 3 else "WARN"
            add(
                sev,
                nid,
                "contrast",
                f"{fg_role} on {back}: {ratio:.1f}:1, AA needs {3 if large else 4.5}:1",
            )
        for check, rules in (("slop", slop), ("typography", typo)):
            for r in rules:
                hits = _hits(r, n["text"])
                if hits:
                    sev = "ERROR" if r.severity == "ERROR" and check == "slop" else "WARN"
                    add(sev, nid, check, f"{', '.join(hits)}: {r.note}")
    for role in single:
        if len(uses.get(role, [])) > 1:
            add(
                "WARN",
                None,
                "single_use",
                f"{role} is used {len(uses[role])} times: {', '.join(uses[role])}",
            )
    return out
